//! A library document's original file (see `document_files` in
//! `src/db/schema.ts`): the PDF exactly as it was added, one per document.
//!
//! Through Rust for the same reason photos are: the SQL plugin's JS API can
//! only pass JSON values, which would turn the bytes into an array of numbers.
//! Removed with its document by the foreign key's `ON DELETE CASCADE`.

use sqlx::SqlitePool;

/// Stores (or replaces) the original file of document `document_id`.
pub async fn save(
    pool: &SqlitePool,
    document_id: i64,
    filename: &str,
    media_type: &str,
    bytes: &[u8],
) -> Result<(), String> {
    sqlx::query(
        "INSERT OR REPLACE INTO document_files (document_id, filename, media_type, data) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(document_id)
    .bind(filename)
    .bind(media_type)
    .bind(bytes)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The stored bytes of document `document_id`'s original; an error when it
/// has none.
pub async fn read(pool: &SqlitePool, document_id: i64) -> Result<Vec<u8>, String> {
    let data: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT data FROM document_files WHERE document_id = ?")
            .bind(document_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    data.ok_or_else(|| format!("document {document_id} has no original file"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::photos::tests::{migrated_db, Scratch};

    async fn add_document(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO documents (created_at, title) VALUES ('2026-11-13T08:00:00Z', 'DEXA') \
             RETURNING id",
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    fn fake_pdf(len: usize) -> Vec<u8> {
        let mut v = b"%PDF-1.7\n".to_vec();
        // Includes NULs and 0xFF, which a text round-trip would mangle.
        v.extend((0..len).map(|i| (i as u8).wrapping_mul(31)));
        v
    }

    #[tokio::test]
    async fn round_trips_byte_for_byte() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        let id = add_document(&pool).await;
        let pdf = fake_pdf(3_000_000);

        save(&pool, id, "dexa.pdf", "application/pdf", &pdf).await.unwrap();

        assert_eq!(read(&pool, id).await.unwrap(), pdf);
        let (name, media): (String, String) = sqlx::query_as(
            "SELECT filename, media_type FROM document_files WHERE document_id = ?",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!((name.as_str(), media.as_str()), ("dexa.pdf", "application/pdf"));
    }

    #[tokio::test]
    async fn is_removed_with_its_document() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;
        let id = add_document(&pool).await;
        save(&pool, id, "dexa.pdf", "application/pdf", &fake_pdf(100)).await.unwrap();

        sqlx::query("DELETE FROM documents WHERE id = ?").bind(id).execute(&pool).await.unwrap();

        assert!(read(&pool, id).await.is_err());
    }

    #[tokio::test]
    async fn needs_an_existing_document() {
        let scratch = Scratch::new();
        let pool = migrated_db(&scratch).await;

        assert!(save(&pool, 999, "x.pdf", "application/pdf", &fake_pdf(10)).await.is_err());
    }
}
