//! A minimal Garmin Connect client.
//!
//! The preferred way in is the official Personal API: a key the user creates
//! on Garmin Connect Web, exchanged for 24-hour bearer tokens ([`Personal`]).
//! The unofficial sign-in below stays as an optional extra for the few things
//! the Personal API doesn't serve (training readiness and training status).
//!
//! The unofficial path signs in the way Garmin's own mobile app does (the flow the community
//! `garth` library documented): the SSO web form hands out a one-time ticket,
//! the ticket buys a long-lived OAuth1 token (about a year), and the OAuth1
//! token is exchanged for short-lived OAuth2 bearer tokens as often as needed.
//! The password is only used for the first step and never kept; what's worth
//! persisting is the [`Session`].
//!
//! That part is not an official API. Garmin changes the login flow from time to
//! time and this will break when it does — every URL, header and pattern that
//! is likely to need patching lives in the constants below.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use hmac::{Hmac, Mac};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::Sha1;

const SSO: &str = "https://sso.garmin.com/sso";
const SSO_EMBED: &str = "https://sso.garmin.com/sso/embed";
const API: &str = "https://connectapi.garmin.com";
/// The official Personal API (same paths as connectapi, its own host).
const PERSONAL_API: &str = "https://personal.connectapi.garmin.com";
const PERSONAL_TOKEN: &str =
    "https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token";
const PREAUTHORIZED: &str = "https://connectapi.garmin.com/oauth-service/oauth/preauthorized";
const EXCHANGE: &str = "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0";
/// Where garth publishes the mobile app's OAuth consumer pair, so a rotated
/// key heals without an app update. The fallback below is used if it's down.
const CONSUMER_URL: &str = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";
const FALLBACK_CONSUMER_KEY: &str = "fc3e99d2-118c-44b8-8ae3-03370dde24c0";
const FALLBACK_CONSUMER_SECRET: &str = "E08WAR897WEy2knn7aFBrvegVAf0AFdWBBF";
/// The OAuth endpoints expect the Android app; SSO and the API the iOS one.
const UA_OAUTH: &str = "com.garmin.android.apps.connectmobile";
const UA_APP: &str = "GCM-iOS-5.7.2.1";
/// Refresh the bearer token this long before Garmin says it expires.
const REFRESH_MARGIN_S: i64 = 120;

#[derive(Debug, thiserror::Error)]
pub enum GarminError {
    #[error("Garmin is rate limiting requests — try again later")]
    RateLimited,
    #[error("Garmin rejected the email or password")]
    InvalidCredentials,
    #[error("Garmin has locked the account — unlock it on connect.garmin.com")]
    AccountLocked,
    #[error("The verification code wasn't accepted")]
    MfaFailed,
    #[error("The Garmin sign-in has expired — sign in again")]
    AuthExpired,
    #[error("Garmin rejected the personal API key — it may have expired or been deleted; create a new one on Garmin Connect")]
    InvalidKey,
    #[error("Garmin blocked the request ({0})")]
    Blocked(String),
    #[error("Garmin answered {status}: {body}")]
    Http { status: u16, body: String },
    #[error("Network error: {0}")]
    Network(String),
    #[error("Unexpected answer from Garmin: {0}")]
    Unexpected(String),
}

impl GarminError {
    /// A stable machine-readable code for the frontend to branch on.
    pub fn code(&self) -> &'static str {
        match self {
            GarminError::RateLimited => "rate_limited",
            GarminError::InvalidCredentials => "invalid_credentials",
            GarminError::AccountLocked => "account_locked",
            GarminError::MfaFailed => "mfa_failed",
            GarminError::AuthExpired => "auth_expired",
            GarminError::InvalidKey => "invalid_key",
            GarminError::Blocked(_) => "blocked",
            GarminError::Http { .. } => "http",
            GarminError::Network(_) => "network",
            GarminError::Unexpected(_) => "unexpected",
        }
    }
}

impl From<reqwest::Error> for GarminError {
    fn from(e: reqwest::Error) -> Self {
        GarminError::Network(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, GarminError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuth1Token {
    pub token: String,
    pub secret: String,
    #[serde(default)]
    pub mfa_token: Option<String>,
    pub consumer_key: String,
    pub consumer_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuth2Token {
    pub access_token: String,
    /// Unix seconds.
    pub expires_at: i64,
}

/// Everything needed to keep talking to Garmin without the password.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub oauth1: OAuth1Token,
    pub oauth2: OAuth2Token,
}

/// A sign-in paused at Garmin's "enter the code we sent you" step. Holds the
/// SSO cookies, so it must be resumed with the same value.
pub struct PendingMfa {
    sso: reqwest::Client,
    csrf: String,
    referer: String,
}

pub enum Login {
    Done(Session),
    NeedsMfa(PendingMfa),
}

fn now_s() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn http_client(cookies: bool) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .cookie_store(cookies)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(GarminError::from)
}

fn signin_params() -> Vec<(&'static str, &'static str)> {
    vec![
        ("id", "gauth-widget"),
        ("embedWidget", "true"),
        ("gauthHost", SSO_EMBED),
        ("service", SSO_EMBED),
        ("source", SSO_EMBED),
        ("redirectAfterAccountLoginUrl", SSO_EMBED),
        ("redirectAfterAccountCreationUrl", SSO_EMBED),
    ]
}

fn url_with(base: &str, params: &[(&str, &str)]) -> String {
    let mut u = url::Url::parse(base).expect("static url");
    {
        let mut q = u.query_pairs_mut();
        for (k, v) in params {
            q.append_pair(k, v);
        }
    }
    u.to_string()
}

fn capture(pattern: &str, html: &str) -> Option<String> {
    Regex::new(pattern)
        .ok()?
        .captures(html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn csrf_of(html: &str) -> Option<String> {
    capture(r#"name="_csrf"\s+value="(.+?)""#, html)
}

fn title_of(html: &str) -> String {
    capture(r"<title>(.+?)</title>", html).unwrap_or_default()
}

fn ticket_of(html: &str) -> Option<String> {
    capture(r#"embed\?ticket=([^"]+)""#, html)
}

/// Maps the transport-level failures every Garmin endpoint shares.
fn check_status(status: reqwest::StatusCode, body: &str) -> Result<()> {
    match status.as_u16() {
        200..=299 => Ok(()),
        429 => Err(GarminError::RateLimited),
        403 if body.contains("cloudflare") || body.contains("Cloudflare") => {
            Err(GarminError::Blocked("Cloudflare challenge".into()))
        }
        s => Err(GarminError::Http {
            status: s,
            body: body.chars().take(300).collect(),
        }),
    }
}

async fn sso_text(req: reqwest::RequestBuilder) -> Result<String> {
    let res = req.header("User-Agent", UA_APP).send().await?;
    let status = res.status();
    let body = res.text().await?;
    check_status(status, &body)?;
    Ok(body)
}

/// Step 1–3: the SSO form. Ends with either a ticket or an MFA prompt.
pub async fn login(email: &str, password: &str) -> Result<Login> {
    let sso = http_client(true)?;

    let embed_url = url_with(
        SSO_EMBED,
        &[("id", "gauth-widget"), ("embedWidget", "true"), ("gauthHost", SSO)],
    );
    sso_text(sso.get(&embed_url)).await?;

    let signin_url = url_with(&format!("{SSO}/signin"), &signin_params());
    let page = sso_text(sso.get(&signin_url).header("Referer", &embed_url)).await?;
    let csrf = csrf_of(&page).ok_or_else(|| GarminError::Unexpected("no CSRF token on sign-in page".into()))?;

    let html = sso_text(
        sso.post(&signin_url)
            .header("Referer", &signin_url)
            .form(&[
                ("username", email),
                ("password", password),
                ("embed", "true"),
                ("_csrf", csrf.as_str()),
            ]),
    )
    .await?;

    let title = title_of(&html);
    if title.contains("MFA") {
        let csrf = csrf_of(&html)
            .ok_or_else(|| GarminError::Unexpected("no CSRF token on MFA page".into()))?;
        return Ok(Login::NeedsMfa(PendingMfa { sso, csrf, referer: signin_url }));
    }
    if title != "Success" {
        let lower = html.to_lowercase();
        if lower.contains("locked") {
            return Err(GarminError::AccountLocked);
        }
        return Err(GarminError::InvalidCredentials);
    }
    let ticket = ticket_of(&html).ok_or_else(|| GarminError::Unexpected("no ticket after sign-in".into()))?;
    finish_login(&ticket).await.map(Login::Done)
}

/// Step 3b: the code from the email/SMS/authenticator.
pub async fn resume_mfa(pending: PendingMfa, code: &str) -> Result<Session> {
    let url = url_with(&format!("{SSO}/verifyMFA/loginEnterMfaCode"), &signin_params());
    let html = sso_text(
        pending
            .sso
            .post(&url)
            .header("Referer", &pending.referer)
            .form(&[
                ("mfa-code", code.trim()),
                ("embed", "true"),
                ("_csrf", pending.csrf.as_str()),
                ("fromPage", "setupEnterMfaCode"),
            ]),
    )
    .await?;
    if title_of(&html) != "Success" {
        return Err(GarminError::MfaFailed);
    }
    let ticket = ticket_of(&html).ok_or_else(|| GarminError::Unexpected("no ticket after MFA".into()))?;
    finish_login(&ticket).await
}

async fn consumer(http: &reqwest::Client) -> (String, String) {
    #[derive(Deserialize)]
    struct Consumer {
        consumer_key: String,
        consumer_secret: String,
    }
    let fetched = async {
        let res = http
            .get(CONSUMER_URL)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        res.json::<Consumer>().await.ok()
    }
    .await;
    match fetched {
        Some(c) => (c.consumer_key, c.consumer_secret),
        None => (FALLBACK_CONSUMER_KEY.into(), FALLBACK_CONSUMER_SECRET.into()),
    }
}

/// Step 4–5: ticket → OAuth1 → OAuth2.
async fn finish_login(ticket: &str) -> Result<Session> {
    let http = http_client(false)?;
    let (consumer_key, consumer_secret) = consumer(&http).await;

    let params = vec![
        ("ticket".to_string(), ticket.to_string()),
        ("login-url".to_string(), SSO_EMBED.to_string()),
        ("accepts-mfa-tokens".to_string(), "true".to_string()),
    ];
    let auth = oauth1_header(
        "GET",
        PREAUTHORIZED,
        &params,
        &consumer_key,
        &consumer_secret,
        None,
        &nonce(),
        now_s(),
    );
    let mut u = url::Url::parse(PREAUTHORIZED).expect("static url");
    u.query_pairs_mut().extend_pairs(params.iter());
    let res = http
        .get(u)
        .header("User-Agent", UA_OAUTH)
        .header("Authorization", auth)
        .send()
        .await?;
    let status = res.status();
    let body = res.text().await?;
    check_status(status, &body)?;

    let mut token = None;
    let mut secret = None;
    let mut mfa_token = None;
    for (k, v) in url::form_urlencoded::parse(body.as_bytes()) {
        match k.as_ref() {
            "oauth_token" => token = Some(v.into_owned()),
            "oauth_token_secret" => secret = Some(v.into_owned()),
            "mfa_token" => mfa_token = Some(v.into_owned()),
            _ => {}
        }
    }
    let oauth1 = OAuth1Token {
        token: token.ok_or_else(|| GarminError::Unexpected("no oauth_token".into()))?,
        secret: secret.ok_or_else(|| GarminError::Unexpected("no oauth_token_secret".into()))?,
        mfa_token,
        consumer_key,
        consumer_secret,
    };
    let oauth2 = exchange(&http, &oauth1).await?;
    Ok(Session { oauth1, oauth2 })
}

/// OAuth1 → a fresh OAuth2 bearer token. This is also the "refresh": the
/// OAuth1 token lasts about a year, so no password is needed until then.
async fn exchange(http: &reqwest::Client, o1: &OAuth1Token) -> Result<OAuth2Token> {
    let form: Vec<(String, String)> = o1
        .mfa_token
        .iter()
        .map(|t| ("mfa_token".to_string(), t.clone()))
        .collect();
    let auth = oauth1_header(
        "POST",
        EXCHANGE,
        &form,
        &o1.consumer_key,
        &o1.consumer_secret,
        Some((&o1.token, &o1.secret)),
        &nonce(),
        now_s(),
    );
    let res = http
        .post(EXCHANGE)
        .header("User-Agent", UA_OAUTH)
        .header("Authorization", auth)
        .form(&form)
        .send()
        .await?;
    let status = res.status();
    let body = res.text().await?;
    if status.as_u16() == 401 {
        return Err(GarminError::AuthExpired);
    }
    check_status(status, &body)?;

    #[derive(Deserialize)]
    struct Exchanged {
        access_token: String,
        expires_in: i64,
    }
    let e: Exchanged = serde_json::from_str(&body)
        .map_err(|e| GarminError::Unexpected(format!("token exchange: {e}")))?;
    Ok(OAuth2Token {
        access_token: e.access_token,
        expires_at: now_s() + e.expires_in,
    })
}

/// The official Personal API: a key the user creates on Garmin Connect Web,
/// traded for a 24-hour bearer token whenever one is needed (there are no
/// refresh tokens — the key itself is the refresh).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Personal {
    pub api_key: String,
    #[serde(default)]
    pub token: Option<OAuth2Token>,
}

/// Which way a request is authenticated.
pub enum Auth<'a> {
    /// Official Personal API key → personal.connectapi.garmin.com.
    Personal(&'a mut Personal),
    /// Unofficial sign-in → connectapi.garmin.com.
    Legacy(&'a mut Session),
}

/// Personal API tokens last 24 hours; ask for a new one a little early.
const PERSONAL_TOKEN_FALLBACK_S: i64 = 23 * 3600;

/// A connectapi client for an API key or an already signed-in [`Session`].
pub struct Api {
    http: reqwest::Client,
}

impl Api {
    pub fn new() -> Result<Self> {
        Ok(Self { http: http_client(false)? })
    }

    /// Trade a Personal API key for a bearer token. A rejected key (deleted,
    /// expired, mistyped) is [`GarminError::InvalidKey`].
    pub async fn personal_token(&self, api_key: &str) -> Result<OAuth2Token> {
        let res = self
            .http
            .post(PERSONAL_TOKEN)
            .header("Authorization", format!("ApiKey {}", api_key.trim()))
            .send()
            .await?;
        let status = res.status();
        let body = res.text().await?;
        if matches!(status.as_u16(), 400 | 401 | 403 | 404) {
            return Err(GarminError::InvalidKey);
        }
        check_status(status, &body)?;
        parse_personal_token(&body)
    }

    /// Make sure the auth carries a usable bearer token. Returns whether it
    /// changed (so the caller should save it).
    async fn ensure_fresh(&self, auth: &mut Auth<'_>, force: bool) -> Result<bool> {
        match auth {
            Auth::Legacy(s) => {
                if force || s.oauth2.expires_at - REFRESH_MARGIN_S < now_s() {
                    s.oauth2 = exchange(&self.http, &s.oauth1).await?;
                    return Ok(true);
                }
                Ok(false)
            }
            Auth::Personal(p) => {
                let stale = p
                    .token
                    .as_ref()
                    .map(|t| t.expires_at - REFRESH_MARGIN_S < now_s())
                    .unwrap_or(true);
                if force || stale {
                    p.token = Some(self.personal_token(&p.api_key).await?);
                    return Ok(true);
                }
                Ok(false)
            }
        }
    }

    fn base_and_token<'b>(auth: &'b Auth<'_>) -> (&'static str, &'b str) {
        match auth {
            Auth::Legacy(s) => (API, s.oauth2.access_token.as_str()),
            Auth::Personal(p) => (
                PERSONAL_API,
                p.token.as_ref().map(|t| t.access_token.as_str()).unwrap_or(""),
            ),
        }
    }

    /// `GET {base}{path}?{query}` → body bytes. Refreshes the token first when
    /// it's about to expire and once more on a 401. The bool says whether the
    /// auth changed and should be saved.
    async fn fetch(
        &self,
        auth: &mut Auth<'_>,
        path: &str,
        query: &[(String, String)],
    ) -> Result<(Vec<u8>, bool)> {
        if !path.starts_with('/') || path.contains("..") || path.contains("://") {
            return Err(GarminError::Unexpected(format!("refusing path {path}")));
        }
        let mut refreshed = self.ensure_fresh(auth, false).await?;
        let mut retried = false;
        loop {
            let (base, token) = Self::base_and_token(auth);
            let res = self
                .http
                .get(format!("{base}{path}"))
                .query(query)
                .header("User-Agent", UA_APP)
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await?;
            let status = res.status();
            let bytes = res.bytes().await?.to_vec();
            if status.as_u16() == 401 && !retried {
                retried = true;
                refreshed |= self.ensure_fresh(auth, true).await?;
                continue;
            }
            if status.as_u16() == 401 {
                return Err(match auth {
                    Auth::Legacy(_) => GarminError::AuthExpired,
                    Auth::Personal(_) => GarminError::InvalidKey,
                });
            }
            check_status(status, &String::from_utf8_lossy(&bytes))?;
            return Ok((bytes, refreshed));
        }
    }

    /// JSON GET (`Null` for an empty answer).
    pub async fn get(
        &self,
        auth: &mut Auth<'_>,
        path: &str,
        query: &[(String, String)],
    ) -> Result<(Value, bool)> {
        let (bytes, refreshed) = self.fetch(auth, path, query).await?;
        if bytes.iter().all(|b| b.is_ascii_whitespace()) {
            return Ok((Value::Null, refreshed));
        }
        let v = serde_json::from_slice(&bytes)
            .map_err(|e| GarminError::Unexpected(format!("{path}: not JSON ({e})")))?;
        Ok((v, refreshed))
    }

    /// The laps of an activity, read from its original FIT file.
    pub async fn activity_laps(
        &self,
        auth: &mut Auth<'_>,
        activity_id: &str,
    ) -> Result<(Vec<fit::Lap>, bool)> {
        if activity_id.is_empty() || !activity_id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(GarminError::Unexpected(format!("bad activity id {activity_id}")));
        }
        let (bytes, refreshed) = self
            .fetch(auth, &format!("/download-service/files/activity/{activity_id}"), &[])
            .await?;
        Ok((fit::laps(&bytes)?, refreshed))
    }
}

/// The token endpoint's answer. Its shape isn't documented, so take the
/// usual spellings, or a bare token string.
fn parse_personal_token(body: &str) -> Result<OAuth2Token> {
    let trimmed = body.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        if let Some(t) = v.as_str() {
            return Ok(OAuth2Token {
                access_token: t.to_string(),
                expires_at: now_s() + PERSONAL_TOKEN_FALLBACK_S,
            });
        }
        let pick = |keys: &[&str]| keys.iter().find_map(|k| v.get(*k).cloned());
        let token = pick(&["access_token", "accessToken", "token"])
            .and_then(|t| t.as_str().map(String::from))
            .ok_or_else(|| GarminError::Unexpected("token answer without a token".into()))?;
        let expires_in = pick(&["expires_in", "expiresIn"])
            .and_then(|e| e.as_i64().or_else(|| e.as_str()?.parse().ok()))
            .unwrap_or(PERSONAL_TOKEN_FALLBACK_S);
        return Ok(OAuth2Token { access_token: token, expires_at: now_s() + expires_in });
    }
    if !trimmed.is_empty() && !trimmed.contains(char::is_whitespace) && !trimmed.starts_with('<') {
        return Ok(OAuth2Token {
            access_token: trimmed.to_string(),
            expires_at: now_s() + PERSONAL_TOKEN_FALLBACK_S,
        });
    }
    Err(GarminError::Unexpected("unreadable token answer".into()))
}

pub mod fit;

// ---------------------------------------------------------------------------
// OAuth1 (RFC 5849) HMAC-SHA1 signing
// ---------------------------------------------------------------------------

/// RFC 3986 unreserved characters stay; everything else is %-encoded.
const RFC3986: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

fn enc(s: &str) -> String {
    utf8_percent_encode(s, RFC3986).to_string()
}

fn nonce() -> String {
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The `Authorization: OAuth …` header for a request. `params` are the query
/// and form-body parameters, which take part in the signature.
#[allow(clippy::too_many_arguments)]
pub fn oauth1_header(
    method: &str,
    base_url: &str,
    params: &[(String, String)],
    consumer_key: &str,
    consumer_secret: &str,
    token: Option<(&str, &str)>,
    nonce: &str,
    timestamp: i64,
) -> String {
    let mut oauth: Vec<(String, String)> = vec![
        ("oauth_consumer_key".into(), consumer_key.into()),
        ("oauth_nonce".into(), nonce.into()),
        ("oauth_signature_method".into(), "HMAC-SHA1".into()),
        ("oauth_timestamp".into(), timestamp.to_string()),
        ("oauth_version".into(), "1.0".into()),
    ];
    if let Some((t, _)) = token {
        oauth.push(("oauth_token".into(), t.into()));
    }

    let mut all: Vec<(String, String)> = oauth
        .iter()
        .chain(params.iter())
        .map(|(k, v)| (enc(k), enc(v)))
        .collect();
    all.sort();
    let param_str = all
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let base = format!("{}&{}&{}", method.to_uppercase(), enc(base_url), enc(&param_str));
    let key = format!(
        "{}&{}",
        enc(consumer_secret),
        enc(token.map(|(_, s)| s).unwrap_or(""))
    );
    let mut mac = Hmac::<Sha1>::new_from_slice(key.as_bytes()).expect("hmac takes any key");
    mac.update(base.as_bytes());
    let sig = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    oauth.push(("oauth_signature".into(), sig));

    let fields = oauth
        .iter()
        .map(|(k, v)| format!("{}=\"{}\"", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("OAuth {fields}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worked example from Twitter's OAuth1 signing guide.
    #[test]
    fn signs_like_the_reference_example() {
        let params = vec![
            ("include_entities".to_string(), "true".to_string()),
            (
                "status".to_string(),
                "Hello Ladies + Gentlemen, a signed OAuth request!".to_string(),
            ),
        ];
        let h = oauth1_header(
            "POST",
            "https://api.twitter.com/1.1/statuses/update.json",
            &params,
            "xvz1evFS4wEEPTGEFPHBog",
            "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
            Some((
                "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
                "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
            )),
            "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
            1318622958,
        );
        assert!(
            h.contains(r#"oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D""#),
            "{h}"
        );
    }

    #[test]
    fn reads_the_personal_token_answer_in_its_likely_shapes() {
        let t = parse_personal_token(r#"{"access_token":"abc","expires_in":86400}"#).unwrap();
        assert_eq!(t.access_token, "abc");
        assert!(t.expires_at > now_s() + 86000);
        assert_eq!(parse_personal_token(r#"{"accessToken":"x1"}"#).unwrap().access_token, "x1");
        assert_eq!(parse_personal_token("\"bare\"").unwrap().access_token, "bare");
        assert_eq!(parse_personal_token("eyJhbGciOi.payload.sig").unwrap().access_token, "eyJhbGciOi.payload.sig");
        assert!(parse_personal_token("<html>nope</html>").is_err());
        assert!(parse_personal_token(r#"{"error":"x"}"#).is_err());
    }

    #[test]
    fn reads_the_sso_pages() {
        let form = r#"<input type="hidden" name="_csrf" value="ABC123"/>"#;
        assert_eq!(csrf_of(form).as_deref(), Some("ABC123"));
        let ok = r#"<title>Success</title><script>var x = "https://sso.garmin.com/sso/embed?ticket=ST-0123-abc-cas";</script>"#;
        assert_eq!(title_of(ok), "Success");
        assert_eq!(ticket_of(ok).as_deref(), Some("ST-0123-abc-cas"));
        assert!(title_of("<title>GARMIN > MFA Challenge</title>").contains("MFA"));
    }
}
