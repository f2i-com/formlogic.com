//! FormLogic's side of it, under `/api/v1/data-node` (`DataNodeController` in FormLogic).
//!
//! The plugin's sign-in alone gets nothing here. FormLogic answers only a computer its owner
//! approved, and each request that moves data is also signed by the node key, so a stolen sign-in
//! can't name a key of its own to seal to, or push a restore. Redirects are not followed: the
//! sign-in goes to the server the person named and nowhere else.

use std::io::Read as _;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::identity::NodeIdentity;
use crate::link::Account;

const REGISTER: &str = "/api/v1/data-node/register";
const SELF_NODE: &str = "/api/v1/data-node/self";
const SOURCES: &str = "/api/v1/data-node/backup-sources";
const SOURCE_BACKUPS: &str = "/api/v1/data-node/source-backups";
const STAGED: &str = "/api/v1/data-node/account-backups";
const RESTORES: &str = "/api/v1/data-node/restores";

const SOURCE_DOMAIN: &str = "flsourcebackup:1";
const RESTORE_DOMAIN: &str = "flsourcerestore:1";

const CONNECT: Duration = Duration::from_secs(15);
const QUICK: Duration = Duration::from_secs(30);
/// FormLogic builds a backup while this waits: a large app takes minutes.
const BUILD: Duration = Duration::from_secs(600);
/// A sealed backup can be 256 MiB.
const TRANSFER: Duration = Duration::from_secs(1800);
/// That, and what sealing adds. A server that sends more is not sending a backup.
const MAX_SEALED_BYTES: u64 = 258 * 1024 * 1024;
/// An account's list of apps and forms, or any other answer that isn't a backup.
const MAX_REPLY_BYTES: u64 = 16 * 1024 * 1024;
/// As much of a server's refusal as goes on to the page.
const MAX_MESSAGE: usize = 300;

/// Why a request got nowhere. The first three stop a run: every other source would fail the same.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The sign-in was refused. A password reset in FormLogic ends it, on purpose.
    Relink,
    /// FormLogic doesn't know this computer as approved.
    NotApproved,
    /// This FormLogic doesn't offer it.
    NotOffered,
    /// Too many requests: wait, and it will go through.
    Busy,
    /// Anything else, in words for the person.
    Failed(String),
}

impl Refusal {
    pub fn stops_a_run(&self) -> bool {
        matches!(self, Refusal::Relink | Refusal::NotApproved | Refusal::NotOffered)
    }

    pub fn words(&self) -> String {
        match self {
            Refusal::Relink => "FormLogic no longer accepts this computer's link, as it won't after a password reset. Connect again, approve this computer, and backups carry on.".to_string(),
            Refusal::NotApproved => "FormLogic hasn't approved this computer yet. Approve it in FormLogic under Settings, Linked Desktops, Data nodes.".to_string(),
            Refusal::NotOffered => "This FormLogic doesn't offer data backups. Its administrator can turn on PRIVATE_FORMS and DATA_NODES.".to_string(),
            Refusal::Busy => "FormLogic is busy. Try again in a minute.".to_string(),
            Refusal::Failed(words) => words.clone(),
        }
    }
}

/// What an answer that isn't a success means.
pub fn refusal_of(status: u16, body: &Value) -> Refusal {
    let code = body.get("code").and_then(Value::as_str).unwrap_or("");
    match (status, code) {
        (401, _) => Refusal::Relink,
        (403, "data_nodes_disabled") | (404, "") => Refusal::NotOffered,
        (403, "data_node_unauthorized") => Refusal::NotApproved,
        (429, _) => Refusal::Busy,
        _ => Refusal::Failed(body.get("message").and_then(Value::as_str).map(|message| message.chars().take(MAX_MESSAGE).collect()).unwrap_or_else(|| format!("FormLogic answered {status}."))),
    }
}

/// How this computer stands with FormLogic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// `pending`, `approved` or `revoked`: FormLogic's own words.
    pub status: String,
    pub approved: bool,
}

/// One agent per call, because each kind of call waits a different time.
pub fn agent(read: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().redirects(0).timeout_connect(CONNECT).timeout_read(read).timeout_write(read).user_agent(concat!("formlogic-backups/", env!("CARGO_PKG_VERSION"))).build()
}

fn url(account: &Account, path: &str) -> String {
    format!("{}{path}", account.base_url)
}

fn bearer(account: &Account) -> String {
    format!("Bearer {}", account.credential)
}

/// A JSON body, bounded.
pub fn read_json(response: ureq::Response) -> Option<Value> {
    let mut bytes = Vec::new();
    let read = response.into_reader().take(MAX_REPLY_BYTES + 1).read_to_end(&mut bytes);
    (read.is_ok() && bytes.len() as u64 <= MAX_REPLY_BYTES).then(|| serde_json::from_slice(&bytes).ok()).flatten()
}

fn answer(sent: Result<ureq::Response, ureq::Error>) -> Result<Value, Refusal> {
    match sent {
        Ok(response) if (200..300).contains(&response.status()) => read_json(response).ok_or_else(|| Refusal::Failed("FormLogic's answer could not be read.".to_string())),
        Ok(response) => Err(refusal_of(response.status(), &Value::Null)),
        Err(ureq::Error::Status(status, response)) => Err(refusal_of(status, &read_json(response).unwrap_or(Value::Null))),
        Err(ureq::Error::Transport(failure)) => Err(unreachable(&failure)),
    }
}

fn unreachable(failure: &ureq::Transport) -> Refusal {
    // Not the URL: it stays out of anything a page or a log might show.
    Refusal::Failed(format!("Could not reach FormLogic: {}", failure.kind()))
}

/// The moment a request is signed, in the form FormLogic parses.
fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// What the node signs to ask for one app or form to be sealed to `recipient`.
pub fn source_message(requested_at: &str, recipient: &str, kind: &str, id: &str) -> String {
    format!("{SOURCE_DOMAIN}|{requested_at}|{recipient}|{kind}|{id}")
}

/// What the node signs to put back the bytes with this digest.
pub fn restore_message(requested_at: &str, sha256_hex: &str) -> String {
    format!("{RESTORE_DOMAIN}|{requested_at}|{sha256_hex}")
}

fn node_of(answered: &Value) -> Option<Node> {
    let node = answered.pointer("/data/node").filter(|node| !node.is_null())?;
    Some(Node {
        status: node.get("status").and_then(Value::as_str).unwrap_or("pending").to_string(),
        approved: node.get("approved").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// Tells FormLogic this computer's key and name. Starts `pending`; the owner approves it there.
pub fn register(account: &Account, identity: &NodeIdentity, display_name: &str) -> Result<Option<Node>, Refusal> {
    let body = json!({"signingPublicKey": identity.public_key_b64(), "displayName": display_name, "capabilities": ["storage"]});
    let sent = agent(QUICK).post(&url(account, REGISTER)).set("Authorization", &bearer(account)).send_json(body);
    Ok(node_of(&answer(sent)?))
}

/// How FormLogic has this computer down.
pub fn self_node(account: &Account) -> Result<Option<Node>, Refusal> {
    let sent = agent(QUICK).get(&url(account, SELF_NODE)).set("Authorization", &bearer(account)).call();
    Ok(node_of(&answer(sent)?))
}

/// Ends this link at FormLogic: the node loses its authority and the sign-in stops working.
pub fn unlink(account: &Account) -> Result<(), Refusal> {
    let sent = agent(QUICK).delete(&url(account, SELF_NODE)).set("Authorization", &bearer(account)).call();
    answer(sent).map(|_| ())
}

/// The apps and forms this account can back up: names and dates.
pub fn sources(account: &Account) -> Result<Value, Refusal> {
    let sent = agent(QUICK).get(&url(account, SOURCES)).set("Authorization", &bearer(account)).call();
    Ok(answer(sent)?.get("data").cloned().unwrap_or(Value::Null))
}

/// Asks FormLogic to seal one app or form to `recipient`. Gives back its id and signed header.
pub fn create(account: &Account, identity: &NodeIdentity, kind: &str, id: &str, recipient: &str) -> Result<(String, Value), Refusal> {
    let requested_at = now();
    let body = json!({
        "kind": kind,
        "id": id,
        "recipientPk": recipient,
        "requestedAt": requested_at,
        "recipientPkSignature": identity.sign_b64(source_message(&requested_at, recipient, kind, id).as_bytes()),
    });
    let sent = agent(BUILD).post(&url(account, SOURCE_BACKUPS)).set("Authorization", &bearer(account)).send_json(body);
    let answered = answer(sent)?;
    let backup_id = answered.pointer("/data/backupId").and_then(Value::as_str).ok_or_else(|| Refusal::Failed("FormLogic gave no backup.".to_string()))?;
    Ok((backup_id.to_string(), answered.pointer("/data/header").cloned().unwrap_or(Value::Null)))
}

/// Streams a staged backup to `destination`, a new file.
pub fn fetch(account: &Account, backup_id: &str, destination: &Path) -> Result<(), Refusal> {
    let sent = agent(TRANSFER).get(&url(account, &format!("{STAGED}/{backup_id}/payload"))).set("Authorization", &bearer(account)).call();
    let response = match sent {
        Ok(response) if (200..300).contains(&response.status()) => response,
        other => return answer(other).map(|_| ()),
    };
    let mut file = crate::secret_file::create_new_owner_only(destination).map_err(|e| Refusal::Failed(format!("Could not save the backup: {e}")))?;
    let copied = std::io::copy(&mut response.into_reader().take(MAX_SEALED_BYTES + 1), &mut file).map_err(|e| Refusal::Failed(format!("The backup did not finish downloading: {e}")))?;
    if copied > MAX_SEALED_BYTES {
        return Err(Refusal::Failed("FormLogic sent more than a backup can be.".to_string()));
    }
    // On the disk before anything older is pruned for it.
    file.sync_all().map_err(|e| Refusal::Failed(format!("Could not save the backup: {e}")))
}

/// Tells FormLogic it can drop its staged copy. A failure is harmless: it goes within the hour.
pub fn discard(account: &Account, backup_id: &str) {
    let _ = agent(QUICK).delete(&url(account, &format!("{STAGED}/{backup_id}"))).set("Authorization", &bearer(account)).call();
}

/// Sends a plain backup zip to be restored as new copies. Nothing there is overwritten.
pub fn restore(account: &Account, identity: &NodeIdentity, zip: &Path, sha256_hex: &str) -> Result<Value, Refusal> {
    let requested_at = now();
    let file = std::fs::File::open(zip).map_err(|e| Refusal::Failed(format!("Could not read the backup: {e}")))?;
    let bytes = file.metadata().map(|m| m.len()).map_err(|e| Refusal::Failed(e.to_string()))?;
    let sent = agent(TRANSFER)
        .post(&url(account, RESTORES))
        .set("Authorization", &bearer(account))
        .set("Content-Type", "application/zip")
        .set("Content-Length", &bytes.to_string())
        .set("X-Data-Requested-At", &requested_at)
        .set("X-Data-Signature", &identity.sign_b64(restore_message(&requested_at, sha256_hex).as_bytes()))
        .send(file);
    Ok(answer(sent)?.get("data").cloned().unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_link_says_to_connect_again() {
        assert_eq!(refusal_of(401, &Value::Null), Refusal::Relink);
        assert!(Refusal::Relink.stops_a_run());
        assert!(Refusal::Relink.words().contains("Connect again"));
    }

    #[test]
    fn an_unapproved_computer_is_told_where_to_approve_it() {
        let refusal = refusal_of(403, &json!({"code": "data_node_unauthorized", "message": "This API key is not bound"}));
        assert_eq!(refusal, Refusal::NotApproved);
        assert!(refusal.stops_a_run());
        assert!(refusal.words().contains("Linked Desktops"));
    }

    #[test]
    fn a_formlogic_without_it_is_not_an_error_of_this_computers() {
        assert_eq!(refusal_of(403, &json!({"code": "data_nodes_disabled"})), Refusal::NotOffered);
        assert_eq!(refusal_of(404, &Value::Null), Refusal::NotOffered);
    }

    #[test]
    fn one_unknown_app_does_not_stop_the_others() {
        let refusal = refusal_of(404, &json!({"code": "App not found", "message": "Unknown app or form"}));
        assert_eq!(refusal, Refusal::Failed("Unknown app or form".to_string()));
        assert!(!refusal.stops_a_run());
    }

    #[test]
    fn being_told_to_wait_does_not_stop_a_run() {
        assert_eq!(refusal_of(429, &Value::Null), Refusal::Busy);
        assert!(!Refusal::Busy.stops_a_run());
    }

    #[test]
    fn a_stale_clock_or_a_bad_signature_is_said_as_formlogic_says_it() {
        let refusal = refusal_of(403, &json!({"code": "account_backup_key_unbound", "message": "The request must carry a fresh signature"}));
        assert_eq!(refusal, Refusal::Failed("The request must carry a fresh signature".to_string()));
    }

    #[test]
    fn a_servers_refusal_stays_short() {
        let Refusal::Failed(words) = refusal_of(400, &json!({"message": "x".repeat(100_000)})) else { panic!("a failure") };
        assert_eq!(words.len(), MAX_MESSAGE);
    }

    #[test]
    fn the_signed_text_is_formlogics() {
        // DataAccountBackupService::SOURCE_SIGNATURE_DOMAIN and RESTORE_SIGNATURE_DOMAIN.
        assert_eq!(source_message("2026-10-31T00:00:00Z", "cGs=", "app", "a1"), "flsourcebackup:1|2026-10-31T00:00:00Z|cGs=|app|a1");
        assert_eq!(restore_message("2026-10-31T00:00:00Z", "abc"), "flsourcerestore:1|2026-10-31T00:00:00Z|abc");
    }

    #[test]
    fn the_time_is_the_form_formlogic_parses() {
        let time = now();
        assert_eq!(time.len(), 20);
        assert!(time.ends_with('Z') && time.contains('T'));
    }

    #[test]
    fn a_node_is_read_from_formlogics_answer() {
        assert_eq!(node_of(&json!({"data": {"node": null}})), None);
        assert_eq!(node_of(&json!({"data": {"node": {"status": "approved", "approved": true}}})), Some(Node { status: "approved".into(), approved: true }));
    }
}
