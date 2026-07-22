//! flcanon/1 — RFC 8785 (JCS) restricted to an integer-only subset, plus the
//! domain-separated signing preimages for the data-nodes protocol
//! (docs/FORMLOGIC_DATA_NODES.md §1-§3).
//!
//! Mirrored byte-for-byte by ui/src/lib/data/canonical.ts and
//! backend/src/Support/DataCanonicalJson.php; all three assert
//! docs/contracts/data-sync-vectors.json. Any rule change is a protocol
//! version bump, not an edit.
//!
//! Verification never re-parses leniently: a verifier parses received bytes,
//! re-serializes with flcanon/1, and requires byte equality — which inherently
//! rejects duplicate keys, floats, -0, exponent forms, and whitespace variants.
//! (The store additionally uses [`super::strict_json`] for envelope input.)

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Frozen signing/hash domains (docs/FORMLOGIC_DATA_NODES.md §2).
pub const DOMAIN_PLACEMENT: &str = "flplacement:1";
pub const DOMAIN_OPERATION: &str = "flop:1";
pub const DOMAIN_CHECKPOINT: &str = "flcheckpoint:1";
pub const DOMAIN_BACKUP: &str = "flbackup:1";
pub const DOMAIN_NODE_CERT: &str = "flnodecert:1";
pub const DOMAIN_LOGICAL_ROOT: &str = "flroot:1";
pub const DOMAIN_HIGH_WATER: &str = "flhw:1";

pub const DATA_PROTOCOL: &str = "formlogic-data-sync/1";

const MAX_SAFE_INT: i64 = 9_007_199_254_740_991; // 2^53 - 1
const MAX_DEPTH: usize = 64;

/// flcanon/1 serialization of any canonical value.
pub fn canonicalize(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    serialize(value, 0, &mut out)?;
    Ok(out)
}

fn serialize(value: &Value, depth: usize, out: &mut String) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("canonical_invalid: nesting too deep".into());
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => {
            let i = if let Some(i) = n.as_i64() {
                i
            } else if let Some(u) = n.as_u64() {
                i64::try_from(u).map_err(|_| "canonical_invalid: integer beyond 2^53-1")?
            } else {
                return Err("canonical_invalid: non-integer number".into());
            };
            if !(-MAX_SAFE_INT..=MAX_SAFE_INT).contains(&i) {
                return Err("canonical_invalid: integer beyond 2^53-1".into());
            }
            out.push_str(&i.to_string());
        }
        Value::String(s) => escape_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                serialize(item, depth + 1, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // JCS key ordering = UTF-16 code units (differs from code-point
            // order for non-BMP keys), regardless of map iteration order.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (idx, key) in keys.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                escape_string(key, out);
                out.push(':');
                serialize(&map[key.as_str()], depth + 1, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// JCS string escaping: the five short escapes + `\"` `\\`, `\u00xx` lowercase
/// for other C0 controls, raw UTF-8 elsewhere. Rust strings cannot hold lone
/// surrogates, so no extra check is needed here.
fn escape_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// preimage = ASCII(domain) || 0x0A || flcanon(structure). Top level must be an object.
pub fn signing_preimage(domain: &str, structure: &Value) -> Result<Vec<u8>, String> {
    if !structure.is_object() {
        return Err("canonical_invalid: signed structures must be objects".into());
    }
    let canonical = canonicalize(structure)?;
    let mut out = Vec::with_capacity(domain.len() + 1 + canonical.len());
    out.extend_from_slice(domain.as_bytes());
    out.push(0x0a);
    out.extend_from_slice(canonical.as_bytes());
    Ok(out)
}

/// SHA-256 lowercase hex over the domain-separated preimage.
pub fn domain_hash_hex(domain: &str, structure: &Value) -> Result<String, String> {
    Ok(hex_lower(&Sha256::digest(signing_preimage(domain, structure)?)))
}

fn without_signature(structure: &Value) -> Value {
    let mut clone = structure.clone();
    if let Some(map) = clone.as_object_mut() {
        map.remove("signature");
    }
    clone
}

/// Ed25519 detached signature (base64, padded) over the preimage of the
/// structure WITHOUT its `signature` field.
pub fn sign_structure_b64(
    domain: &str,
    structure: &Value,
    signing_key: &SigningKey,
) -> Result<String, String> {
    let preimage = signing_preimage(domain, &without_signature(structure))?;
    Ok(B64.encode(signing_key.sign(&preimage).to_bytes()))
}

/// Verify a signed structure's `signature` field against the domain preimage.
/// `verify_strict` matches libsodium's `crypto_sign_verify_detached` posture.
pub fn verify_structure(domain: &str, structure: &Value, public_key: &VerifyingKey) -> bool {
    let Some(sig_b64) = structure.get("signature").and_then(Value::as_str) else {
        return false;
    };
    let Ok(raw) = B64.decode(sig_b64) else {
        return false;
    };
    let Ok(sig_bytes) = <[u8; 64]>::try_from(raw.as_slice()) else {
        return false;
    };
    let Ok(preimage) = signing_preimage(domain, &without_signature(structure)) else {
        return false;
    };
    public_key
        .verify_strict(&preimage, &Signature::from_bytes(&sig_bytes))
        .is_ok()
}

/// keyId = first 16 hex of SHA-256(raw pk) (docs/FORMLOGIC_DATA_NODES.md §2).
pub fn data_key_id(public_key: &VerifyingKey) -> String {
    hex_lower(&Sha256::digest(public_key.as_bytes()))[..16].to_string()
}

pub fn data_key_fingerprint(public_key: &VerifyingKey) -> String {
    hex_lower(&Sha256::digest(public_key.as_bytes()))
}

/// v1 logical root (docs/FORMLOGIC_DATA_NODES.md §3): entries sorted by the
/// UTF-8 bytes of their flcanon serialization (memcmp), hashed under flroot:1.
pub fn logical_root_hex(dataset_id: &str, entries: &[Value]) -> Result<String, String> {
    let mut pairs: Vec<(String, &Value)> = Vec::with_capacity(entries.len());
    for entry in entries {
        pairs.push((canonicalize(entry)?, entry));
    }
    pairs.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let body = serde_json::json!({
        "v": 1,
        "datasetId": dataset_id,
        "entries": pairs.iter().map(|(_, e)| (*e).clone()).collect::<Vec<Value>>(),
    });
    domain_hash_hex(DOMAIN_LOGICAL_ROOT, &body)
}

pub fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn vectors() -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/contracts/data-sync-vectors.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("vector file missing at {}: {e}", path.display()));
        serde_json::from_str(&raw).expect("vector file parses")
    }

    fn signing_key_from_seed_hex(seed_hex: &str) -> SigningKey {
        let seed: [u8; 32] = hex_decode(seed_hex)
            .expect("seed hex")
            .try_into()
            .expect("32-byte seed");
        SigningKey::from_bytes(&seed)
    }

    #[test]
    fn canonicalize_vectors_match_byte_for_byte() {
        let v = vectors();
        let cases = v["canonicalize"].as_array().expect("canonicalize cases");
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let parsed: Value = serde_json::from_str(case["json"].as_str().unwrap()).unwrap();
            assert_eq!(
                canonicalize(&parsed).unwrap(),
                case["canonical"].as_str().unwrap(),
                "vector {name}"
            );
        }
    }

    #[test]
    fn reject_vectors_never_verify_as_canonical_bytes() {
        let v = vectors();
        for case in v["reject"].as_array().expect("reject cases") {
            let name = case["name"].as_str().unwrap();
            let raw = case["json"].as_str().unwrap();
            // Uniform protocol property: the bytes must NOT round-trip as
            // canonical (parse failure, serializer rejection, or byte drift).
            let verifies = match serde_json::from_str::<Value>(raw) {
                Ok(parsed) => canonicalize(&parsed).map(|c| c == raw).unwrap_or(false),
                Err(_) => false,
            };
            assert!(!verifies, "reject vector {name} must not verify");
            // The strict parser must also refuse structural invalidity where
            // it applies (duplicate keys).
            if name == "duplicate-key" {
                assert!(super::super::strict_json::parse(raw.as_bytes()).is_err());
            }
        }
    }

    #[test]
    fn domain_hash_vectors_match() {
        let v = vectors();
        for case in v["hashes"].as_array().expect("hash cases") {
            let parsed: Value = serde_json::from_str(case["json"].as_str().unwrap()).unwrap();
            assert_eq!(
                domain_hash_hex(case["domain"].as_str().unwrap(), &parsed).unwrap(),
                case["sha256"].as_str().unwrap(),
                "vector {}",
                case["name"]
            );
        }
    }

    #[test]
    fn ed25519_identity_signatures_and_domain_separation() {
        let v = vectors();
        let ed = &v["ed25519"];
        let sk = signing_key_from_seed_hex(ed["seed_hex"].as_str().unwrap());
        let pk = sk.verifying_key();
        assert_eq!(B64.encode(pk.as_bytes()), ed["public_key_b64"].as_str().unwrap());
        assert_eq!(data_key_id(&pk), ed["key_id"].as_str().unwrap());
        assert_eq!(data_key_fingerprint(&pk), ed["fingerprint"].as_str().unwrap());

        let sigs = ed["signatures"].as_array().expect("signatures");
        assert!(!sigs.is_empty());
        for case in sigs {
            let name = case["name"].as_str().unwrap();
            let domain = case["domain"].as_str().unwrap();
            let structure: Value = serde_json::from_str(case["json"].as_str().unwrap()).unwrap();
            let expected = case["signature_b64"].as_str().unwrap();
            assert_eq!(
                sign_structure_b64(domain, &structure, &sk).unwrap(),
                expected,
                "vector {name}"
            );
            let mut signed = structure.clone();
            signed["signature"] = json!(expected);
            assert!(verify_structure(domain, &signed, &pk), "{name} verifies");
            let other = if domain == DOMAIN_OPERATION {
                DOMAIN_CHECKPOINT
            } else {
                DOMAIN_OPERATION
            };
            assert!(!verify_structure(other, &signed, &pk), "{name} cross-domain");
            let mut tampered = signed.clone();
            tampered["sequence"] = json!(999_999);
            assert!(!verify_structure(domain, &tampered, &pk), "{name} tampered");
        }
    }

    #[test]
    fn logical_root_vectors_match() {
        let v = vectors();
        for case in v["logical_roots"].as_array().expect("root cases") {
            let entries = case["entries"].as_array().unwrap().clone();
            assert_eq!(
                logical_root_hex(case["dataset_id"].as_str().unwrap(), &entries).unwrap(),
                case["root_hex"].as_str().unwrap(),
                "vector {}",
                case["name"]
            );
        }
    }

    #[test]
    fn serializer_rejects_floats_and_preimage_requires_object() {
        assert!(canonicalize(&json!(1.5)).is_err());
        assert!(canonicalize(&json!(9_007_199_254_740_992i64)).is_err());
        assert!(signing_preimage(DOMAIN_OPERATION, &json!([1, 2])).is_err());
        let preimage = signing_preimage(DOMAIN_OPERATION, &json!({"a": 1})).unwrap();
        assert_eq!(preimage, b"flop:1\n{\"a\":1}");
    }
}
