//! Plugin manifest — parse + validate `manifest.json` per
//! `docs/contracts/plugin-manifest.schema.json` (canonical copy in
//! `formlogic-app/docs/contracts/`).
//!
//! Validation is deliberately hand-rolled (no jsonschema/regex crates): the
//! schema is small and frozen, and hand-rolled checks give the rich,
//! field-specific error messages the SDK contract requires ("invalid manifests
//! surface as an errored install, never a silent skip").

use serde::{Deserialize, Serialize};

/// `manifest.json` at the root of a plugin directory. `deny_unknown_fields`
/// mirrors the schema's `additionalProperties: false` — producers must not add
/// fields without bumping `schemaVersion`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    pub schema_version: u32,
    /// Stable plugin id; also the default connector namespace.
    pub id: String,
    pub name: String,
    /// Semver.
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSON-RPC protocol version the plugin speaks. Optional in the schema;
    /// defaults to 1 (the only version that exists).
    #[serde(default = "default_plugin_api_version")]
    pub plugin_api_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_desktop_version: Option<String>,
    pub entry: PluginEntry,
    /// Permission strings the plugin's commands map to, e.g.
    /// `connector.aokie.call.answer` (wildcards like `connector.aokie.*` allowed).
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub connectors: Vec<ConnectorDecl>,
    /// Event names this plugin may emit; the host drops undeclared events.
    #[serde(default)]
    pub events: Vec<String>,
}

fn default_plugin_api_version() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginEntry {
    /// Only "process" exists (schema `const`).
    pub kind: String,
    /// Executable path RELATIVE to the plugin directory (a bare name like
    /// "node" resolves via PATH). Absolute paths, drive letters and `..`
    /// segments are rejected by [`validate_entry_command`].
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorDecl {
    pub id: String,
    pub name: String,
    pub commands: Vec<String>,
}

// ---------------------------------------------------------------------------
// pattern helpers (mirroring the schema's regexes, hand-rolled)
// ---------------------------------------------------------------------------

/// `^[a-z][a-z0-9-]{1,63}$` — plugin ids and connector ids.
pub fn is_valid_plugin_id(s: &str) -> bool {
    let b = s.as_bytes();
    (2..=64).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` — manifest `version`.
pub fn is_valid_semver(s: &str) -> bool {
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    let mut parts = core.split('.');
    let three_numbers = (0..3).all(|_| {
        parts
            .next()
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
    }) && parts.next().is_none();
    let pre_ok = match pre {
        None => true,
        Some(p) => {
            !p.is_empty()
                && p.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
        }
    };
    three_numbers && pre_ok
}

/// `^\d+\.\d+\.\d+$` — `minDesktopVersion` (no pre-release part).
pub fn is_valid_plain_semver(s: &str) -> bool {
    !s.contains('-') && is_valid_semver(s)
}

/// Parse `major.minor.patch` (pre-release ignored for ordering — the contract
/// compares plain versions). Returns None when not semver-shaped.
pub fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.split('-').next().unwrap_or(s);
    let mut it = core.split('.');
    let maj = it.next()?.parse().ok()?;
    let min = it.next()?.parse().ok()?;
    let pat = it.next()?.parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some((maj, min, pat))
}

/// Dot-separated name check shared by commands / events / capabilities:
/// first segment starts `[a-z]` then `first_rest`; every later segment is a
/// non-empty run of `later` chars; at least two segments.
fn is_dotted_name(s: &str, first_rest: fn(u8) -> bool, later: fn(u8) -> bool) -> bool {
    let mut segs = s.split('.');
    let first = match segs.next() {
        Some(f) => f.as_bytes(),
        None => return false,
    };
    if first.is_empty() || !first[0].is_ascii_lowercase() || !first[1..].iter().all(|c| first_rest(*c)) {
        return false;
    }
    let mut rest = 0usize;
    for seg in segs {
        if seg.is_empty() || !seg.bytes().all(later) {
            return false;
        }
        rest += 1;
    }
    rest >= 1
}

/// `^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$` — connector command names.
pub fn is_valid_command_name(s: &str) -> bool {
    s.len() <= 96
        && is_dotted_name(
            s,
            |c| c.is_ascii_alphanumeric() || c == b'_',
            |c| c.is_ascii_alphanumeric() || c == b'_',
        )
}

/// `^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)+$` — event names.
pub fn is_valid_event_name(s: &str) -> bool {
    s.len() <= 128
        && is_dotted_name(
            s,
            |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_',
            |c| c.is_ascii_alphanumeric() || c == b'_',
        )
}

/// `^[a-z][a-z0-9_-]*(\.[a-zA-Z0-9_*-]+)+$` — capability strings.
pub fn is_valid_capability(s: &str) -> bool {
    s.len() <= 128
        && is_dotted_name(
            s,
            |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-',
            |c| c.is_ascii_alphanumeric() || c == b'_' || c == b'*' || c == b'-',
        )
}

/// Reject absolute paths, drive letters and `..` segments in `entry.command`.
/// A bare name ("node") or a plugin-dir-relative path ("bin/tool.exe") passes.
pub fn validate_entry_command(command: &str) -> Result<(), String> {
    if command.is_empty() {
        return Err("entry.command is empty".into());
    }
    if command.len() > 260 {
        return Err(format!(
            "entry.command is {} chars (max 260)",
            command.len()
        ));
    }
    if command.starts_with('/') || command.starts_with('\\') {
        return Err(format!(
            "entry.command {command:?} is absolute — it must be a path relative to the plugin directory"
        ));
    }
    // A ':' anywhere catches drive letters ("C:\..." AND the drive-relative
    // "C:tool.exe") plus other schemes; ':' is never valid in a relative path
    // on Windows and never needed on Unix.
    if command.contains(':') {
        return Err(format!(
            "entry.command {command:?} contains ':' (drive letters / absolute paths aren't allowed)"
        ));
    }
    if command.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(format!(
            "entry.command {command:?} contains a '..' segment — it must stay inside the plugin directory"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// parse + validate
// ---------------------------------------------------------------------------

/// Parse and fully validate a manifest.json body. Every failure names the
/// offending field so the UI/registry can surface it verbatim.
pub fn parse_manifest(text: &str) -> Result<PluginManifest, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let manifest: PluginManifest = serde_json::from_str(text)
        .map_err(|e| format!("manifest.json is not a valid plugin manifest: {e}"))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

pub fn validate_manifest(m: &PluginManifest) -> Result<(), String> {
    if m.schema_version != 1 {
        return Err(format!(
            "schemaVersion {} is not supported (this desktop speaks schemaVersion 1)",
            m.schema_version
        ));
    }
    if !is_valid_plugin_id(&m.id) {
        return Err(format!(
            "id {:?} is invalid: want ^[a-z][a-z0-9-]{{1,63}}$ (lowercase letters, digits, hyphens; 2-64 chars)",
            m.id
        ));
    }
    if m.name.is_empty() || m.name.len() > 120 {
        return Err(format!("name must be 1-120 chars (got {})", m.name.len()));
    }
    if !is_valid_semver(&m.version) {
        return Err(format!(
            "version {:?} is not semver (want MAJOR.MINOR.PATCH with an optional -pre.release)",
            m.version
        ));
    }
    if let Some(p) = &m.publisher {
        if p.len() > 120 {
            return Err(format!("publisher is {} chars (max 120)", p.len()));
        }
    }
    if let Some(d) = &m.description {
        if d.len() > 500 {
            return Err(format!("description is {} chars (max 500)", d.len()));
        }
    }
    if m.plugin_api_version < 1 {
        return Err("pluginApiVersion must be >= 1".into());
    }
    if let Some(v) = &m.min_desktop_version {
        if !is_valid_plain_semver(v) {
            return Err(format!(
                "minDesktopVersion {v:?} is invalid (want plain MAJOR.MINOR.PATCH)"
            ));
        }
    }
    if m.entry.kind != "process" {
        return Err(format!(
            "entry.kind {:?} is not supported (only \"process\")",
            m.entry.kind
        ));
    }
    validate_entry_command(&m.entry.command)?;
    if m.entry.args.len() > 16 {
        return Err(format!("entry.args has {} items (max 16)", m.entry.args.len()));
    }
    for a in &m.entry.args {
        if a.len() > 260 {
            return Err(format!("entry.args entry {a:?} is over 260 chars"));
        }
    }
    if m.capabilities.len() > 128 {
        return Err(format!(
            "capabilities has {} entries (max 128)",
            m.capabilities.len()
        ));
    }
    for (i, c) in m.capabilities.iter().enumerate() {
        if !is_valid_capability(c) {
            return Err(format!(
                "capabilities[{i}] {c:?} is invalid: want dot-namespaced permission strings like \"connector.aokie.call.answer\" (wildcard segment '*' allowed)"
            ));
        }
        if m.capabilities[..i].contains(c) {
            return Err(format!("capabilities[{i}] {c:?} is duplicated"));
        }
    }
    if m.connectors.len() > 8 {
        return Err(format!("connectors has {} entries (max 8)", m.connectors.len()));
    }
    for (i, con) in m.connectors.iter().enumerate() {
        if !is_valid_plugin_id(&con.id) {
            return Err(format!(
                "connectors[{i}].id {:?} is invalid: want ^[a-z][a-z0-9-]{{1,63}}$",
                con.id
            ));
        }
        if m.connectors[..i].iter().any(|c| c.id == con.id) {
            return Err(format!("connectors[{i}].id {:?} is duplicated", con.id));
        }
        if con.name.is_empty() || con.name.len() > 120 {
            return Err(format!(
                "connectors[{i}].name must be 1-120 chars (got {})",
                con.name.len()
            ));
        }
        if con.commands.len() > 128 {
            return Err(format!(
                "connectors[{i}].commands has {} entries (max 128)",
                con.commands.len()
            ));
        }
        for (j, cmd) in con.commands.iter().enumerate() {
            if !is_valid_command_name(cmd) {
                return Err(format!(
                    "connectors[{i}].commands[{j}] {cmd:?} is invalid: want dot-namespaced like \"call.answer\""
                ));
            }
            if con.commands[..j].contains(cmd) {
                return Err(format!(
                    "connectors[{i}].commands[{j}] {cmd:?} is duplicated"
                ));
            }
        }
    }
    if m.events.len() > 256 {
        return Err(format!("events has {} entries (max 256)", m.events.len()));
    }
    for (i, e) in m.events.iter().enumerate() {
        if !is_valid_event_name(e) {
            return Err(format!(
                "events[{i}] {e:?} is invalid: want dot-namespaced like \"aokie.call.incoming\""
            ));
        }
        if m.events[..i].contains(e) {
            return Err(format!("events[{i}] {e:?} is duplicated"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// capability / declaration queries used by the connector gateway + event bus
// ---------------------------------------------------------------------------

impl PluginManifest {
    /// The connector declaration with this id, if the plugin exposes it.
    pub fn connector(&self, connector_id: &str) -> Option<&ConnectorDecl> {
        self.connectors.iter().find(|c| c.id == connector_id)
    }

    /// True when `command` is listed under the given connector's `commands`.
    pub fn declares_command(&self, connector_id: &str, command: &str) -> bool {
        self.connector(connector_id)
            .is_some_and(|c| c.commands.iter().any(|k| k == command))
    }

    /// True when a declared capability covers `connector.<id>.<command>`.
    /// A `*` segment (only meaningful as the LAST segment, e.g.
    /// `connector.aokie.*`) matches all remaining segments.
    pub fn capability_covers(&self, connector_id: &str, command: &str) -> bool {
        let target = format!("connector.{connector_id}.{command}");
        self.capabilities
            .iter()
            .any(|cap| capability_matches(cap, &target))
    }

    /// The full gateway check: the command must be declared under the
    /// connector AND covered by a capability (the manifest's permission
    /// surface). Returns the denial reason on failure.
    pub fn command_allowed(&self, connector_id: &str, command: &str) -> Result<(), String> {
        if !self.declares_command(connector_id, command) {
            return Err(format!(
                "command {command:?} is not declared by connector {connector_id:?}"
            ));
        }
        if !self.capability_covers(connector_id, command) {
            return Err(format!(
                "command {command:?} is not covered by the plugin's declared capabilities"
            ));
        }
        Ok(())
    }

    /// True when the plugin declares it may emit `event`.
    pub fn declares_event(&self, event: &str) -> bool {
        self.events.iter().any(|e| e == event)
    }
}

/// Segment-wise capability match; a trailing `*` segment matches one or more
/// remaining segments (`connector.aokie.*` covers `connector.aokie.call.answer`).
fn capability_matches(cap: &str, target: &str) -> bool {
    let mut cs = cap.split('.').peekable();
    let mut ts = target.split('.');
    loop {
        match (cs.next(), ts.next()) {
            (None, None) => return true,
            (Some("*"), Some(_)) if cs.peek().is_none() => return true,
            (Some(c), Some(t)) if c == t => continue,
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_manifest() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "id": "mock",
            "name": "Mock plugin",
            "version": "0.1.0",
            "pluginApiVersion": 1,
            "entry": { "kind": "process", "command": "mock-plugin.exe" },
            "capabilities": ["connector.mock.echo.*"],
            "connectors": [
                { "id": "mock", "name": "Mock", "commands": ["echo.ping"] }
            ],
            "events": ["mock.tick"]
        })
    }

    fn parse(v: serde_json::Value) -> Result<PluginManifest, String> {
        parse_manifest(&v.to_string())
    }

    #[test]
    fn valid_manifest_parses() {
        let m = parse(base_manifest()).expect("valid manifest");
        assert_eq!(m.id, "mock");
        assert_eq!(m.plugin_api_version, 1);
        assert!(m.declares_event("mock.tick"));
        assert!(m.declares_command("mock", "echo.ping"));
        assert!(m.capability_covers("mock", "echo.ping"));
        assert!(m.command_allowed("mock", "echo.ping").is_ok());
    }

    #[test]
    fn plugin_api_version_defaults_to_1() {
        let mut v = base_manifest();
        v.as_object_mut().unwrap().remove("pluginApiVersion");
        assert_eq!(parse(v).expect("parses").plugin_api_version, 1);
    }

    #[test]
    fn unknown_top_level_field_is_rejected() {
        let mut v = base_manifest();
        v["sneaky"] = serde_json::json!(true);
        let err = parse(v).unwrap_err();
        assert!(err.contains("sneaky"), "error names the field: {err}");
    }

    #[test]
    fn bad_ids_and_versions_are_rejected() {
        for (field, val, needle) in [
            ("id", serde_json::json!("Mock"), "id"),
            ("id", serde_json::json!("x"), "id"),
            ("id", serde_json::json!("has space"), "id"),
            ("version", serde_json::json!("1.2"), "semver"),
            ("version", serde_json::json!("v1.2.3"), "semver"),
            ("minDesktopVersion", serde_json::json!("1.2.3-beta"), "minDesktopVersion"),
            ("schemaVersion", serde_json::json!(2), "schemaVersion"),
        ] {
            let mut v = base_manifest();
            v[field] = val;
            let err = parse(v).unwrap_err();
            assert!(err.contains(needle), "{field}: {err}");
        }
    }

    #[test]
    fn malicious_entry_commands_are_rejected() {
        // The loader must never execute anything outside the plugin dir:
        // absolute paths, drive letters (both C:\ and drive-relative C:x),
        // UNC-ish leading slashes, and .. escapes are all refused.
        for cmd in [
            "C:\\Windows\\System32\\cmd.exe",
            "C:cmd.exe",
            "/usr/bin/env",
            "\\\\server\\share\\evil.exe",
            "..\\..\\evil.exe",
            "../evil",
            "bin/../../evil",
            "",
        ] {
            let mut v = base_manifest();
            v["entry"]["command"] = serde_json::json!(cmd);
            assert!(parse(v).is_err(), "command {cmd:?} must be rejected");
        }
        // But bare names + plugin-relative paths pass.
        for cmd in ["node", "bin/tool", "bin\\tool.exe", "mock-plugin"] {
            let mut v = base_manifest();
            v["entry"]["command"] = serde_json::json!(cmd);
            assert!(parse(v).is_ok(), "command {cmd:?} must be accepted");
        }
    }

    #[test]
    fn entry_kind_must_be_process() {
        let mut v = base_manifest();
        v["entry"]["kind"] = serde_json::json!("dll");
        assert!(parse(v).unwrap_err().contains("entry.kind"));
    }

    #[test]
    fn caps_and_limits() {
        // args > 16
        let mut v = base_manifest();
        v["entry"]["args"] = serde_json::json!(vec!["a"; 17]);
        assert!(parse(v).unwrap_err().contains("entry.args"));
        // connectors > 8
        let mut v = base_manifest();
        let con = v["connectors"][0].clone();
        v["connectors"] = serde_json::Value::Array(
            (0..9)
                .map(|i| {
                    let mut c = con.clone();
                    c["id"] = serde_json::json!(format!("mock-{i}"));
                    c
                })
                .collect(),
        );
        assert!(parse(v).unwrap_err().contains("connectors"));
        // duplicate event
        let mut v = base_manifest();
        v["events"] = serde_json::json!(["mock.tick", "mock.tick"]);
        assert!(parse(v).unwrap_err().contains("duplicated"));
    }

    #[test]
    fn pattern_helpers() {
        assert!(is_valid_command_name("echo.ping"));
        assert!(is_valid_command_name("dongle.installDriver"));
        assert!(!is_valid_command_name("ping")); // needs >= 2 segments
        assert!(!is_valid_command_name("Echo.ping")); // uppercase first char
        assert!(!is_valid_command_name("echo..ping"));
        assert!(is_valid_event_name("aokie.call.incoming"));
        assert!(!is_valid_event_name("Aokie.call"));
        assert!(is_valid_capability("connector.aokie.*"));
        assert!(is_valid_capability("connector.aokie.call.answer"));
        assert!(!is_valid_capability("connector")); // needs >= 2 segments
        assert!(is_valid_semver("1.2.3-beta.1"));
        assert!(!is_valid_semver("1.2.3.4"));
        assert_eq!(parse_semver("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_semver("nope"), None);
    }

    #[test]
    fn capability_wildcards() {
        assert!(capability_matches("connector.aokie.*", "connector.aokie.call.answer"));
        assert!(capability_matches("connector.aokie.call.answer", "connector.aokie.call.answer"));
        assert!(!capability_matches("connector.aokie.*", "connector.other.call.answer"));
        // '*' must be the LAST segment to act as a wildcard.
        assert!(!capability_matches("connector.*.call", "connector.aokie.call"));
        // A bare wildcard never matches an empty remainder.
        assert!(!capability_matches("connector.aokie.*", "connector.aokie"));
    }
}
