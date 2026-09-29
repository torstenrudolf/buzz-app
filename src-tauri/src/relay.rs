//! Packaged human relay access. Credentials stay with IdentityHost; redirects never carry auth.
use crate::identity::{EventTemplate, IdentityHost};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::OnceLock, time::Duration};
use url::Url;

mod channel_writes;
mod kit;
pub(crate) use channel_writes::{
    relay_channel_publish, relay_channel_sign, relay_direct_message, relay_kit_decode,
    relay_kit_prepare,
};
pub(crate) use kit::relay_kit_sign;

type Result<T> = std::result::Result<T, String>;
const MAX_BODY: usize = 1024 * 1024;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;

fn hex_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn template(event: &serde_json::Value, error: &str) -> Result<EventTemplate> {
    serde_json::from_value(serde_json::json!({
        "kind": event.get("kind"), "created_at": event.get("created_at"),
        "tags": event.get("tags"), "content": event.get("content"),
    }))
    .map_err(|_| error.into())
}

fn origin(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "Invalid relay origin")?;
    if value.len() > 2048
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Relay access requires an HTTPS origin without credentials or a path".into());
    }
    Ok(url)
}

fn request_url(community: &str, path: &str, method: &str) -> Result<Url> {
    let allowed = match method {
        "GET" => matches!(path, "/" | "/api/join-policy"),
        "POST" => matches!(
            path,
            "/query" | "/events" | "/api/invites/claim" | "/api/invites/accept-policy"
        ),
        _ => false,
    };
    if !allowed {
        return Err("Unsupported relay request".into());
    }
    origin(community)?
        .join(path)
        .map_err(|_| "Invalid relay path".into())
}

fn workflow_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
        && value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_workflow_time(value: &str) -> bool {
    // Timestamp syntax is bounded here; relay owns interpretation of the cursor.
    value.bytes().all(|byte| {
        byte.is_ascii_digit() || matches!(byte, b'-' | b'T' | b':' | b'.' | b'Z' | b'+')
    })
}

fn workflow_runs_url(community: &str, id: &str, cursor: Option<&WorkflowCursor>) -> Result<Url> {
    if !workflow_uuid(id)
        || cursor.is_some_and(|c| {
            !workflow_uuid(&c.before_id)
                || c.before.len() > 40
                || !c.before.as_bytes().get(0..10).is_some_and(|prefix| {
                    prefix.iter().enumerate().all(|(i, b)| {
                        if i == 4 || i == 7 {
                            *b == b'-'
                        } else {
                            b.is_ascii_digit()
                        }
                    })
                })
                || c.before.as_bytes().get(10) != Some(&b'T')
                || !valid_workflow_time(&c.before)
        })
    {
        return Err("Invalid workflow read".into());
    }
    let mut url = origin(community)?
        .join(&format!("/workflows/{id}/runs"))
        .map_err(|_| "Invalid workflow read")?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("limit", "20");
        if let Some(cursor) = cursor {
            query.append_pair("before", &cursor.before);
            query.append_pair("before_id", &cursor.before_id);
        }
    }
    Ok(url)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowCursor {
    before: String,
    before_id: String,
}

#[tauri::command]
pub(crate) async fn relay_workflow_runs(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    id: String,
    cursor: Option<WorkflowCursor>,
) -> Result<RelayResponse> {
    let url = workflow_runs_url(&community, &id, cursor.as_ref())?;
    send(host.inner(), url, "GET", None, true, 1024 * 1024).await
}

#[tauri::command]
pub(crate) async fn relay_sign(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    event: EventTemplate,
) -> Result<serde_json::Value> {
    validate_event(&community, &event)?;
    if event.kind == 9007 && !channel_creation_supported(&community).await? {
        return Err("Channel creation is unavailable".into());
    }
    if event.kind == 30078 {
        return Err("Channel recipe or Canvas rejected".into());
    }
    let workflow_delete = if event.kind == 5 {
        event
            .tags
            .iter()
            .find(|tag| tag[0] == "a")
            .map(|tag| tag[1].clone())
    } else {
        None
    };
    let signed = host.sign(event).await?;
    if workflow_delete
        .is_some_and(|coordinate| coordinate.split(':').nth(1) != signed["pubkey"].as_str())
    {
        return Err("Only the workflow author can manage it".into());
    }
    Ok(signed)
}

fn validate_event(community: &str, event: &EventTemplate) -> Result<()> {
    let mut relay = origin(community)?;
    if event.kind == 22242 {
        relay.set_scheme("wss").map_err(|_| "Invalid relay")?;
        let relay_tags: Vec<_> = event
            .tags
            .iter()
            .filter(|t| t.first().map(String::as_str) == Some("relay"))
            .collect();
        let challenges: Vec<_> = event
            .tags
            .iter()
            .filter(|t| t.first().map(String::as_str) == Some("challenge"))
            .collect();
        if !event.content.is_empty()
            || event.tags.len() != 2
            || relay_tags.len() != 1
            || relay_tags[0].len() != 2
            || Url::parse(&relay_tags[0][1]).ok().as_ref() != Some(&relay)
            || challenges.len() != 1
            || challenges[0].len() != 2
            || challenges[0][1].is_empty()
            || challenges[0][1].len() > 4096
        {
            return Err("Relay authentication does not match this community".into());
        }
    } else if event.kind == 5 {
        if !valid_message_deletion(event) {
            validate_workflow_template(event)?;
        }
    } else if matches!(event.kind, 30620 | 46020) {
        validate_workflow_template(event)?;
    } else if event.kind == 9007 {
        if !channel_writes::creation(event) {
            return Err("Agent enrollment or channel operation unavailable or invalid".into());
        }
    } else if !matches!(
        event.kind,
        0 | 7 | 9 | 1984 | 9000 | 9001 | 20001 | 30315 | 40003 | 40100 | 42000
    ) {
        return Err("This event is not supported by the packaged relay connection".into());
    }
    Ok(())
}

/** Keep the shared kind-5 writer aligned with the broker's channel-local deletion shape. */
fn valid_message_deletion(event: &EventTemplate) -> bool {
    if event.kind != 5
        || event.created_at > 9_007_199_254_740_991
        || !event.content.is_empty()
        || event.tags.len() > 106
        || event
            .tags
            .iter()
            .any(|tag| tag.len() != 2 || !matches!(tag[0].as_str(), "h" | "e" | "k" | "client-id"))
    {
        return false;
    }
    let channels: Vec<_> = event.tags.iter().filter(|tag| tag[0] == "h").collect();
    let targets: Vec<_> = event.tags.iter().filter(|tag| tag[0] == "e").collect();
    let kinds: Vec<_> = event.tags.iter().filter(|tag| tag[0] == "k").collect();
    channels.len() == 1
        && !channels[0][1].is_empty()
        && channels[0][1].encode_utf16().count() <= 256
        && (1..=100).contains(&targets.len())
        && targets.iter().all(|tag| {
            tag[1].len() == 64
                && tag[1]
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
        && targets
            .iter()
            .enumerate()
            .all(|(i, tag)| targets[..i].iter().all(|prior| prior[1] != tag[1]))
        && (1..=3).contains(&kinds.len())
        && kinds
            .iter()
            .all(|tag| matches!(tag[1].as_str(), "7" | "9" | "40002"))
}

fn validate_workflow_template(event: &EventTemplate) -> Result<()> {
    let expected = if event.kind == 5 { "a" } else { "d" };
    if event.tags.len() > 8
        || event.content.len() > 24_000
        || (event.kind != 30620 && !event.content.is_empty())
        || event.tags.iter().any(|tag| {
            tag.len() != 2
                || tag.iter().any(|value| value.len() > 256)
                || !matches!(
                    tag[0].as_str(),
                    "h" | "d" | "a" | "expected-revision" | "client-id"
                )
        })
        || event.tags.iter().filter(|tag| tag[0] == "h").count() != 1
        || event.tags.iter().filter(|tag| tag[0] == expected).count() != 1
        || event.tags.iter().any(|tag| {
            (tag[0] == "d" && expected != "d")
                || (tag[0] == "a" && expected != "a")
                || (tag[0] == "expected-revision" && event.kind != 30620)
        })
        || event
            .tags
            .iter()
            .enumerate()
            .any(|(i, tag)| event.tags[..i].iter().any(|prior| prior[0] == tag[0]))
    {
        return Err("Malformed workflow command".into());
    }
    let coordinate = &event.tags.iter().find(|tag| tag[0] == expected).unwrap()[1];
    let id = if event.kind == 5 {
        let Some(("30620", owner, id)) = coordinate
            .split_once(':')
            .and_then(|(kind, rest)| rest.split_once(':').map(|(owner, id)| (kind, owner, id)))
        else {
            return Err("Malformed workflow command".into());
        };
        if owner.len() != 64
            || !owner
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Malformed workflow command".into());
        }
        id
    } else {
        coordinate.as_str()
    };
    if !workflow_uuid(id)
        || !workflow_uuid(&event.tags.iter().find(|tag| tag[0] == "h").unwrap()[1])
        || event.tags.iter().any(|tag| {
            tag[0] == "expected-revision"
                && (tag[1].len() != 64
                    || !tag[1]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        })
    {
        return Err("Malformed workflow command".into());
    }
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadStateIntent {
    slot: String,
    created_at: u64,
    blob: serde_json::Value,
}

#[tauri::command]
pub(crate) async fn relay_decode_read_state(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    events: Vec<serde_json::Value>,
) -> Result<serde_json::Value> {
    origin(&community)?;
    host.decode_read_state(events).await
}

#[tauri::command]
pub(crate) async fn relay_sign_read_state(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    intent: ReadStateIntent,
) -> Result<serde_json::Value> {
    origin(&community)?;
    host.sign_read_state(intent.slot, intent.created_at, intent.blob)
        .await
}

/// Publication cannot be routed through the general event writer: it must verify
/// the exact own, encrypted read-state coordinate before forwarding signed bytes.
#[tauri::command]
pub(crate) async fn relay_publish_read_state(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    event: serde_json::Value,
) -> Result<RelayResponse> {
    let url = request_url(&community, "/events", "POST")?;
    let body = serde_json::to_string(&event).map_err(|_| "Invalid read-state event")?;
    if body.len() > 64 * 1024 {
        return Err("Invalid read-state event".into());
    }
    host.decode_read_state(vec![event]).await?;
    send(host.inner(), url, "POST", Some(body), true, MAX_RESPONSE).await
}

#[derive(Serialize)]
pub(crate) struct RelayResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

async fn verify_owned_event(host: &IdentityHost, event: &serde_json::Value) -> Result<()> {
    if event.get("pubkey").and_then(serde_json::Value::as_str)
        != Some(host.viewer().await?.as_str())
    {
        return Err("Invalid outgoing signature".into());
    }
    verify_signature(event)
}

fn verify_signature(event: &serde_json::Value) -> Result<()> {
    let parsed: nostr::Event =
        serde_json::from_value(event.clone()).map_err(|_| "Invalid outgoing signature")?;
    parsed
        .verify()
        .map_err(|_| "Invalid outgoing signature".into())
}

async fn channel_creation_supported(community: &str) -> Result<bool> {
    let url = request_url(community, "/", "GET")?;
    let mut response = client()?
        .get(url)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .map_err(|_| "Community discovery failed")?;
    if !response.status().is_success() {
        return Err("Community discovery failed".into());
    }
    let body = read_bounded(
        &mut response,
        MAX_BODY,
        "Community discovery failed",
        "Invalid community information",
    )
    .await?;
    let info: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "Invalid community information")?;
    Ok(info
        .get("self")
        .and_then(serde_json::Value::as_str)
        .is_some_and(hex_key)
        && info
            .get("supported_nips")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|nips| nips.contains(&serde_json::Value::from(29))))
}

fn client() -> Result<&'static reqwest::Client> {
    static CLIENT: OnceLock<std::result::Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
        })
        .as_ref()
        .map_err(|_| "Relay network client is unavailable".into())
}

#[tauri::command]
pub(crate) async fn relay_http(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    path: String,
    method: String,
    body: Option<String>,
) -> Result<RelayResponse> {
    let url = request_url(&community, &path, &method)?;
    if body.as_ref().is_some_and(|b| b.len() > MAX_BODY)
        || (method == "GET" && body.is_some())
        || (method == "POST" && body.is_none())
    {
        return Err("Invalid relay request body".into());
    }
    if path == "/events" {
        let event: serde_json::Value =
            serde_json::from_str(body.as_deref().ok_or("Invalid relay request body")?)
                .map_err(|_| "Invalid relay request body")?;
        let kind = event.get("kind").and_then(serde_json::Value::as_u64);
        if matches!(kind, Some(41010)) {
            return Err("Choose between one and eight other people.".into());
        }
        if kind == Some(30078) {
            verify_owned_event(host.inner(), &event).await?;
            kit::validate_ciphertext(host.inner(), &event, &community).await?;
        }
        if kind == Some(9007) {
            verify_owned_event(host.inner(), &event).await?;
            let template = template(
                &event,
                "Agent enrollment or channel operation unavailable or invalid",
            )?;
            if !channel_writes::creation(&template) {
                return Err("Agent enrollment or channel operation unavailable or invalid".into());
            }
        }
        if matches!(kind, Some(9002 | 9008 | 9022 | 41012 | 9035 | 9036)) {
            return Err("Invalid outgoing signature".into());
        }
    }
    send(
        host.inner(),
        url,
        &method,
        body,
        method == "POST",
        MAX_RESPONSE,
    )
    .await
}

async fn send(
    host: &IdentityHost,
    url: Url,
    method: &str,
    body: Option<String>,
    authenticated: bool,
    response_limit: usize,
) -> Result<RelayResponse> {
    let mut request = client()?.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid relay method")?,
        url.clone(),
    );
    if authenticated {
        let payload = body
            .as_ref()
            .map(|body| format!("{:x}", Sha256::digest(body.as_bytes())));
        let auth = host
            .sign(EventTemplate {
                kind: 27235,
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| "System clock is unavailable")?
                    .as_secs(),
                content: String::new(),
                tags: [
                    vec![
                        vec!["u".into(), url.to_string()],
                        vec!["method".into(), method.into()],
                    ],
                    payload
                        .map(|hash| vec![vec!["payload".into(), hash]])
                        .unwrap_or_default(),
                    vec![vec!["nonce".into(), uuid::Uuid::new_v4().to_string()]],
                ]
                .concat(),
            })
            .await?;
        request = request
            .header(
                "Authorization",
                format!(
                    "Nostr {}",
                    STANDARD.encode(
                        serde_json::to_vec(&auth)
                            .map_err(|_| "Could not encode relay authentication")?
                    )
                ),
            )
            .header("Content-Type", "application/json");
        if let Some(body) = body {
            request = request.body(body);
        }
    } else {
        request = request.header("Accept", "application/nostr+json");
    }
    // Never replay a write after a transport error: it may already have reached the relay.
    let mut response = request
        .send()
        .await
        .map_err(|_| "Relay request could not be confirmed")?;
    let status = response.status().as_u16();
    let mut headers = BTreeMap::new();
    for name in ["content-type", "retry-after", "server-timing"] {
        if let Some(value) = response.headers().get(name).and_then(|v| v.to_str().ok()) {
            headers.insert(name.into(), value.into());
        }
    }
    let bytes = read_bounded(
        &mut response,
        response_limit,
        "Relay response was interrupted",
        "Relay response is too large",
    )
    .await?;

    let body = String::from_utf8(bytes).map_err(|_| "Relay response is not UTF-8")?;
    Ok(RelayResponse {
        status,
        headers,
        body,
    })
}

async fn read_bounded(
    response: &mut reqwest::Response,
    limit: usize,
    interrupted: &str,
    oversized: &str,
) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(oversized.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| interrupted)? {
        if chunk.len() > limit - bytes.len() {
            return Err(oversized.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests;
