//! Independent Desktop validation of `__flenc:1` response envelopes
//! (plan §12.2). The Desktop primary never trusts the Cloud to have validated
//! a Private response: this mirrors backend/src/Services/EnvelopeValidator.php
//! field-for-field (allowlists, suites, canonical base64, size caps, manifest
//! tuple matching) on top of the duplicate-key-rejecting
//! [`super::strict_json`] parser. Shared adversarial fixtures:
//! docs/contracts/data-envelope-adversarial.json (asserted here AND by
//! backend/tests/Unit/DataEnvelopeAdversarialTest.php).
//!
//! NEVER decrypts anything — a storage node holds no content keys (plan D3).

use serde_json::Value;

pub const ENVELOPE_VERSION: i64 = 1;
pub const CONTENT_SUITE: &str = "xchacha20p1305.1";
pub const WRAP_SUITE: &str = "sealedbox-x25519xsalsa20p1305.1";

pub const MAX_ENVELOPE_BYTES: usize = 2_000_000;
pub const MAX_REQUEST_BYTES: usize = 2_100_000;
pub const MAX_CT_B64_CHARS: usize = 1_900_000;
pub const WRAPPED_DEK_BYTES: usize = 80;
pub const NONCE_BYTES: usize = 24;
pub const MAX_ENVELOPE_KEYS: usize = 24;
pub const MAX_ATTACHMENTS: usize = 50;

const ALLOWED_ENVELOPE_KEYS: &[&str] = &[
    "__flenc", "recordId", "rev", "keyId", "epoch", "content", "wrap",
    "schemaVersion", "schemaHash", "attachments", "wrappedDek", "nonce", "ct",
];

/// One acceptable manifest tuple for the form (active, or retiring within its
/// signed grace window — resolved by the caller, plan §12.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestTuple {
    pub key_id: String,
    pub ingest_epoch: i64,
    pub schema_version: i64,
    pub schema_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeError {
    pub code: &'static str,
    pub message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> EnvelopeError {
    EnvelopeError { code, message: message.into() }
}

/// Parse a raw private-form request body with duplicate-key detection at every
/// level (mirror of EnvelopeValidator::parseRequestBody).
pub fn parse_request_body(raw: &[u8]) -> Result<Value, EnvelopeError> {
    if raw.len() > MAX_REQUEST_BYTES {
        return Err(fail("payload_too_large", "request body exceeds the private-form size cap"));
    }
    let value = super::strict_json::parse(raw).map_err(|e| {
        if e.contains("duplicate") {
            fail("envelope_invalid", "duplicate JSON keys are not allowed")
        } else {
            fail("envelope_invalid", "request body is not valid JSON")
        }
    })?;
    if !value.is_object() {
        return Err(fail("envelope_invalid", "request body must be a JSON object"));
    }
    Ok(value)
}

/// Structural envelope validation (no decryption) — mirror of
/// EnvelopeValidator::validateEnvelope. `expected_rev = None` means create
/// (rev must be 1); otherwise rev must equal `expected_rev + 1`.
pub fn validate_envelope(
    env: &Value,
    acceptable_manifests: &[ManifestTuple],
    expected_rev: Option<i64>,
) -> Result<(), EnvelopeError> {
    let Some(map) = env.as_object() else {
        return Err(fail("envelope_invalid", "envelope must be a JSON object"));
    };
    if map.len() > MAX_ENVELOPE_KEYS {
        return Err(fail("envelope_invalid", "envelope has too many keys"));
    }
    for key in map.keys() {
        if !ALLOWED_ENVELOPE_KEYS.contains(&key.as_str()) {
            return Err(fail("envelope_invalid", format!("unexpected envelope key: {key}")));
        }
    }
    if map.get("__flenc").and_then(Value::as_i64) != Some(ENVELOPE_VERSION)
        || !map.get("__flenc").map(Value::is_i64).unwrap_or(false)
    {
        return Err(fail("envelope_invalid", "unsupported envelope version"));
    }
    if map.get("content").and_then(Value::as_str) != Some(CONTENT_SUITE) {
        return Err(fail("envelope_invalid", "unknown content suite"));
    }
    if map.get("wrap").and_then(Value::as_str) != Some(WRAP_SUITE) {
        return Err(fail("envelope_invalid", "unknown wrap suite"));
    }
    let record_id = map.get("recordId").and_then(Value::as_str).unwrap_or("");
    if !is_uuid_v4(record_id) {
        return Err(fail("envelope_invalid", "recordId must be a UUIDv4"));
    }
    let rev = match map.get("rev") {
        Some(v) if v.is_i64() => v.as_i64().unwrap_or(0),
        _ => return Err(fail("envelope_invalid", "rev must be a positive integer")),
    };
    if rev < 1 {
        return Err(fail("envelope_invalid", "rev must be a positive integer"));
    }
    match expected_rev {
        None => {
            if rev != 1 {
                return Err(fail("envelope_invalid", "new responses must carry rev 1"));
            }
        }
        Some(expected) => {
            if rev != expected + 1 {
                return Err(fail("revision_conflict", "envelope rev must be expectedRev + 1"));
            }
        }
    }
    let key_id = map.get("keyId").and_then(Value::as_str).unwrap_or("");
    if !is_key_id(key_id) {
        return Err(fail("envelope_invalid", "keyId malformed"));
    }
    let epoch = match map.get("epoch") {
        Some(v) if v.is_i64() => v.as_i64().unwrap_or(0),
        _ => return Err(fail("envelope_invalid", "epoch must be a positive integer")),
    };
    if epoch < 1 {
        return Err(fail("envelope_invalid", "epoch must be a positive integer"));
    }
    let schema_version = match map.get("schemaVersion") {
        Some(v) if v.is_i64() => v.as_i64().unwrap_or(0),
        _ => return Err(fail("envelope_invalid", "schemaVersion must be a positive integer")),
    };
    if schema_version < 1 {
        return Err(fail("envelope_invalid", "schemaVersion must be a positive integer"));
    }
    let schema_hash = map.get("schemaHash").and_then(Value::as_str).unwrap_or("");
    if !is_hex64(schema_hash) {
        return Err(fail("envelope_invalid", "schemaHash must be 64 lowercase hex chars"));
    }

    if let Some(atts_value) = map.get("attachments") {
        let Some(atts) = atts_value.as_array() else {
            return Err(fail("envelope_invalid", "attachments must be a non-empty list when present"));
        };
        if atts.is_empty() {
            return Err(fail("envelope_invalid", "attachments must be a non-empty list when present"));
        }
        if atts.len() > MAX_ATTACHMENTS {
            return Err(fail("envelope_invalid", "too many attachments"));
        }
        let mut prev: Option<&str> = None;
        for id_value in atts {
            let Some(id) = id_value.as_str() else {
                return Err(fail("envelope_invalid", "attachment id malformed"));
            };
            if !is_file_id(id) {
                return Err(fail("envelope_invalid", "attachment id malformed"));
            }
            if let Some(p) = prev {
                if p == id {
                    return Err(fail("envelope_invalid", "duplicate attachment id"));
                }
                if p > id {
                    return Err(fail("envelope_invalid", "attachments must be sorted"));
                }
            }
            prev = Some(id);
        }
    }

    if decode_exact_b64(map.get("wrappedDek"), WRAPPED_DEK_BYTES).is_none() {
        return Err(fail("envelope_invalid", "wrappedDek must be canonical base64 of exactly 80 bytes"));
    }
    if decode_exact_b64(map.get("nonce"), NONCE_BYTES).is_none() {
        return Err(fail("envelope_invalid", "nonce must be canonical base64 of exactly 24 bytes"));
    }
    let ct = map.get("ct").and_then(Value::as_str).unwrap_or("");
    if ct.is_empty() || ct.len() > MAX_CT_B64_CHARS || !is_canonical_b64(ct) {
        return Err(fail("envelope_invalid", "ct must be canonical base64 within the size cap"));
    }

    let serialized = serde_json::to_string(env)
        .map_err(|_| fail("envelope_invalid", "envelope does not serialize"))?;
    if serialized.len() > MAX_ENVELOPE_BYTES {
        return Err(fail("payload_too_large", "sealed envelope exceeds the 2 MB storage cap"));
    }

    let tuple_ok = acceptable_manifests.iter().any(|m| {
        m.key_id == key_id
            && m.ingest_epoch == epoch
            && m.schema_version == schema_version
            && constant_time_eq(m.schema_hash.as_bytes(), schema_hash.as_bytes())
    });
    if !tuple_ok {
        return Err(fail(
            "key_epoch_retired",
            "envelope does not match any currently acceptable manifest for this form",
        ));
    }
    Ok(())
}

fn is_uuid_v4(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if b != b'-' {
                    return false;
                }
            }
            14 => {
                if b != b'4' {
                    return false;
                }
            }
            19 => {
                if !matches!(b, b'8' | b'9' | b'a' | b'b') {
                    return false;
                }
            }
            _ => {
                if !b.is_ascii_hexdigit() || b.is_ascii_uppercase() {
                    return false;
                }
            }
        }
    }
    true
}

fn is_token_tail(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_key_id(s: &str) -> bool {
    s.strip_prefix("fik_").map(|t| is_token_tail(t, 36)).unwrap_or(false)
}

fn is_file_id(s: &str) -> bool {
    s.strip_prefix("fil_").map(|t| is_token_tail(t, 36)).unwrap_or(false)
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Canonical padded base64: strict decode AND re-encode must round-trip
/// (mirror of EnvelopeValidator::isCanonicalB64).
fn is_canonical_b64(s: &str) -> bool {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    if s.is_empty() || s.len() % 4 != 0 {
        return false;
    }
    match B64.decode(s) {
        Ok(decoded) => B64.encode(&decoded) == s,
        Err(_) => false,
    }
}

fn decode_exact_b64(value: Option<&Value>, expected: usize) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    let s = value?.as_str()?;
    if !is_canonical_b64(s) {
        return None;
    }
    let decoded = B64.decode(s).ok()?;
    if decoded.len() != expected {
        return None;
    }
    Some(decoded)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;

    fn fixtures() -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/contracts/data-envelope-adversarial.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("fixture file missing at {}: {e}", path.display()));
        serde_json::from_str(&raw).expect("fixture file parses")
    }

    fn tuples(case: &Value) -> Vec<ManifestTuple> {
        case["manifests"]
            .as_array()
            .expect("manifests")
            .iter()
            .map(|m| ManifestTuple {
                key_id: m["key_id"].as_str().unwrap().to_string(),
                ingest_epoch: m["ingest_epoch"].as_i64().unwrap(),
                schema_version: m["schema_version"].as_i64().unwrap(),
                schema_hash: m["schema_hash"].as_str().unwrap().to_string(),
            })
            .collect()
    }

    /// Shared adversarial corpus — Rust and PHP must agree case-for-case
    /// (plan §12.2: "Share adversarial fixture corpora across TypeScript,
    /// PHP, and Rust").
    #[test]
    fn adversarial_fixtures_agree_with_php() {
        let f = fixtures();
        let cases = f["cases"].as_array().expect("cases");
        assert!(cases.len() >= 10, "corpus should stay meaningful");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let raw = case["body"].as_str().unwrap().as_bytes();
            let expected_rev = case["expectedRev"].as_i64();
            let expect_ok = case["ok"].as_bool().unwrap();
            let result = parse_request_body(raw).and_then(|body| {
                let env = body
                    .get("envelope")
                    .cloned()
                    .unwrap_or(Value::Null);
                validate_envelope(&env, &tuples(case), expected_rev)
            });
            match (expect_ok, result) {
                (true, Ok(())) => {}
                (false, Err(e)) => {
                    if let Some(code) = case["code"].as_str() {
                        assert_eq!(e.code, code, "fixture {name}: wrong error code");
                    }
                }
                (true, Err(e)) => panic!("fixture {name}: expected ok, got {}: {}", e.code, e.message),
                (false, Ok(())) => panic!("fixture {name}: expected rejection, got ok"),
            }
        }
    }

    #[test]
    fn helper_predicates() {
        assert!(is_uuid_v4("7d444840-9dc0-41a2-8da8-ff8cb9fca735"));
        assert!(!is_uuid_v4("7D444840-9DC0-41A2-8DA8-FF8CB9FCA735"), "uppercase rejected");
        assert!(!is_uuid_v4("7d444840-9dc0-11a2-8da8-ff8cb9fca735"), "not v4");
        assert!(is_key_id("fik_sample01"));
        assert!(!is_key_id("fik_"));
        assert!(is_canonical_b64("QUJD"));
        assert!(!is_canonical_b64("QUJD "), "whitespace");
        assert!(!is_canonical_b64("QUJDRA=A"), "misplaced padding");
        assert!(!is_canonical_b64("QQ=A"), "non-canonical");
    }
}
