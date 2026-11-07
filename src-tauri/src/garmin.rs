//! Tauri commands around the `garmin-connect` client.
//!
//! The Garmin session (OAuth tokens) lives in a file in the app data dir and
//! never crosses into JavaScript; the password is used for the sign-in call
//! and dropped. The frontend only gets `garmin_get` — an authenticated GET
//! against connectapi.garmin.com that hands back raw JSON, which the sync in
//! `src/lib/garmin.ts` validates through zod like any other external API.

use garmin_connect::{Api, GarminError, Login, PendingMfa, Session};
use serde::Serialize;
use serde_json::Value;
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct GarminState {
    api: Api,
    /// `None` = not loaded from disk yet; `Some(None)` = signed out.
    session: Mutex<Option<Option<Session>>>,
    pending: Mutex<Option<PendingMfa>>,
}

impl GarminState {
    pub fn new() -> Self {
        Self {
            api: Api::new().expect("http client"),
            session: Mutex::new(None),
            pending: Mutex::new(None),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CmdError {
    code: String,
    message: String,
}

impl From<GarminError> for CmdError {
    fn from(e: GarminError) -> Self {
        CmdError { code: e.code().into(), message: e.to_string() }
    }
}

fn local(code: &str, message: impl Into<String>) -> CmdError {
    CmdError { code: code.into(), message: message.into() }
}

type CmdResult<T> = Result<T, CmdError>;

fn session_path(app: &AppHandle) -> CmdResult<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| local("storage", e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| local("storage", e.to_string()))?;
    Ok(dir.join("garmin_session.json"))
}

fn load(app: &AppHandle) -> Option<Session> {
    let path = session_path(app).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save(app: &AppHandle, s: Option<&Session>) -> CmdResult<()> {
    let path = session_path(app)?;
    match s {
        Some(s) => {
            let text = serde_json::to_string(s).map_err(|e| local("storage", e.to_string()))?;
            std::fs::write(path, text).map_err(|e| local("storage", e.to_string()))
        }
        None => {
            if path.exists() {
                std::fs::remove_file(path).map_err(|e| local("storage", e.to_string()))?;
            }
            Ok(())
        }
    }
}

#[derive(Serialize)]
pub struct Status {
    connected: bool,
    #[serde(rename = "mfaPending")]
    mfa_pending: bool,
}

#[tauri::command]
pub async fn garmin_status(app: AppHandle, state: State<'_, GarminState>) -> CmdResult<Status> {
    let mut guard = state.session.lock().await;
    let session = guard.get_or_insert_with(|| load(&app));
    Ok(Status {
        connected: session.is_some(),
        mfa_pending: state.pending.lock().await.is_some(),
    })
}

#[derive(Serialize)]
pub struct LoginResult {
    /// "connected" | "mfa"
    status: &'static str,
}

#[tauri::command]
pub async fn garmin_login(
    app: AppHandle,
    state: State<'_, GarminState>,
    email: String,
    password: String,
) -> CmdResult<LoginResult> {
    *state.pending.lock().await = None;
    match garmin_connect::login(email.trim(), &password).await? {
        Login::Done(session) => {
            save(&app, Some(&session))?;
            *state.session.lock().await = Some(Some(session));
            Ok(LoginResult { status: "connected" })
        }
        Login::NeedsMfa(pending) => {
            *state.pending.lock().await = Some(pending);
            Ok(LoginResult { status: "mfa" })
        }
    }
}

#[tauri::command]
pub async fn garmin_mfa(
    app: AppHandle,
    state: State<'_, GarminState>,
    code: String,
) -> CmdResult<LoginResult> {
    let pending = state
        .pending
        .lock()
        .await
        .take()
        .ok_or_else(|| local("mfa_expired", "The sign-in timed out — start again"))?;
    let session = garmin_connect::resume_mfa(pending, &code).await?;
    save(&app, Some(&session))?;
    *state.session.lock().await = Some(Some(session));
    Ok(LoginResult { status: "connected" })
}

/// Forget the session locally. (Garmin has no logout endpoint for this flow;
/// the OAuth1 token simply lapses after about a year.)
#[tauri::command]
pub async fn garmin_logout(app: AppHandle, state: State<'_, GarminState>) -> CmdResult<()> {
    *state.pending.lock().await = None;
    save(&app, None)?;
    *state.session.lock().await = Some(None);
    Ok(())
}

/// Authenticated GET against connectapi.garmin.com. Requests are serialised
/// by the session lock, which is what we want: one at a time, never a burst.
#[tauri::command]
pub async fn garmin_get(
    app: AppHandle,
    state: State<'_, GarminState>,
    path: String,
    query: Option<Vec<(String, String)>>,
) -> CmdResult<Value> {
    let mut guard = state.session.lock().await;
    let slot = guard.get_or_insert_with(|| load(&app));
    let Some(session) = slot.as_mut() else {
        return Err(local("not_connected", "Garmin isn't connected"));
    };
    match state.api.get(session, &path, &query.unwrap_or_default()).await {
        Ok((value, refreshed)) => {
            if refreshed {
                save(&app, Some(session))?;
            }
            Ok(value)
        }
        Err(GarminError::AuthExpired) => {
            // The OAuth1 token is gone; only a new sign-in helps.
            save(&app, None)?;
            *slot = None;
            Err(GarminError::AuthExpired.into())
        }
        Err(e) => Err(e.into()),
    }
}
