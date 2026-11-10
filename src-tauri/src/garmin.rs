//! Tauri commands around the `garmin-connect` client.
//!
//! Two ways in, each kept in its own file in the app data dir and never
//! handed to JavaScript:
//! - the official Personal API key (`garmin_personal.json`) — the main one;
//! - the unofficial sign-in session (`garmin_session.json`) — optional, only
//!   for what the Personal API doesn't serve (training readiness and status).
//!
//! The frontend gets `garmin_get` — an authenticated GET that hands back raw
//! JSON, which `src/lib/garmin.ts` validates through zod like any other
//! external API — and `garmin_activity_laps`, the laps out of an activity's
//! FIT file.

use garmin_connect::{fit::Lap, Api, Auth, GarminError, Login, PendingMfa, Personal, Session};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Manager, State};

const SESSION_FILE: &str = "garmin_session.json";
const PERSONAL_FILE: &str = "garmin_personal.json";

pub struct GarminState {
    api: Api,
    /// `None` = not loaded from disk yet; `Some(None)` = none saved.
    session: Mutex<Option<Option<Session>>>,
    personal: Mutex<Option<Option<Personal>>>,
    pending: Mutex<Option<PendingMfa>>,
}

impl GarminState {
    pub fn new() -> Self {
        Self {
            api: Api::new().expect("http client"),
            session: Mutex::new(None),
            personal: Mutex::new(None),
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

fn data_path(app: &AppHandle, file: &str) -> CmdResult<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| local("storage", e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| local("storage", e.to_string()))?;
    Ok(dir.join(file))
}

fn load<T: DeserializeOwned>(app: &AppHandle, file: &str) -> Option<T> {
    let text = std::fs::read_to_string(data_path(app, file).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn save<T: Serialize>(app: &AppHandle, file: &str, value: Option<&T>) -> CmdResult<()> {
    let path = data_path(app, file)?;
    match value {
        Some(v) => {
            let text = serde_json::to_string(v).map_err(|e| local("storage", e.to_string()))?;
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
    /// The official Personal API key is set.
    personal: bool,
    /// The unofficial sign-in is active.
    connected: bool,
    #[serde(rename = "mfaPending")]
    mfa_pending: bool,
}

#[tauri::command]
pub async fn garmin_status(app: AppHandle, state: State<'_, GarminState>) -> CmdResult<Status> {
    let personal = state
        .personal
        .lock()
        .await
        .get_or_insert_with(|| load(&app, PERSONAL_FILE))
        .is_some();
    let connected = state
        .session
        .lock()
        .await
        .get_or_insert_with(|| load(&app, SESSION_FILE))
        .is_some();
    Ok(Status {
        personal,
        connected,
        mfa_pending: state.pending.lock().await.is_some(),
    })
}

/// Store a Personal API key — only once Garmin has accepted it.
#[tauri::command]
pub async fn garmin_set_key(
    app: AppHandle,
    state: State<'_, GarminState>,
    key: String,
) -> CmdResult<()> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err(local("invalid_key", "Paste the key from Garmin Connect"));
    }
    let token = state.api.personal_token(&key).await?;
    let personal = Personal { api_key: key, token: Some(token) };
    save(&app, PERSONAL_FILE, Some(&personal))?;
    *state.personal.lock().await = Some(Some(personal));
    Ok(())
}

#[tauri::command]
pub async fn garmin_clear_key(app: AppHandle, state: State<'_, GarminState>) -> CmdResult<()> {
    save::<Personal>(&app, PERSONAL_FILE, None)?;
    *state.personal.lock().await = Some(None);
    Ok(())
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
            save(&app, SESSION_FILE, Some(&session))?;
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
        .ok_or_else(|| local("mfa_expired", "The sign-in timed out. Start again"))?;
    let session = garmin_connect::resume_mfa(pending, &code).await?;
    save(&app, SESSION_FILE, Some(&session))?;
    *state.session.lock().await = Some(Some(session));
    Ok(LoginResult { status: "connected" })
}

/// Forget the unofficial sign-in. (Garmin has no logout for this flow; the
/// OAuth1 token simply lapses after about a year.)
#[tauri::command]
pub async fn garmin_logout(app: AppHandle, state: State<'_, GarminState>) -> CmdResult<()> {
    *state.pending.lock().await = None;
    save::<Session>(&app, SESSION_FILE, None)?;
    *state.session.lock().await = Some(None);
    Ok(())
}

/// What a command asks Garmin for.
enum Request {
    Get { path: String, query: Vec<(String, String)> },
    Laps { activity_id: String },
}

enum Reply {
    Json(Value),
    Laps(Vec<Lap>),
}

async fn perform(api: &Api, auth: &mut Auth<'_>, req: &Request) -> garmin_connect::Result<(Reply, bool)> {
    match req {
        Request::Get { path, query } => {
            let (v, refreshed) = api.get(auth, path, query).await?;
            Ok((Reply::Json(v), refreshed))
        }
        Request::Laps { activity_id } => {
            let (laps, refreshed) = api.activity_laps(auth, activity_id).await?;
            Ok((Reply::Laps(laps), refreshed))
        }
    }
}

/// Run `req` with the chosen auth: "personal", "legacy", or (None) the
/// Personal API when a key is set, else the sign-in. Saves a refreshed token,
/// and forgets a sign-in that has expired for good. Requests are serialised by
/// the locks, which is what we want: one at a time, never a burst.
async fn with_auth(
    app: &AppHandle,
    state: &GarminState,
    source: Option<&str>,
    req: Request,
) -> CmdResult<Reply> {
    let mut personal_guard = state.personal.lock().await;
    let personal_slot = personal_guard.get_or_insert_with(|| load(app, PERSONAL_FILE));
    let use_personal = match source {
        Some("personal") => true,
        Some("legacy") => false,
        _ => personal_slot.is_some(),
    };

    if use_personal {
        let Some(personal) = personal_slot.as_mut() else {
            return Err(local("not_connected", "No Garmin personal API key is set"));
        };
        let (reply, refreshed) = perform(&state.api, &mut Auth::Personal(personal), &req).await?;
        if refreshed {
            save(app, PERSONAL_FILE, personal_slot.as_ref())?;
        }
        return Ok(reply);
    }
    drop(personal_guard);

    let mut session_guard = state.session.lock().await;
    let session_slot = session_guard.get_or_insert_with(|| load(app, SESSION_FILE));
    let Some(session) = session_slot.as_mut() else {
        return Err(local("not_connected", "Garmin isn't connected"));
    };
    match perform(&state.api, &mut Auth::Legacy(session), &req).await {
        Ok((reply, refreshed)) => {
            if refreshed {
                save(app, SESSION_FILE, session_slot.as_ref())?;
            }
            Ok(reply)
        }
        Err(GarminError::AuthExpired) => {
            // The OAuth1 token is gone; only a new sign-in helps.
            save::<Session>(app, SESSION_FILE, None)?;
            *session_slot = None;
            Err(GarminError::AuthExpired.into())
        }
        Err(e) => Err(e.into()),
    }
}

/// Authenticated GET → raw JSON.
#[tauri::command]
pub async fn garmin_get(
    app: AppHandle,
    state: State<'_, GarminState>,
    path: String,
    query: Option<Vec<(String, String)>>,
    source: Option<String>,
) -> CmdResult<Value> {
    let req = Request::Get { path, query: query.unwrap_or_default() };
    match with_auth(&app, &state, source.as_deref(), req).await? {
        Reply::Json(v) => Ok(v),
        Reply::Laps(_) => Err(local("unexpected", "wrong reply")),
    }
}

/// The laps of an activity, from its FIT file.
#[tauri::command]
pub async fn garmin_activity_laps(
    app: AppHandle,
    state: State<'_, GarminState>,
    activity_id: String,
) -> CmdResult<Vec<Lap>> {
    match with_auth(&app, &state, None, Request::Laps { activity_id }).await? {
        Reply::Laps(l) => Ok(l),
        Reply::Json(_) => Err(local("unexpected", "wrong reply")),
    }
}
