//! Photo storage: every image lives in the `photos` table of the app database
//! (see `src/db/schema.ts`), keyed by the filename that `photo_path` /
//! `page_paths` columns hold.
//!
//! These functions take a pool and a directory rather than an `AppHandle` so
//! they can be tested against a scratch database; the Tauri commands in
//! `lib.rs` are thin wrappers around them.

use sqlx::SqlitePool;
use std::path::Path;

/// Stores JPEG bytes and returns the filename they're keyed by: a millisecond
/// timestamp. Pages of one PDF can arrive within the same millisecond, so it
/// steps forward until a name is free.
pub async fn save(pool: &SqlitePool, bytes: &[u8], now_millis: u128) -> Result<String, String> {
    let mut millis = now_millis;
    loop {
        let name = format!("{millis}.jpg");
        let inserted = sqlx::query("INSERT OR IGNORE INTO photos (filename, data) VALUES (?, ?)")
            .bind(&name)
            .bind(bytes)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?
            .rows_affected();
        if inserted == 1 {
            return Ok(name);
        }
        millis += 1;
    }
}

/// The stored bytes of a photo; an error when there's no such photo.
pub async fn read(pool: &SqlitePool, filename: &str) -> Result<Vec<u8>, String> {
    let data: Option<Vec<u8>> = sqlx::query_scalar("SELECT data FROM photos WHERE filename = ?")
        .bind(filename)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    data.ok_or_else(|| format!("photo not found: {filename}"))
}

/// Deletes a photo. Deleting one that isn't there is not an error.
pub async fn delete(pool: &SqlitePool, filename: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM photos WHERE filename = ?")
        .bind(filename)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// One-time move of photos saved as loose files in `dir` (before they lived
/// in the database) into the `photos` table; returns how many were moved.
///
/// Each file is removed only once its row is in, so a run cut short picks up
/// where it left off next time. A file whose name already has a row (a
/// previous run inserted it but died before the remove) is removed only if
/// the stored bytes match; otherwise it's left alone and reported, since
/// deleting it would lose data. Once `dir` is gone this is a single failed
/// `read_dir`.
pub async fn import_files(pool: &SqlitePool, dir: &Path) -> Result<u32, String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(0);
    };
    let mut imported = 0;
    let mut conflicts = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        sqlx::query("INSERT OR IGNORE INTO photos (filename, data) VALUES (?, ?)")
            .bind(&name)
            .bind(&bytes)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        // Whether it was just inserted or already there, only drop the file
        // once the database holds exactly these bytes under its name.
        if read(pool, &name).await? != bytes {
            conflicts.push(name);
            continue;
        }
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        imported += 1;
    }
    // Only succeeds when empty, which is the point.
    let _ = std::fs::remove_dir(dir);
    if conflicts.is_empty() {
        Ok(imported)
    } else {
        Err(format!(
            "kept {} file(s) whose name is already stored with different bytes: {}",
            conflicts.len(),
            conflicts.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_core::future::BoxFuture;
    use sqlx::error::BoxDynError;
    use sqlx::migrate::{Migration as SqlxMigration, MigrationSource, Migrator};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// The app's own migration list, fed to sqlx the way tauri-plugin-sql
    /// feeds it (each one in a transaction, checksums recorded).
    #[derive(Debug)]
    struct AppMigrations;

    impl MigrationSource<'static> for AppMigrations {
        fn resolve(self) -> BoxFuture<'static, Result<Vec<SqlxMigration>, BoxDynError>> {
            Box::pin(async move {
                Ok(crate::migrations()
                    .into_iter()
                    .map(|m| {
                        SqlxMigration::new(m.version, m.description.into(), m.kind.into(), m.sql.into(), false)
                    })
                    .collect())
            })
        }
    }

    /// A fresh scratch directory per test, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "tally-photos-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A file-backed database with every app migration applied.
    async fn migrated_db(scratch: &Scratch) -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(scratch.0.join("tally.db"))
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().connect_with(options).await.unwrap();
        Migrator::new(AppMigrations).await.unwrap().run(&pool).await.unwrap();
        pool
    }

    /// Distinct, non-trivial bytes per seed (includes NULs and 0xFF, which a
    /// text round-trip would mangle).
    fn fake_jpeg(seed: u8, len: usize) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, seed];
        v.extend((0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)));
        v.extend([0xFF, 0xD9]);
        v
    }

    #[tokio::test]
    async fn all_migrations_apply_and_create_the_photos_table() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;

        let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(applied, crate::migrations().len() as i64);

        let cols: Vec<(String, String, i64, i64)> =
            sqlx::query_as("SELECT name, type, \"notnull\", pk FROM pragma_table_info('photos') ORDER BY cid")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            cols,
            vec![
                ("filename".into(), "TEXT".into(), 1, 1),
                ("data".into(), "BLOB".into(), 1, 0),
            ]
        );
    }

    #[tokio::test]
    async fn migration_keeps_existing_rows_when_upgrading() {
        // A device on the previous version: everything up to 0024 applied,
        // with a meal that references a photo file.
        let scratch = Scratch::new();
        let options = SqliteConnectOptions::new()
            .filename(scratch.0.join("tally.db"))
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().connect_with(options).await.unwrap();
        let mut migrator = Migrator::new(AppMigrations).await.unwrap();
        let all = migrator.migrations.to_vec();
        migrator.migrations = all[..all.len() - 1].to_vec().into();
        migrator.run(&pool).await.unwrap();
        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'photos'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(before, 0);
        sqlx::query("INSERT INTO settings (key, value) VALUES ('k', 'v')")
            .execute(&pool)
            .await
            .unwrap();

        // Then the update lands.
        Migrator::new(AppMigrations).await.unwrap().run(&pool).await.unwrap();

        let kept: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'k'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(kept, "v");
        save(&pool, b"after upgrade", 1).await.unwrap();
    }

    #[tokio::test]
    async fn import_moves_files_into_the_table_byte_for_byte() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        let dir = scratch.0.join("photos");
        std::fs::create_dir_all(&dir).unwrap();
        let files = [
            ("1700000000000.jpg", fake_jpeg(1, 50_000)),
            ("1700000000001.jpg", fake_jpeg(2, 120_000)),
            ("1700000005000.jpg", fake_jpeg(3, 10)),
        ];
        for (name, bytes) in &files {
            std::fs::write(dir.join(name), bytes).unwrap();
        }

        assert_eq!(import_files(&pool, &dir).await.unwrap(), 3);

        for (name, bytes) in &files {
            assert_eq!(&read(&pool, name).await.unwrap(), bytes, "{name}");
        }
        assert!(!dir.exists(), "emptied folder should be removed");
        // Running again (every later start) is a no-op.
        assert_eq!(import_files(&pool, &dir).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn import_resumes_after_being_cut_short() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        let dir = scratch.0.join("photos");
        std::fs::create_dir_all(&dir).unwrap();
        let a = fake_jpeg(10, 1000);
        let b = fake_jpeg(11, 2000);
        std::fs::write(dir.join("a.jpg"), &a).unwrap();
        std::fs::write(dir.join("b.jpg"), &b).unwrap();
        // Previous run: inserted a.jpg, then died before removing the file.
        sqlx::query("INSERT INTO photos (filename, data) VALUES ('a.jpg', ?)")
            .bind(&a)
            .execute(&pool)
            .await
            .unwrap();

        assert_eq!(import_files(&pool, &dir).await.unwrap(), 2);

        assert_eq!(read(&pool, "a.jpg").await.unwrap(), a);
        assert_eq!(read(&pool, "b.jpg").await.unwrap(), b);
        assert!(!dir.exists());
    }

    #[tokio::test]
    async fn import_never_deletes_a_file_the_database_holds_differently() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        let dir = scratch.0.join("photos");
        std::fs::create_dir_all(&dir).unwrap();
        let on_disk = fake_jpeg(20, 500);
        let in_db = fake_jpeg(21, 500);
        std::fs::write(dir.join("x.jpg"), &on_disk).unwrap();
        std::fs::write(dir.join("y.jpg"), fake_jpeg(22, 10)).unwrap();
        sqlx::query("INSERT INTO photos (filename, data) VALUES ('x.jpg', ?)")
            .bind(&in_db)
            .execute(&pool)
            .await
            .unwrap();

        let err = import_files(&pool, &dir).await.unwrap_err();
        assert!(err.contains("x.jpg"), "{err}");

        assert_eq!(std::fs::read(dir.join("x.jpg")).unwrap(), on_disk);
        assert_eq!(read(&pool, "x.jpg").await.unwrap(), in_db);
        // The rest still moved.
        assert!(!dir.join("y.jpg").exists());
        assert_eq!(read(&pool, "y.jpg").await.unwrap(), fake_jpeg(22, 10));
    }

    #[tokio::test]
    async fn import_without_a_folder_is_a_no_op() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        assert_eq!(import_files(&pool, &scratch.0.join("photos")).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn import_skips_subdirectories_and_keeps_the_folder() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        let dir = scratch.0.join("photos");
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("p.jpg"), fake_jpeg(30, 10)).unwrap();

        assert_eq!(import_files(&pool, &dir).await.unwrap(), 1);
        assert!(dir.join("nested").is_dir());
    }

    #[tokio::test]
    async fn save_read_delete_round_trip() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        let bytes = fake_jpeg(40, 300_000);

        let name = save(&pool, &bytes, 1_730_987_654_321).await.unwrap();
        assert_eq!(name, "1730987654321.jpg");
        assert_eq!(read(&pool, &name).await.unwrap(), bytes);

        delete(&pool, &name).await.unwrap();
        assert!(read(&pool, &name).await.is_err());
        // Deleting again is fine.
        delete(&pool, &name).await.unwrap();
    }

    #[tokio::test]
    async fn saves_in_the_same_millisecond_get_distinct_names() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        let pages: Vec<Vec<u8>> = (0..4).map(|i| fake_jpeg(50 + i, 100)).collect();

        let mut names = Vec::new();
        for page in &pages {
            names.push(save(&pool, page, 5_000).await.unwrap());
        }

        assert_eq!(names, ["5000.jpg", "5001.jpg", "5002.jpg", "5003.jpg"]);
        for (name, page) in names.iter().zip(&pages) {
            assert_eq!(&read(&pool, name).await.unwrap(), page);
        }
    }

    #[tokio::test]
    async fn photos_survive_vacuum_into_export() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        let bytes = fake_jpeg(60, 4000);
        let name = save(&pool, &bytes, 7).await.unwrap();

        let export = scratch.0.join("export.db");
        sqlx::query(&format!("VACUUM INTO '{}'", export.display()))
            .execute(&pool)
            .await
            .unwrap();
        let exported = SqlitePoolOptions::new()
            .connect_with(SqliteConnectOptions::new().filename(&export))
            .await
            .unwrap();

        assert_eq!(read(&exported, &name).await.unwrap(), bytes);
    }
}
