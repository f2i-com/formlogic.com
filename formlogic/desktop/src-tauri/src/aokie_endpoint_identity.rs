//! Desktop-owned Aokie Companion endpoint identity and mutual pairing.
//!
//! The long-lived Ed25519 seed is native-only. On Windows it is kept in
//! Credential Manager; a per-user software key file is the explicitly labelled
//! fallback for platforms/builds without a usable credential store. The seed
//! is never returned by the localhost/Tauri API, written to logs, or sent to
//! FormLogic/custom servers. A package-verified Aokie plugin may receive it
//! once, in memory, through the private `plugin.init` pipe so it can sign the
//! protocol-v2 hello/SDP/ICE envelopes next to the media endpoint.
//!
//! Pairing is possession + owner approval, not a bearer exchange. The QR has
//! only public Desktop identity, app/connection binding, and a one-use expiring
//! challenge. A mobile endpoint signs its response; Desktop validates that
//! proof before showing the fingerprint, and the key does not enter the
//! approved roster until the local owner explicitly approves it.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, TimeZone, Utc};
use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};
use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

/// The single plugin this identity belongs to.
///
/// This module is a SINGLETON: one credential key (`KEY_NAME`), one approved
/// roster (`ROSTER_FILE`), no per-plugin parameter anywhere in its API. So
/// brokering admission for a second plugin would not give that plugin its own
/// identity — it would hand it this one, i.e. Aokie's phone-bridge identity.
/// Naming the owner here keeps the host (not a manifest) the authority on who
/// that is; AOK-303 replaces the constant with a per-plugin identity lookup,
/// and the admission gate then needs no other change.
pub const IDENTITY_OWNER_PLUGIN_ID: &str = "aokie";

const KEY_NAME: &str = "aokie-v2-endpoint-signing-key";
const KEY_FILE: &str = "aokie-v2-endpoint-signing.key";
const ROSTER_FILE: &str = "aokie-mobile-roster-v2.json";
const PAIRING_RESPONSE_DOMAIN: &str = "aokie/v2/mobile-pairing-response";
const ROSTER_DOMAIN: &[u8] = b"aokie/v2/peer-roster\0";
const PAIRING_TTL_SECONDS: u64 = 10 * 60;
const CLOCK_SKEW_SECONDS: u64 = 5;
const MAX_APPROVED_MOBILES: usize = 64;
const MAX_ID_BYTES: usize = 200;

pub type AokieEndpointIdentityHandle = Arc<AokieEndpointIdentity>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointKeyAlgorithm {
    Ed25519,
}

/// Public OKP identity used by `aokie-protocol` v2.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndpointPublicKey {
    pub algorithm: EndpointKeyAlgorithm,
    pub public_key: String,
    pub thumbprint: String,
}

impl EndpointPublicKey {
    fn from_verifying_key(key: &VerifyingKey) -> Self {
        let public_key = URL_SAFE_NO_PAD.encode(key.to_bytes());
        let thumbprint = endpoint_thumbprint(&public_key);
        Self {
            algorithm: EndpointKeyAlgorithm::Ed25519,
            public_key,
            thumbprint,
        }
    }

    fn verifying_key(&self) -> Result<VerifyingKey, String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(&self.public_key)
            .map_err(|_| "endpoint public key is not base64url".to_string())?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "endpoint public key must be 32 bytes".to_string())?;
        let key = VerifyingKey::from_bytes(&bytes)
            .map_err(|_| "endpoint public key is not valid Ed25519".to_string())?;
        safe_id("endpoint key thumbprint", &self.thumbprint)?;
        if self.thumbprint != endpoint_thumbprint(&self.public_key) {
            return Err("endpoint key thumbprint does not match its public key".into());
        }
        Ok(key)
    }

    fn verify(&self, message: &[u8], signature: &str) -> Result<(), String> {
        let key = self.verifying_key()?;
        let bytes = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| "pairing signature is not base64url".to_string())?;
        let bytes: [u8; 64] = bytes
            .try_into()
            .map_err(|_| "pairing signature must be 64 bytes".to_string())?;
        key.verify(message, &Signature::from_bytes(&bytes))
            .map_err(|_| "mobile endpoint signature verification failed".to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyProtection {
    WindowsCredentialManager,
    SoftwareFile,
}

impl KeyProtection {
    pub fn label(self) -> &'static str {
        match self {
            Self::WindowsCredentialManager => "Windows Credential Manager",
            Self::SoftwareFile => "Software key file",
        }
    }
}

/// A locally approved mobile microphone/speaker endpoint. It never represents
/// the handset paired to the Bluetooth dongle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovedMobile {
    pub device_id: String,
    pub display_name: String,
    pub endpoint_key: EndpointPublicKey,
    pub approved_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RevokedMobile {
    device_id: String,
    thumbprint: String,
    revoked_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedRoster {
    schema_version: u16,
    revision: u64,
    roster_hash: String,
    desktop_key_thumbprint: String,
    #[serde(default)]
    keys: Vec<ApprovedMobile>,
    #[serde(default)]
    revoked: Vec<RevokedMobile>,
}

impl PersistedRoster {
    fn empty(desktop_key_thumbprint: &str) -> Self {
        let revision = 1;
        Self {
            schema_version: 2,
            revision,
            roster_hash: peer_roster_hash(revision, &[]),
            desktop_key_thumbprint: desktop_key_thumbprint.to_string(),
            keys: Vec::new(),
            revoked: Vec::new(),
        }
    }

    fn approved_thumbprints(&self) -> Vec<String> {
        let mut values = self
            .keys
            .iter()
            .map(|entry| entry.endpoint_key.thumbprint.clone())
            .collect::<Vec<_>>();
        values.sort();
        values
    }

    fn refresh_hash(&mut self) {
        self.roster_hash = peer_roster_hash(self.revision, &self.approved_thumbprints());
    }

    fn validate(&self, desktop_thumbprint: &str) -> Result<(), String> {
        if self.schema_version != 2 || self.revision == 0 {
            return Err("mobile roster has an unsupported schema/revision".into());
        }
        if self.desktop_key_thumbprint != desktop_thumbprint {
            return Err("mobile roster is bound to a rotated Desktop key".into());
        }
        if self.keys.len() > MAX_APPROVED_MOBILES {
            return Err("mobile roster exceeds the protocol-v2 limit".into());
        }
        let mut device_ids = HashSet::new();
        let mut thumbprints = HashSet::new();
        for entry in &self.keys {
            safe_id("mobile device id", &entry.device_id)?;
            validate_display_name(&entry.display_name)?;
            entry.endpoint_key.verifying_key()?;
            if !device_ids.insert(entry.device_id.as_str())
                || !thumbprints.insert(entry.endpoint_key.thumbprint.as_str())
            {
                return Err("mobile roster contains a duplicate identity".into());
            }
        }
        let expected = peer_roster_hash(self.revision, &self.approved_thumbprints());
        if self.roster_hash != expected {
            return Err("mobile roster hash does not match its revision and keys".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingPayload {
    pub kind: String,
    pub schema_version: u16,
    pub app_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub desktop_connection_id: String,
    pub desktop_endpoint_key: EndpointPublicKey,
    pub nonce: String,
    pub jti: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingOffer {
    pub request_id: String,
    pub payload: PairingPayload,
    pub encoded_payload: String,
    pub qr_svg: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobilePairingClaims {
    pub app_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub desktop_connection_id: String,
    pub desktop_key_thumbprint: String,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub mobile_endpoint_key: EndpointPublicKey,
    pub pairing_nonce: String,
    /// Must equal the one-use JTI in the QR payload.
    pub jti: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

impl MobilePairingClaims {
    fn signing_bytes(&self) -> Result<Vec<u8>, String> {
        domain_separated_canonical(PAIRING_RESPONSE_DOMAIN, self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobilePairingResponse {
    pub kind: String,
    pub schema_version: u16,
    pub claims: MobilePairingClaims,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMobileApproval {
    pub id: String,
    pub device_id: String,
    pub display_name: String,
    pub endpoint_key: EndpointPublicKey,
    pub thumbprint: String,
    pub fingerprint: String,
    pub received_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protection: Option<KeyProtection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protection_label: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_key: Option<EndpointPublicKey>,
    pub roster_revision: u64,
    pub roster_hash: String,
    pub approved_mobiles: Vec<ApprovedMobile>,
    pub pending_approvals: Vec<PendingMobileApproval>,
    pub remote_access_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

struct SecretMaterial {
    signing_key: SigningKey,
    protection: KeyProtection,
}

#[derive(Clone)]
struct Challenge {
    payload: PairingPayload,
}

struct Inner {
    secret: Option<SecretMaterial>,
    roster: PersistedRoster,
    challenges: HashMap<String, Challenge>,
    consumed: HashSet<(String, String)>,
    pending: HashMap<String, PendingMobileApproval>,
    warning: Option<String>,
}

pub struct AokieEndpointIdentity {
    root: PathBuf,
    key_name: String,
    allow_credential_store: bool,
    inner: Mutex<Inner>,
}

impl AokieEndpointIdentity {
    pub fn new(root: PathBuf) -> AokieEndpointIdentityHandle {
        Self::new_with_options(root, KEY_NAME.to_string(), true)
    }

    fn new_with_options(
        root: PathBuf,
        key_name: String,
        allow_credential_store: bool,
    ) -> AokieEndpointIdentityHandle {
        let loaded = load_or_create_secret(&root, &key_name, allow_credential_store);
        let (secret, mut warning) = match loaded {
            Ok(secret) => (Some(secret), None),
            Err(error) => (None, Some(error)),
        };
        let desktop_thumbprint = secret
            .as_ref()
            .map(|secret| {
                EndpointPublicKey::from_verifying_key(&secret.signing_key.verifying_key())
                    .thumbprint
            })
            .unwrap_or_else(|| "unavailable".to_string());
        let (roster, roster_warning) = load_roster(&root, &desktop_thumbprint);
        if let Some(roster_warning) = roster_warning {
            warning = Some(match warning {
                Some(secret_warning) => format!("{secret_warning}; {roster_warning}"),
                None => roster_warning,
            });
        }
        Arc::new(Self {
            root,
            key_name,
            allow_credential_store,
            inner: Mutex::new(Inner {
                secret,
                roster,
                challenges: HashMap::new(),
                consumed: HashSet::new(),
                pending: HashMap::new(),
                warning,
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn status(&self) -> IdentityStatus {
        let inner = self.lock();
        let (endpoint_key, protection) = inner.secret.as_ref().map_or((None, None), |secret| {
            (
                Some(EndpointPublicKey::from_verifying_key(
                    &secret.signing_key.verifying_key(),
                )),
                Some(secret.protection),
            )
        });
        let mut approved_mobiles = inner.roster.keys.clone();
        approved_mobiles.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        let mut pending_approvals = inner.pending.values().cloned().collect::<Vec<_>>();
        pending_approvals.sort_by_key(|entry| entry.received_at);
        IdentityStatus {
            available: inner.secret.is_some(),
            protection,
            protection_label: protection.map(KeyProtection::label),
            endpoint_key,
            roster_revision: inner.roster.revision,
            roster_hash: inner.roster.roster_hash.clone(),
            remote_access_ready: inner.secret.is_some() && !inner.roster.keys.is_empty(),
            approved_mobiles,
            pending_approvals,
            warning: inner.warning.clone(),
        }
    }

    /// Private, memory-only bootstrap for the package-verified Aokie process.
    /// An empty roster deliberately yields `None`: v2 plugin peer policy
    /// requires 1..=64 approved mobile keys and must not be weakened.
    pub(crate) fn private_bootstrap(&self) -> Result<Option<Value>, String> {
        let inner = self.lock();
        let secret = inner
            .secret
            .as_ref()
            .ok_or_else(|| "Aokie Desktop endpoint identity is unavailable".to_string())?;
        if inner.roster.keys.is_empty() {
            return Ok(None);
        }
        let endpoint_key =
            EndpointPublicKey::from_verifying_key(&secret.signing_key.verifying_key());
        let mut keys = inner
            .roster
            .keys
            .iter()
            .map(|entry| entry.endpoint_key.clone())
            .collect::<Vec<_>>();
        keys.sort_by(|left, right| left.thumbprint.cmp(&right.thumbprint));
        Ok(Some(json!({
            "endpointIdentity": {
                "algorithm": "ed25519",
                "publicKey": endpoint_key.public_key,
                "thumbprint": endpoint_key.thumbprint,
                "privateKeySeed": URL_SAFE_NO_PAD.encode(secret.signing_key.to_bytes()),
            },
            "approvedMobileRoster": {
                "revision": inner.roster.revision,
                "rosterHash": inner.roster.roster_hash,
                "keys": keys,
            }
        })))
    }

    /// Exact holder/peer-policy fields sent to an admission issuer. There is
    /// intentionally no secret or signature here; the API key authenticates
    /// the Desktop-to-server request and the issued admission must repeat this
    /// exact public binding.
    pub fn admission_binding(&self) -> Result<Value, String> {
        let inner = self.lock();
        let secret = inner
            .secret
            .as_ref()
            .ok_or_else(|| "Desktop endpoint identity is unavailable".to_string())?;
        if inner.roster.keys.is_empty() {
            return Err("Pair and approve at least one Companion endpoint before requesting remote admission".into());
        }
        let endpoint_key =
            EndpointPublicKey::from_verifying_key(&secret.signing_key.verifying_key());
        let thumbprints = inner.roster.approved_thumbprints();
        Ok(json!({
            "endpointPublicKey": endpoint_key,
            "holderKeyThumbprint": endpoint_key.thumbprint,
            "approvedPeerKeyThumbprints": thumbprints,
            "peerRosterRevision": inner.roster.revision,
            "peerRosterHash": inner.roster.roster_hash,
        }))
    }

    pub fn create_pairing_offer(
        &self,
        app_id: &str,
        workspace_id: Option<&str>,
        desktop_connection_id: &str,
    ) -> Result<PairingOffer, String> {
        self.create_pairing_offer_at(
            app_id,
            workspace_id,
            desktop_connection_id,
            Utc::now().timestamp().max(1) as u64,
        )
    }

    fn create_pairing_offer_at(
        &self,
        app_id: &str,
        workspace_id: Option<&str>,
        desktop_connection_id: &str,
        now: u64,
    ) -> Result<PairingOffer, String> {
        safe_id("app id", app_id)?;
        safe_id("desktop connection id", desktop_connection_id)?;
        if let Some(workspace_id) = workspace_id {
            safe_id("workspace id", workspace_id)?;
        }
        let mut inner = self.lock();
        purge_expired(&mut inner, now);
        let secret = inner
            .secret
            .as_ref()
            .ok_or_else(|| "Desktop endpoint identity is unavailable".to_string())?;
        let nonce = random_id(32)?;
        let jti = format!("pair-{}", uuid::Uuid::new_v4().simple());
        let payload = PairingPayload {
            kind: "aokie_mobile_pairing".into(),
            schema_version: 2,
            app_id: app_id.into(),
            workspace_id: workspace_id.map(str::to_string),
            desktop_connection_id: desktop_connection_id.into(),
            desktop_endpoint_key: EndpointPublicKey::from_verifying_key(
                &secret.signing_key.verifying_key(),
            ),
            nonce: nonce.clone(),
            jti: jti.clone(),
            issued_at: now,
            expires_at: now.saturating_add(PAIRING_TTL_SECONDS),
        };
        let encoded_payload = serde_json::to_string(&payload)
            .map_err(|error| format!("could not encode pairing payload: {error}"))?;
        let code = QrCode::new(encoded_payload.as_bytes())
            .map_err(|_| "pairing payload is too large for a QR code".to_string())?;
        let qr_svg = code
            .render::<svg::Color>()
            .min_dimensions(280, 280)
            .dark_color(svg::Color("#111827"))
            .light_color(svg::Color("#ffffff"))
            .build();
        let request_id = jti.clone();
        inner.challenges.insert(
            nonce,
            Challenge {
                payload: payload.clone(),
            },
        );
        Ok(PairingOffer {
            request_id,
            payload,
            encoded_payload,
            qr_svg,
        })
    }

    pub fn receive_mobile_response(
        &self,
        response: MobilePairingResponse,
    ) -> Result<PendingMobileApproval, String> {
        self.receive_mobile_response_at(response, Utc::now().timestamp().max(1) as u64)
    }

    fn receive_mobile_response_at(
        &self,
        response: MobilePairingResponse,
        now: u64,
    ) -> Result<PendingMobileApproval, String> {
        if response.kind != "aokie_mobile_pairing_response" || response.schema_version != 2 {
            return Err("unsupported mobile pairing response".into());
        }
        let claims = &response.claims;
        safe_id("app id", &claims.app_id)?;
        safe_id("desktop connection id", &claims.desktop_connection_id)?;
        safe_id("desktop key thumbprint", &claims.desktop_key_thumbprint)?;
        safe_id("mobile device id", &claims.device_id)?;
        safe_id("pairing nonce", &claims.pairing_nonce)?;
        safe_id("pairing jti", &claims.jti)?;
        if let Some(workspace_id) = claims.workspace_id.as_deref() {
            safe_id("workspace id", workspace_id)?;
        }
        let display_name = claims
            .display_name
            .as_deref()
            .unwrap_or("Aokie Companion")
            .trim()
            .to_string();
        validate_display_name(&display_name)?;
        claims.mobile_endpoint_key.verifying_key()?;
        if claims.issued_at > now.saturating_add(CLOCK_SKEW_SECONDS)
            || claims.expires_at <= now
            || claims.expires_at <= claims.issued_at
            || claims.expires_at.saturating_sub(claims.issued_at) > PAIRING_TTL_SECONDS
        {
            return Err("mobile pairing response is expired or has an invalid lifetime".into());
        }

        let mut inner = self.lock();
        purge_expired(&mut inner, now);
        if inner
            .consumed
            .contains(&(claims.pairing_nonce.clone(), claims.jti.clone()))
        {
            return Err("pairing challenge was already used".into());
        }
        let challenge = inner
            .challenges
            .get(&claims.pairing_nonce)
            .ok_or_else(|| "pairing challenge is unknown or expired".to_string())?
            .clone();
        let expected = &challenge.payload;
        if claims.jti != expected.jti {
            return Err("pairing response JTI does not match the one-use request".into());
        }
        if claims.app_id != expected.app_id || claims.workspace_id != expected.workspace_id {
            return Err("pairing response is for a different app/workspace".into());
        }
        if claims.desktop_connection_id != expected.desktop_connection_id
            || claims.desktop_key_thumbprint != expected.desktop_endpoint_key.thumbprint
        {
            return Err("pairing response is for a different Desktop endpoint".into());
        }
        if claims.issued_at.saturating_add(CLOCK_SKEW_SECONDS) < expected.issued_at
            || claims.expires_at > expected.expires_at
        {
            return Err("pairing response is outside the Desktop challenge window".into());
        }
        if inner.roster.keys.iter().any(|entry| {
            entry.device_id == claims.device_id
                || entry.endpoint_key.thumbprint == claims.mobile_endpoint_key.thumbprint
        }) {
            return Err(
                "this mobile endpoint is already approved; revoke it before fresh re-pairing"
                    .into(),
            );
        }
        claims
            .mobile_endpoint_key
            .verify(&claims.signing_bytes()?, &response.signature)?;

        let id = format!("approval-{}", uuid::Uuid::new_v4().simple());
        let received_at = Utc
            .timestamp_opt(now as i64, 0)
            .single()
            .unwrap_or_else(Utc::now);
        let pending = PendingMobileApproval {
            id: id.clone(),
            device_id: claims.device_id.clone(),
            display_name,
            endpoint_key: claims.mobile_endpoint_key.clone(),
            thumbprint: claims.mobile_endpoint_key.thumbprint.clone(),
            fingerprint: display_fingerprint(&claims.mobile_endpoint_key)?,
            received_at,
        };
        inner.challenges.remove(&claims.pairing_nonce);
        inner
            .consumed
            .insert((claims.pairing_nonce.clone(), claims.jti.clone()));
        inner.pending.insert(id, pending.clone());
        Ok(pending)
    }

    pub fn approve_mobile(&self, pending_id: &str) -> Result<ApprovedMobile, String> {
        let mut inner = self.lock();
        let pending = inner
            .pending
            .get(pending_id)
            .cloned()
            .ok_or_else(|| "pending mobile approval was not found".to_string())?;
        if inner.roster.keys.len() >= MAX_APPROVED_MOBILES {
            return Err("the protocol-v2 mobile roster is full".into());
        }
        if inner.roster.keys.iter().any(|entry| {
            entry.device_id == pending.device_id
                || entry.endpoint_key.thumbprint == pending.endpoint_key.thumbprint
        }) {
            return Err("this mobile endpoint is already approved".into());
        }
        let approved = ApprovedMobile {
            device_id: pending.device_id,
            display_name: pending.display_name,
            endpoint_key: pending.endpoint_key,
            approved_at: Utc::now(),
        };
        let mut next_roster = inner.roster.clone();
        next_roster.keys.push(approved.clone());
        next_roster.keys.sort_by(|left, right| {
            left.endpoint_key
                .thumbprint
                .cmp(&right.endpoint_key.thumbprint)
        });
        bump_roster(&mut next_roster);
        persist_roster(&self.root, &next_roster)?;
        inner.roster = next_roster;
        inner.pending.remove(pending_id);
        Ok(approved)
    }

    pub fn deny_mobile(&self, pending_id: &str) -> Result<(), String> {
        let removed = self.lock().pending.remove(pending_id);
        removed
            .map(|_| ())
            .ok_or_else(|| "pending mobile approval was not found".to_string())
    }

    pub fn revoke_mobile(&self, thumbprint: &str) -> Result<(), String> {
        let mut inner = self.lock();
        let mut next_roster = inner.roster.clone();
        let index = next_roster
            .keys
            .iter()
            .position(|entry| entry.endpoint_key.thumbprint == thumbprint)
            .ok_or_else(|| "approved mobile endpoint was not found".to_string())?;
        let removed = next_roster.keys.remove(index);
        next_roster.revoked.push(RevokedMobile {
            device_id: removed.device_id,
            thumbprint: removed.endpoint_key.thumbprint,
            revoked_at: Utc::now(),
        });
        if next_roster.revoked.len() > 256 {
            let excess = next_roster.revoked.len() - 256;
            next_roster.revoked.drain(..excess);
        }
        bump_roster(&mut next_roster);
        persist_roster(&self.root, &next_roster)?;
        inner.roster = next_roster;
        Ok(())
    }

    /// Rotate the Desktop endpoint key and require every mobile to fresh-pair.
    /// No unsigned old->new substitution is accepted. Until a shared
    /// bidirectional cross-sign rotation object exists in `aokie-protocol`, a
    /// fresh owner ceremony is the only supported rotation path.
    pub fn rotate_identity_and_require_fresh_pairing(&self) -> Result<IdentityStatus, String> {
        let secret =
            create_and_store_secret(&self.root, &self.key_name, self.allow_credential_store)?;
        let endpoint_key =
            EndpointPublicKey::from_verifying_key(&secret.signing_key.verifying_key());
        let mut inner = self.lock();
        inner.secret = Some(secret);
        inner.challenges.clear();
        inner.pending.clear();
        let removed_keys = inner.roster.keys.drain(..).collect::<Vec<_>>();
        for removed in removed_keys {
            inner.roster.revoked.push(RevokedMobile {
                device_id: removed.device_id,
                thumbprint: removed.endpoint_key.thumbprint,
                revoked_at: Utc::now(),
            });
        }
        inner.roster.desktop_key_thumbprint = endpoint_key.thumbprint;
        bump_roster(&mut inner.roster);
        persist_roster(&self.root, &inner.roster)?;
        drop(inner);
        Ok(self.status())
    }
}

fn load_or_create_secret(
    root: &Path,
    key_name: &str,
    allow_credential_store: bool,
) -> Result<SecretMaterial, String> {
    if allow_credential_store && crate::secrets::available() {
        match crate::secrets::get(key_name) {
            Ok(Some(encoded)) => match decode_signing_key(&encoded) {
                Ok(signing_key) => {
                    return Ok(SecretMaterial {
                        signing_key,
                        protection: KeyProtection::WindowsCredentialManager,
                    })
                }
                Err(_) => log::warn!(
                    "Aokie endpoint key in Credential Manager is malformed; rotating it"
                ),
            },
            Ok(None) => {}
            Err(error) => log::warn!(
                "Aokie endpoint key could not be read from Credential Manager ({error}); trying the labelled software fallback"
            ),
        }
    }
    let path = root.join(KEY_FILE);
    if let Ok(encoded) = std::fs::read_to_string(&path) {
        if let Ok(signing_key) = decode_signing_key(encoded.trim()) {
            return Ok(SecretMaterial {
                signing_key,
                protection: KeyProtection::SoftwareFile,
            });
        }
        log::warn!("Aokie software endpoint key is malformed; rotating it");
    }
    create_and_store_secret(root, key_name, allow_credential_store)
}

fn create_and_store_secret(
    root: &Path,
    key_name: &str,
    allow_credential_store: bool,
) -> Result<SecretMaterial, String> {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|_| "OS randomness is unavailable".to_string())?;
    let signing_key = SigningKey::from_bytes(&seed);
    let encoded = URL_SAFE_NO_PAD.encode(seed);
    if allow_credential_store && crate::secrets::available() {
        match crate::secrets::store_verified(key_name, &encoded) {
            Ok(true) => {
                let _ = std::fs::remove_file(root.join(KEY_FILE));
                return Ok(SecretMaterial {
                    signing_key,
                    protection: KeyProtection::WindowsCredentialManager,
                });
            }
            Ok(false) => {}
            Err(error) => log::warn!(
                "Aokie endpoint key could not be stored in Credential Manager ({error}); using the labelled software fallback"
            ),
        }
    }
    std::fs::create_dir_all(root)
        .map_err(|error| format!("could not create Aokie identity directory: {error}"))?;
    let path = root.join(KEY_FILE);
    write_private_file(&path, encoded.as_bytes())?;
    Ok(SecretMaterial {
        signing_key,
        protection: KeyProtection::SoftwareFile,
    })
}

fn decode_signing_key(encoded: &str) -> Result<SigningKey, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded.trim())
        .map_err(|_| "endpoint seed is not base64url".to_string())?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "endpoint seed must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&bytes))
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes)
        .map_err(|error| format!("could not write Aokie software endpoint key: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("could not restrict Aokie software endpoint key: {error}"))?;
    }
    Ok(())
}

fn load_roster(root: &Path, desktop_thumbprint: &str) -> (PersistedRoster, Option<String>) {
    let path = root.join(ROSTER_FILE);
    let backup = root.join(format!("{ROSTER_FILE}.bak"));
    let loaded = [&path, &backup].into_iter().find_map(|candidate| {
        std::fs::read_to_string(candidate)
            .ok()
            .and_then(|text| serde_json::from_str::<PersistedRoster>(&text).ok())
    });
    match loaded {
        Some(mut roster) => match roster.validate(desktop_thumbprint) {
            Ok(()) => (roster, None),
            Err(error) => {
                let next = roster.revision.saturating_add(1).max(1);
                roster.keys.clear();
                roster.revision = next;
                roster.desktop_key_thumbprint = desktop_thumbprint.into();
                roster.refresh_hash();
                let _ = persist_roster(root, &roster);
                (
                    roster,
                    Some(format!(
                        "{error}; remote Companion access was cleared and requires fresh pairing"
                    )),
                )
            }
        },
        None => {
            let roster = PersistedRoster::empty(desktop_thumbprint);
            let warning = persist_roster(root, &roster).err();
            (roster, warning)
        }
    }
}

fn persist_roster(root: &Path, roster: &PersistedRoster) -> Result<(), String> {
    std::fs::create_dir_all(root)
        .map_err(|error| format!("could not create Aokie roster directory: {error}"))?;
    let path = root.join(ROSTER_FILE);
    let temp = root.join(format!(
        "{ROSTER_FILE}.tmp-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let backup = root.join(format!("{ROSTER_FILE}.bak"));
    let bytes = serde_json::to_vec_pretty(roster)
        .map_err(|error| format!("could not serialize Aokie mobile roster: {error}"))?;
    std::fs::write(&temp, bytes)
        .map_err(|error| format!("could not write Aokie mobile roster: {error}"))?;
    let _ = std::fs::remove_file(&backup);
    if path.exists() {
        std::fs::rename(&path, &backup)
            .map_err(|error| format!("could not back up Aokie mobile roster: {error}"))?;
    }
    if let Err(error) = std::fs::rename(&temp, &path) {
        let _ = std::fs::rename(&backup, &path);
        let _ = std::fs::remove_file(&temp);
        return Err(format!("could not replace Aokie mobile roster: {error}"));
    }
    let _ = std::fs::remove_file(&backup);
    Ok(())
}

fn bump_roster(roster: &mut PersistedRoster) {
    roster.revision = roster.revision.saturating_add(1).max(1);
    roster.refresh_hash();
}

fn purge_expired(inner: &mut Inner, now: u64) {
    inner
        .challenges
        .retain(|_, challenge| challenge.payload.expires_at > now);
    // Replay memory is bounded by the number of still-pending ceremonies.
    if inner.consumed.len() > 512 {
        inner.consumed.clear();
    }
}

fn random_id(bytes: usize) -> Result<String, String> {
    let mut value = vec![0u8; bytes];
    getrandom::getrandom(&mut value).map_err(|_| "OS randomness is unavailable".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

fn validate_display_name(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 120 || value.chars().any(char::is_control) {
        Err("mobile display name must be 1-120 printable characters".into())
    } else {
        Ok(())
    }
}

fn safe_id(field: &str, value: &str) -> Result<(), String> {
    if !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        Ok(())
    } else {
        Err(format!("{field} is not a safe protocol identifier"))
    }
}

fn endpoint_thumbprint(public_key: &str) -> String {
    let canonical = format!(
        "{{\"crv\":\"Ed25519\",\"kty\":\"OKP\",\"x\":{}}}",
        serde_json::to_string(public_key).expect("string serialization cannot fail")
    );
    URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes()))
}

pub fn peer_roster_hash(revision: u64, thumbprints: &[String]) -> String {
    let mut sorted = thumbprints.to_vec();
    sorted.sort();
    let payload = json!({
        "approvedPeerKeyThumbprints": sorted,
        "peerRosterRevision": revision,
    });
    let canonical = canonical_json_value(&payload).expect("bounded roster JSON is canonicalizable");
    let mut message = ROSTER_DOMAIN.to_vec();
    message.extend_from_slice(&canonical);
    URL_SAFE_NO_PAD.encode(Sha256::digest(message))
}

fn display_fingerprint(key: &EndpointPublicKey) -> Result<String, String> {
    let bytes = key.verifying_key()?.to_bytes();
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(64 + 15);
    for (index, byte) in digest.iter().enumerate() {
        if index > 0 && index % 2 == 0 {
            encoded.push(':');
        }
        let _ = write!(encoded, "{byte:02X}");
    }
    Ok(encoded)
}

fn domain_separated_canonical<T: Serialize>(domain: &str, value: &T) -> Result<Vec<u8>, String> {
    let value = serde_json::to_value(value)
        .map_err(|error| format!("could not serialize signed claims: {error}"))?;
    let mut bytes = domain.as_bytes().to_vec();
    bytes.push(0);
    bytes.extend_from_slice(&canonical_json_value(&value)?);
    Ok(bytes)
}

/// Deterministic UTF-8 JSON matching the protocol-v2 canonicalizer.
fn canonical_json_value(value: &Value) -> Result<Vec<u8>, String> {
    fn write_value(value: &Value, output: &mut Vec<u8>) -> Result<(), String> {
        match value {
            Value::Null => output.extend_from_slice(b"null"),
            Value::Bool(true) => output.extend_from_slice(b"true"),
            Value::Bool(false) => output.extend_from_slice(b"false"),
            Value::Number(number) => {
                if !number.is_u64() && !number.is_i64() {
                    return Err("signed payload cannot contain floating-point numbers".into());
                }
                output.extend_from_slice(number.to_string().as_bytes());
            }
            Value::String(text) => output.extend_from_slice(
                serde_json::to_string(text)
                    .map_err(|error| format!("could not canonicalize signed string: {error}"))?
                    .as_bytes(),
            ),
            Value::Array(values) => {
                output.push(b'[');
                for (index, item) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(b',');
                    }
                    write_value(item, output)?;
                }
                output.push(b']');
            }
            Value::Object(values) => {
                output.push(b'{');
                let mut keys = values.keys().collect::<Vec<_>>();
                keys.sort();
                for (index, key) in keys.iter().enumerate() {
                    if index > 0 {
                        output.push(b',');
                    }
                    output.extend_from_slice(
                        serde_json::to_string(key)
                            .map_err(|error| format!("could not canonicalize signed key: {error}"))?
                            .as_bytes(),
                    );
                    output.push(b':');
                    write_value(&values[*key], output)?;
                }
                output.push(b'}');
            }
        }
        Ok(())
    }

    let mut output = Vec::new();
    write_value(value, &mut output)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "fl-aokie-identity-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn software_store(path: &Path) -> AokieEndpointIdentityHandle {
        AokieEndpointIdentity::new_with_options(
            path.to_path_buf(),
            format!("test-aokie-{}", uuid::Uuid::new_v4().simple()),
            false,
        )
    }

    fn response_for(
        offer: &PairingOffer,
        mobile: &SigningKey,
        device_id: &str,
        now: u64,
    ) -> MobilePairingResponse {
        let claims = MobilePairingClaims {
            app_id: offer.payload.app_id.clone(),
            workspace_id: offer.payload.workspace_id.clone(),
            desktop_connection_id: offer.payload.desktop_connection_id.clone(),
            desktop_key_thumbprint: offer.payload.desktop_endpoint_key.thumbprint.clone(),
            device_id: device_id.into(),
            display_name: Some("Reception desk".into()),
            mobile_endpoint_key: EndpointPublicKey::from_verifying_key(&mobile.verifying_key()),
            pairing_nonce: offer.payload.nonce.clone(),
            jti: offer.payload.jti.clone(),
            issued_at: now,
            expires_at: now + 120,
        };
        let signature =
            URL_SAFE_NO_PAD.encode(mobile.sign(&claims.signing_bytes().unwrap()).to_bytes());
        MobilePairingResponse {
            kind: "aokie_mobile_pairing_response".into(),
            schema_version: 2,
            claims,
            signature,
        }
    }

    #[test]
    fn restart_preserves_software_identity_and_approved_roster() {
        let dir = temp_dir("restart");
        let first = software_store(&dir);
        let first_status = first.status();
        assert_eq!(first_status.protection, Some(KeyProtection::SoftwareFile));
        let offer = first
            .create_pairing_offer_at("app-a", Some("workspace-a"), "desktop-a", 1_000)
            .unwrap();
        let mobile = SigningKey::from_bytes(&[7u8; 32]);
        let pending = first
            .receive_mobile_response_at(response_for(&offer, &mobile, "mobile-a", 1_010), 1_010)
            .unwrap();
        first.approve_mobile(&pending.id).unwrap();
        let revision = first.status().roster_revision;
        let thumbprint = first.status().endpoint_key.unwrap().thumbprint;
        drop(first);

        let second = AokieEndpointIdentity::new_with_options(
            dir.clone(),
            "another-unused-test-key-name".into(),
            false,
        );
        let status = second.status();
        assert_eq!(status.endpoint_key.unwrap().thumbprint, thumbprint);
        assert_eq!(status.roster_revision, revision);
        assert_eq!(status.approved_mobiles.len(), 1);
        assert!(status.remote_access_ready);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn public_surfaces_never_contain_the_private_seed() {
        let dir = temp_dir("no-secret");
        let store = software_store(&dir);
        let seed = {
            let inner = store.lock();
            URL_SAFE_NO_PAD.encode(inner.secret.as_ref().unwrap().signing_key.to_bytes())
        };
        let status = serde_json::to_string(&store.status()).unwrap();
        let offer = store
            .create_pairing_offer_at("app-a", None, "desktop-a", 10_000)
            .unwrap();
        let offer_json = serde_json::to_string(&offer).unwrap();
        assert!(!status.contains(&seed));
        assert!(!offer_json.contains(&seed));
        assert!(!format!("{:?}", store.status()).contains(&seed));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn nonce_replay_wrong_app_and_wrong_desktop_are_rejected() {
        let dir = temp_dir("binding");
        let store = software_store(&dir);
        let mobile = SigningKey::from_bytes(&[8u8; 32]);

        let wrong_app_offer = store
            .create_pairing_offer_at("app-a", None, "desktop-a", 20_000)
            .unwrap();
        let mut wrong_app = response_for(&wrong_app_offer, &mobile, "mobile-a", 20_010);
        wrong_app.claims.app_id = "app-b".into();
        wrong_app.signature = URL_SAFE_NO_PAD.encode(
            mobile
                .sign(&wrong_app.claims.signing_bytes().unwrap())
                .to_bytes(),
        );
        assert!(store
            .receive_mobile_response_at(wrong_app, 20_010)
            .unwrap_err()
            .contains("different app"));

        let wrong_desktop_offer = store
            .create_pairing_offer_at("app-a", None, "desktop-a", 20_100)
            .unwrap();
        let mut wrong_desktop = response_for(&wrong_desktop_offer, &mobile, "mobile-a", 20_110);
        wrong_desktop.claims.desktop_connection_id = "desktop-b".into();
        wrong_desktop.signature = URL_SAFE_NO_PAD.encode(
            mobile
                .sign(&wrong_desktop.claims.signing_bytes().unwrap())
                .to_bytes(),
        );
        assert!(store
            .receive_mobile_response_at(wrong_desktop, 20_110)
            .unwrap_err()
            .contains("different Desktop"));

        let offer = store
            .create_pairing_offer_at("app-a", None, "desktop-a", 20_200)
            .unwrap();
        let valid = response_for(&offer, &mobile, "mobile-a", 20_210);
        store
            .receive_mobile_response_at(valid.clone(), 20_210)
            .unwrap();
        assert!(store
            .receive_mobile_response_at(valid, 20_211)
            .unwrap_err()
            .contains("already used"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mobile_is_unapproved_until_local_owner_accepts_and_revision_hash_advance() {
        let dir = temp_dir("approval");
        let store = software_store(&dir);
        assert!(store.private_bootstrap().unwrap().is_none());
        assert!(store.admission_binding().is_err());
        let before = store.status();
        let offer = store
            .create_pairing_offer_at("app-a", None, "desktop-a", 30_000)
            .unwrap();
        let mobile = SigningKey::from_bytes(&[9u8; 32]);
        let pending = store
            .receive_mobile_response_at(response_for(&offer, &mobile, "mobile-a", 30_010), 30_010)
            .unwrap();
        assert!(store.status().approved_mobiles.is_empty());
        assert_eq!(store.status().pending_approvals.len(), 1);

        let approved = store.approve_mobile(&pending.id).unwrap();
        let after_approve = store.status();
        assert_eq!(after_approve.roster_revision, before.roster_revision + 1);
        assert_eq!(after_approve.approved_mobiles.len(), 1);
        assert_eq!(
            after_approve.roster_hash,
            peer_roster_hash(
                after_approve.roster_revision,
                &[approved.endpoint_key.thumbprint.clone()]
            )
        );
        let binding = store.admission_binding().unwrap();
        assert_eq!(binding["peerRosterRevision"], after_approve.roster_revision);
        assert_eq!(binding["peerRosterHash"], after_approve.roster_hash);
        let bootstrap = store.private_bootstrap().unwrap().unwrap();
        let endpoint_identity = bootstrap["endpointIdentity"]
            .as_object()
            .expect("private endpoint identity is an object");
        assert_eq!(endpoint_identity.len(), 4);
        assert_eq!(endpoint_identity["algorithm"], "ed25519");
        assert!(endpoint_identity.contains_key("publicKey"));
        assert!(endpoint_identity.contains_key("thumbprint"));
        assert!(endpoint_identity.contains_key("privateKeySeed"));

        store
            .revoke_mobile(&approved.endpoint_key.thumbprint)
            .unwrap();
        let after_revoke = store.status();
        assert_eq!(
            after_revoke.roster_revision,
            after_approve.roster_revision + 1
        );
        assert_eq!(
            after_revoke.roster_hash,
            peer_roster_hash(after_revoke.roster_revision, &[])
        );
        assert!(!after_revoke.remote_access_ready);
        assert!(store.admission_binding().is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn desktop_rotation_changes_key_and_requires_fresh_pairing() {
        let dir = temp_dir("rotate");
        let store = software_store(&dir);
        let old_thumbprint = store.status().endpoint_key.unwrap().thumbprint;
        let old_revision = store.status().roster_revision;
        let status = store.rotate_identity_and_require_fresh_pairing().unwrap();
        assert_ne!(status.endpoint_key.unwrap().thumbprint, old_thumbprint);
        assert!(status.approved_mobiles.is_empty());
        assert!(status.roster_revision > old_revision);
        assert!(!status.remote_access_ready);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_credential_manager_identity_survives_restart() {
        // Serialized with every other credential-store test: parallel
        // hammering of Credential Manager can transiently miss a fresh read,
        // which this identity path answers by minting a new key (observed as
        // a thumbprint mismatch here under full-suite load).
        let _cred = crate::data::test_cred_lock();
        let dir = temp_dir("wincred");
        let key_name = format!("test-aokie-endpoint-{}", uuid::Uuid::new_v4().simple());
        let first = AokieEndpointIdentity::new_with_options(dir.clone(), key_name.clone(), true);
        assert_eq!(
            first.status().protection,
            Some(KeyProtection::WindowsCredentialManager)
        );
        let thumbprint = first.status().endpoint_key.unwrap().thumbprint;
        drop(first);
        let second = AokieEndpointIdentity::new_with_options(dir.clone(), key_name.clone(), true);
        assert_eq!(second.status().endpoint_key.unwrap().thumbprint, thumbprint);
        crate::secrets::delete(&key_name).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
