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

    // ---- schemaVersion 2 additions (all optional; a v1 manifest omits them,
    //      and validate_manifest refuses them UNDER schemaVersion 1) ----
    /// PLG-203: declarative UI contributions (nav links, Overview cards, status
    /// cards). Presentation-only → parsed unknown-TOLERANT so a future additive
    /// field can't hard-fail an older v2 host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<UiContributions>,
    /// PLG-206: plugin-owned local service templates, installed with the plugin
    /// and removed when it's uninstalled.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub services: Vec<PluginServiceRef>,
    /// PLG-202: commands that require a durable requestId (physical side
    /// effects) — absorbs the hardcoded client-side mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<CommandsDecl>,
    /// PLG-107/207: data the plugin stores OUTSIDE the desktop tree, shown to
    /// the user as a manual checklist on purge (never auto-deleted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<DataDecl>,
}

fn default_plugin_api_version() -> u32 {
    1
}

/// PLG-203 — the declarative UI a plugin contributes. Unknown fields are
/// tolerated (presentation-only, forward-compatible).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UiContributions {
    /// Side-menu entries. Selecting one opens the plugin's contributed screen.
    #[serde(default)]
    pub nav: Vec<NavContribution>,
    /// Cards shown on the Overview screen (a hero banner or a compact status card).
    #[serde(default)]
    pub overview: Vec<OverviewCard>,
    /// Status cards (poll a declared connector command, show mapped fields).
    /// Rendered on the plugin's contributed screen.
    #[serde(default)]
    pub status_cards: Vec<StatusCard>,
    /// Safe action buttons (a declared command + confirm copy).
    #[serde(default)]
    pub actions: Vec<ActionButton>,
    /// Plugin-shipped interactive screens: static HTML/JS/CSS bundles that
    /// live INSIDE the signed package and are served to the webview by the
    /// host (`GET /api/plugins/:id/ui/:screen/*path`). The foundation of the
    /// self-contained-plugins epic — a nav entry may open one via `screen`.
    #[serde(default)]
    pub screens: Vec<ScreenContribution>,
}

/// A side-menu contribution. `icon` is an allow-listed name (the host maps it;
/// unknown icons fall back to a default). `screen` names the contributed screen
/// to open (currently the generic plugin screen).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavContribution {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    /// A plugin-shipped screen (a `ui.screens` id) this entry opens instead of
    /// the generic contributed screen. Validated as a cross-reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<String>,
}

/// An Overview card. `kind` is "hero" (a prominent banner) or "status" (a
/// compact card). `bind` maps display fields to values resolved against the
/// plugin snapshot (`state`, `health.*`) via a safe JSON-pointer grammar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewCard {
    pub id: String,
    #[serde(default = "default_card_kind")]
    pub kind: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Display bindings: `headline`, `body` are pointer paths (e.g.
    /// `$health.status`); `cta` is an optional { label, nav } deep-link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind: Option<CardBind>,
}

fn default_card_kind() -> String {
    "status".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CardBind {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cta: Option<CardCta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardCta {
    pub label: String,
    /// A nav id to open when the CTA is clicked.
    pub nav: String,
}

/// A status card that polls a declared connector command and renders fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCard {
    pub id: String,
    pub title: String,
    /// The connector command to poll for this card's data.
    pub poll: StatusPoll,
    /// Field mappings: label + a pointer path into the command's response data.
    #[serde(default)]
    pub fields: Vec<StatusField>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPoll {
    pub command: String,
    /// Poll interval; the host clamps it to a sane floor (>= 2000ms).
    #[serde(default = "default_poll_ms")]
    pub interval_ms: u64,
}

fn default_poll_ms() -> u64 {
    5000
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusField {
    pub label: String,
    /// Dot/pointer path into the poll command's response `data`.
    pub path: String,
}

/// A declared safe action button (a connector command + confirm copy).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionButton {
    pub id: String,
    pub label: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<String>,
    /// Restrict the button to dev mode (e.g. a simulate affordance).
    #[serde(default)]
    pub dev_only: bool,
}

/// A plugin-shipped interactive screen: an entry HTML document plus the EXACT
/// file set the host may serve for it. Every path is package-relative; the
/// serving route matches requested paths against `files` by exact string
/// (no directory walking, no normalization). Unknown fields tolerated like
/// the rest of the presentation-only `ui` subtree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenContribution {
    pub id: String,
    pub title: String,
    /// The screen's entry document — must be listed in `files`, must end .html.
    pub entry: String,
    /// The complete servable file set (relative package paths, allow-listed
    /// static-asset extensions only).
    pub files: Vec<String>,
}

/// Extensions a plugin-shipped screen may serve. Anything else fails manifest
/// validation — a screen bundle is static web assets, never executables.
pub const SCREEN_ASSET_EXTS: &[&str] =
    &["html", "css", "js", "mjs", "json", "svg", "png", "woff2"];

/// Validate one `ui.screens[].files` path: RELATIVE, forward slashes only, no
/// drive letters, no empty/`.`/`..` segments, and an allow-listed extension.
/// Same spirit as [`validate_entry_command`] — the manifest can structurally
/// never name a file outside the plugin directory. The error is a fragment
/// ("is absolute — …") the caller prefixes with the offending field.
pub fn validate_screen_asset_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("is empty".into());
    }
    if path.len() > 260 {
        return Err(format!("is {} chars (max 260)", path.len()));
    }
    if path.contains('\\') {
        return Err("contains '\\' (use forward slashes)".into());
    }
    if path.starts_with('/') {
        return Err("is absolute — want a package-relative path".into());
    }
    // A ':' anywhere catches drive letters ("C:/…" AND drive-relative "C:x")
    // plus URL schemes; ':' is never valid in a relative path on Windows.
    if path.contains(':') {
        return Err("contains ':' (drive letters / absolute paths aren't allowed)".into());
    }
    if path.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        return Err("has an empty, '.' or '..' segment".into());
    }
    let ext = path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    if !SCREEN_ASSET_EXTS.contains(&ext) {
        return Err(format!(
            "has extension {ext:?} (allowed: {SCREEN_ASSET_EXTS:?})"
        ));
    }
    Ok(())
}

/// Resolve a requested screen asset for the serving route: the screen must
/// exist and the requested relative path must EXACTLY match one of its
/// declared `files` — the whole lookup rule (no directory walking, no
/// normalization; anything a validated manifest didn't list is a 404).
/// Returns the declared relative path to read under the plugin directory.
pub fn resolve_screen_asset<'a>(
    screens: &'a [ScreenContribution],
    screen_id: &str,
    requested: &str,
) -> Option<&'a str> {
    let screen = screens.iter().find(|s| s.id == screen_id)?;
    screen
        .files
        .iter()
        .find(|f| f.as_str() == requested)
        .map(String::as_str)
}

/// PLG-206 — a plugin-owned service template reference (a package-relative JSON).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginServiceRef {
    /// Package-relative path to a ServiceTemplate JSON (no `..`, no absolute).
    pub template_file: String,
}

/// PLG-202 — journalled command declaration (fail-closed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandsDecl {
    #[serde(default)]
    pub journalled: Vec<String>,
}

/// PLG-107 — external data inventory (fail-closed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataDecl {
    #[serde(default)]
    pub external_inventory: Vec<ExternalDataItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalDataItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
    pub label: String,
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

/// The highest manifest schemaVersion this desktop understands.
pub const MAX_SCHEMA_VERSION: u32 = 2;

pub fn validate_manifest(m: &PluginManifest) -> Result<(), String> {
    if m.schema_version < 1 || m.schema_version > MAX_SCHEMA_VERSION {
        return Err(format!(
            "schemaVersion {} is not supported (this desktop speaks schemaVersion 1..{MAX_SCHEMA_VERSION})",
            m.schema_version
        ));
    }
    // v2-only sections must not appear under schemaVersion 1 (a v1 host would
    // silently ignore them; refusing them here keeps the contract honest).
    if m.schema_version < 2 {
        let v2 = [
            m.ui.is_some().then_some("ui"),
            (!m.services.is_empty()).then_some("services"),
            m.commands.is_some().then_some("commands"),
            m.data.is_some().then_some("data"),
        ];
        if let Some(section) = v2.into_iter().flatten().next() {
            return Err(format!(
                "the {section:?} section requires schemaVersion 2 (this manifest declares 1)"
            ));
        }
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
    validate_v2_sections(m)?;
    Ok(())
}

/// True when `command` is declared by ANY of the plugin's connectors — used to
/// validate that a UI status card / action references a real command.
fn declares_any_command(m: &PluginManifest, command: &str) -> bool {
    m.connectors.iter().any(|c| c.commands.iter().any(|k| k == command))
}

fn validate_v2_sections(m: &PluginManifest) -> Result<(), String> {
    // ui (presentation-only, but the ids/references still get sanity checks).
    if let Some(ui) = &m.ui {
        if ui.nav.len() > 16 {
            return Err(format!("ui.nav has {} entries (max 16)", ui.nav.len()));
        }
        let mut nav_ids = std::collections::HashSet::new();
        for (i, n) in ui.nav.iter().enumerate() {
            if !is_valid_contrib_id(&n.id) {
                return Err(format!("ui.nav[{i}].id {:?} is invalid (a-z0-9-, 1-64)", n.id));
            }
            if !nav_ids.insert(&n.id) {
                return Err(format!("ui.nav[{i}].id {:?} is duplicated", n.id));
            }
            if n.label.is_empty() || n.label.len() > 60 {
                return Err(format!("ui.nav[{i}].label must be 1-60 chars"));
            }
            // A nav entry may open a plugin-shipped screen — the reference
            // must resolve, same as a CTA's nav id.
            if let Some(sid) = &n.screen {
                if !ui.screens.iter().any(|s| s.id == *sid) {
                    return Err(format!(
                        "ui.nav[{i}].screen {sid:?} does not match any ui.screens id"
                    ));
                }
            }
        }
        if ui.overview.len() > 16 {
            return Err(format!("ui.overview has {} entries (max 16)", ui.overview.len()));
        }
        for (i, c) in ui.overview.iter().enumerate() {
            if !is_valid_contrib_id(&c.id) {
                return Err(format!("ui.overview[{i}].id {:?} is invalid", c.id));
            }
            if !matches!(c.kind.as_str(), "hero" | "status") {
                return Err(format!(
                    "ui.overview[{i}].kind {:?} must be \"hero\" or \"status\"",
                    c.kind
                ));
            }
            if c.title.is_empty() || c.title.len() > 120 {
                return Err(format!("ui.overview[{i}].title must be 1-120 chars"));
            }
            if let Some(bind) = c.bind.as_ref() {
                // headline/body are pointer paths resolved by the host — the
                // same safe-path rule the status-card fields already obey.
                for (name, p) in [("headline", &bind.headline), ("body", &bind.body)] {
                    if let Some(p) = p {
                        if !is_safe_pointer(p) {
                            return Err(format!(
                                "ui.overview[{i}].bind.{name} {p:?} is not a safe field path"
                            ));
                        }
                    }
                }
                if let Some(cta) = bind.cta.as_ref() {
                    if !ui.nav.iter().any(|n| n.id == cta.nav) {
                        return Err(format!(
                            "ui.overview[{i}].bind.cta.nav {:?} does not match any ui.nav id",
                            cta.nav
                        ));
                    }
                }
            }
        }
        if ui.status_cards.len() > 16 {
            return Err(format!(
                "ui.statusCards has {} entries (max 16)",
                ui.status_cards.len()
            ));
        }
        for (i, card) in ui.status_cards.iter().enumerate() {
            if !is_valid_contrib_id(&card.id) {
                return Err(format!("ui.statusCards[{i}].id {:?} is invalid", card.id));
            }
            if !declares_any_command(m, &card.poll.command) {
                return Err(format!(
                    "ui.statusCards[{i}].poll.command {:?} is not declared by any connector",
                    card.poll.command
                ));
            }
            if card.fields.len() > 16 {
                return Err(format!(
                    "ui.statusCards[{i}] has {} fields (max 16)",
                    card.fields.len()
                ));
            }
            for (j, f) in card.fields.iter().enumerate() {
                if !is_safe_pointer(&f.path) {
                    return Err(format!(
                        "ui.statusCards[{i}].fields[{j}].path {:?} is not a safe field path",
                        f.path
                    ));
                }
            }
        }
        if ui.actions.len() > 16 {
            return Err(format!("ui.actions has {} entries (max 16)", ui.actions.len()));
        }
        for (i, a) in ui.actions.iter().enumerate() {
            if !is_valid_contrib_id(&a.id) {
                return Err(format!("ui.actions[{i}].id {:?} is invalid", a.id));
            }
            if !declares_any_command(m, &a.command) {
                return Err(format!(
                    "ui.actions[{i}].command {:?} is not declared by any connector",
                    a.command
                ));
            }
        }
        // screens — plugin-shipped bundles. The file list is the serving
        // route's allowlist, so every path is validated hard here (relative,
        // no traversal, static-asset extensions only).
        if ui.screens.len() > 16 {
            return Err(format!("ui.screens has {} entries (max 16)", ui.screens.len()));
        }
        let mut screen_ids = std::collections::HashSet::new();
        for (i, s) in ui.screens.iter().enumerate() {
            if !is_valid_contrib_id(&s.id) {
                return Err(format!("ui.screens[{i}].id {:?} is invalid (a-z0-9-, 1-64)", s.id));
            }
            if !screen_ids.insert(&s.id) {
                return Err(format!("ui.screens[{i}].id {:?} is duplicated", s.id));
            }
            if s.title.is_empty() || s.title.len() > 80 {
                return Err(format!("ui.screens[{i}].title must be 1-80 chars"));
            }
            if s.files.is_empty() || s.files.len() > 64 {
                return Err(format!(
                    "ui.screens[{i}].files must have 1-64 entries (got {})",
                    s.files.len()
                ));
            }
            for (j, f) in s.files.iter().enumerate() {
                if let Err(e) = validate_screen_asset_path(f) {
                    return Err(format!("ui.screens[{i}].files[{j}] {f:?} {e}"));
                }
                if s.files[..j].contains(f) {
                    return Err(format!("ui.screens[{i}].files[{j}] {f:?} is duplicated"));
                }
            }
            if !s.entry.ends_with(".html") {
                return Err(format!("ui.screens[{i}].entry {:?} must end in .html", s.entry));
            }
            if !s.files.contains(&s.entry) {
                return Err(format!(
                    "ui.screens[{i}].entry {:?} is not listed in files",
                    s.entry
                ));
            }
        }
    }
    // services — package-relative template paths, no traversal.
    if m.services.len() > 8 {
        return Err(format!("services has {} entries (max 8)", m.services.len()));
    }
    for (i, s) in m.services.iter().enumerate() {
        if s.template_file.is_empty()
            || s.template_file.contains(':')
            || s.template_file.split(['/', '\\']).any(|seg| seg == "..")
            || s.template_file.starts_with('/')
            || s.template_file.starts_with('\\')
        {
            return Err(format!(
                "services[{i}].templateFile {:?} must be a package-relative path with no '..'",
                s.template_file
            ));
        }
    }
    // commands.journalled — each must be a declared command name.
    if let Some(cmds) = &m.commands {
        for (i, c) in cmds.journalled.iter().enumerate() {
            if !declares_any_command(m, c) {
                return Err(format!(
                    "commands.journalled[{i}] {c:?} is not declared by any connector"
                ));
            }
        }
    }
    // data.externalInventory — labels required.
    if let Some(data) = &m.data {
        for (i, item) in data.external_inventory.iter().enumerate() {
            if item.label.is_empty() || item.label.len() > 200 {
                return Err(format!("data.externalInventory[{i}].label must be 1-200 chars"));
            }
        }
    }
    Ok(())
}

/// A contribution id: `[a-z][a-z0-9-]{0,63}` (nav/card/action ids).
fn is_valid_contrib_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A safe field pointer for status-card bindings: dot-separated segments of
/// `[a-zA-Z0-9_]` plus numeric array indices, optionally `$`-prefixed. NO
/// executable syntax — this is a JSON-pointer-like grammar only.
fn is_safe_pointer(path: &str) -> bool {
    let p = path.strip_prefix('$').unwrap_or(path);
    !p.is_empty()
        && p.len() <= 200
        && p.split('.').all(|seg| {
            !seg.is_empty() && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
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

    // ---- PLG-201 manifest v2 ----

    fn base_v2() -> serde_json::Value {
        let mut v = base_manifest();
        v["schemaVersion"] = serde_json::json!(2);
        v
    }

    #[test]
    fn v1_manifest_still_parses_without_v2_sections() {
        let m = parse(base_manifest()).expect("v1 valid");
        assert_eq!(m.schema_version, 1);
        assert!(m.ui.is_none());
        assert!(m.services.is_empty());
    }

    #[test]
    fn v2_manifest_parses_ui_services_commands_data() {
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "nav": [{ "id": "home", "label": "Mock", "icon": "phone", "badge": "New" }],
            "overview": [{
                "id": "hero", "kind": "hero", "title": "Mock plugin",
                "bind": { "headline": "$health.status", "body": "$health.detail",
                          "cta": { "label": "Open", "nav": "home" } }
            }],
            "statusCards": [{
                "id": "st", "title": "Status",
                "poll": { "command": "echo.ping", "intervalMs": 5000 },
                "fields": [{ "label": "Echo", "path": "echo.hello" }]
            }],
            "actions": [{ "id": "sim", "label": "Simulate", "command": "echo.ping", "devOnly": true }]
        });
        v["services"] = serde_json::json!([{ "templateFile": "services/mock-voice.json" }]);
        v["commands"] = serde_json::json!({ "journalled": ["echo.ping"] });
        v["data"] = serde_json::json!({
            "externalInventory": [{ "path": "%APPDATA%/mock", "label": "Mock data" }]
        });
        let m = parse(v).expect("v2 valid");
        assert_eq!(m.schema_version, 2);
        let ui = m.ui.expect("ui");
        assert_eq!(ui.nav.len(), 1);
        assert_eq!(ui.nav[0].id, "home");
        assert_eq!(ui.overview[0].kind, "hero");
        assert_eq!(ui.status_cards[0].poll.command, "echo.ping");
        assert_eq!(m.services.len(), 1);
        assert_eq!(m.commands.unwrap().journalled, vec!["echo.ping"]);
        assert_eq!(m.data.unwrap().external_inventory[0].label, "Mock data");
    }

    #[test]
    fn v2_sections_refused_under_schema_version_1() {
        let mut v = base_manifest(); // schemaVersion 1
        v["ui"] = serde_json::json!({ "nav": [] });
        let err = parse(v).expect_err("v2 section under v1 refused");
        assert!(err.contains("requires schemaVersion 2"), "got: {err}");
    }

    #[test]
    fn v2_ui_references_must_resolve() {
        // A status card polling an undeclared command is refused.
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "statusCards": [{ "id": "st", "title": "S",
                "poll": { "command": "not.declared" }, "fields": [] }]
        });
        assert!(parse(v).unwrap_err().contains("not declared by any connector"));

        // A CTA pointing at a non-existent nav id is refused.
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "nav": [{ "id": "home", "label": "H" }],
            "overview": [{ "id": "c", "kind": "status", "title": "T",
                "bind": { "cta": { "label": "x", "nav": "missing" } } }]
        });
        assert!(parse(v).unwrap_err().contains("does not match any ui.nav id"));

        // An unsafe field pointer is refused.
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "statusCards": [{ "id": "st", "title": "S",
                "poll": { "command": "echo.ping" },
                "fields": [{ "label": "x", "path": "a.b();evil" }] }]
        });
        assert!(parse(v).unwrap_err().contains("not a safe field path"));

        // An unsafe overview bind pointer is refused (same rule as fields).
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "overview": [{ "id": "c", "kind": "hero", "title": "T",
                "bind": { "headline": "$health.status; drop()" } }]
        });
        assert!(parse(v).unwrap_err().contains("not a safe field path"));
    }

    /// Every ui array is bounded — a hostile manifest can't bloat the snapshot
    /// (nav was already capped at 16; overview/statusCards/actions/fields match).
    #[test]
    fn v2_ui_arrays_are_capped() {
        let card = |i: usize| {
            serde_json::json!({ "id": format!("c{i}"), "kind": "status", "title": "T" })
        };
        let mut v = base_v2();
        v["ui"] = serde_json::json!({ "overview": (0..17).map(card).collect::<Vec<_>>() });
        assert!(parse(v).unwrap_err().contains("max 16"));

        let status = |i: usize| {
            serde_json::json!({ "id": format!("s{i}"), "title": "S",
                "poll": { "command": "echo.ping" }, "fields": [] })
        };
        let mut v = base_v2();
        v["ui"] = serde_json::json!({ "statusCards": (0..17).map(status).collect::<Vec<_>>() });
        assert!(parse(v).unwrap_err().contains("max 16"));

        let field = |i: usize| serde_json::json!({ "label": format!("f{i}"), "path": "a.b" });
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "statusCards": [{ "id": "st", "title": "S",
                "poll": { "command": "echo.ping" },
                "fields": (0..17).map(field).collect::<Vec<_>>() }]
        });
        assert!(parse(v).unwrap_err().contains("max 16"));

        let action = |i: usize| {
            serde_json::json!({ "id": format!("a{i}"), "label": "A", "command": "echo.ping" })
        };
        let mut v = base_v2();
        v["ui"] = serde_json::json!({ "actions": (0..17).map(action).collect::<Vec<_>>() });
        assert!(parse(v).unwrap_err().contains("max 16"));
    }

    // ---- ui.screens (plugin-shipped screen bundles) ----

    fn screens_ui(files: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "nav": [{ "id": "home", "label": "Mock", "screen": "receptionist-home" }],
            "screens": [{
                "id": "receptionist-home",
                "title": "AI Receptionist",
                "entry": "ui/receptionist/index.html",
                "files": files
            }]
        })
    }

    #[test]
    fn v2_screens_section_parses_and_serializes() {
        let mut v = base_v2();
        v["ui"] = screens_ui(serde_json::json!([
            "ui/receptionist/index.html",
            "ui/receptionist/app.js",
            "ui/receptionist/styles.css"
        ]));
        let m = parse(v).expect("screens section valid");
        let ui = m.ui.expect("ui");
        assert_eq!(ui.screens.len(), 1);
        assert_eq!(ui.screens[0].id, "receptionist-home");
        assert_eq!(ui.screens[0].entry, "ui/receptionist/index.html");
        assert_eq!(ui.nav[0].screen.as_deref(), Some("receptionist-home"));
        // The snapshot serializes `ui` verbatim — screens must survive the
        // round trip so GET /api/plugins carries them.
        let wire = serde_json::to_value(&ui).expect("serializes");
        assert_eq!(wire["screens"][0]["id"], "receptionist-home");
        assert_eq!(wire["screens"][0]["files"][1], "ui/receptionist/app.js");
        assert_eq!(wire["nav"][0]["screen"], "receptionist-home");
    }

    #[test]
    fn v2_screens_refused_under_schema_version_1() {
        let mut v = base_manifest(); // schemaVersion 1
        v["ui"] = screens_ui(serde_json::json!(["ui/receptionist/index.html"]));
        let err = parse(v).expect_err("ui.screens under v1 refused");
        assert!(err.contains("requires schemaVersion 2"), "got: {err}");
    }

    #[test]
    fn v2_screen_file_paths_reject_escape_shapes() {
        // Every shape that could name a file outside the package (or a
        // non-static asset) fails the manifest, never reaches the route.
        for bad in [
            "../escape.html",              // traversal
            "ui/../../escape.html",        // nested traversal
            "/etc/passwd.html",            // absolute
            "C:/windows/evil.html",        // drive letter
            "ui\\receptionist\\index.html", // backslashes
            "ui//index.html",              // empty segment
            "ui/./index.html",             // '.' segment
            "ui/receptionist/plugin.exe",  // extension not allow-listed
            "ui/receptionist/noext",       // no extension at all
            "",                            // empty
        ] {
            let mut v = base_v2();
            v["ui"] = serde_json::json!({
                "screens": [{ "id": "s", "title": "S", "entry": "index.html",
                    "files": ["index.html", bad] }]
            });
            let err = parse(v).expect_err(&format!("path {bad:?} must be rejected"));
            assert!(err.contains("ui.screens[0].files[1]"), "{bad:?}: {err}");
        }
    }

    #[test]
    fn v2_screen_entry_must_be_a_listed_html_file() {
        // Entry not listed in files.
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "screens": [{ "id": "s", "title": "S", "entry": "index.html",
                "files": ["other.html"] }]
        });
        assert!(parse(v).unwrap_err().contains("not listed in files"));

        // Entry listed but not .html.
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "screens": [{ "id": "s", "title": "S", "entry": "app.js",
                "files": ["app.js"] }]
        });
        assert!(parse(v).unwrap_err().contains("must end in .html"));
    }

    #[test]
    fn v2_nav_screen_ref_must_resolve() {
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "nav": [{ "id": "home", "label": "H", "screen": "ghost-screen" }],
            "screens": [{ "id": "real", "title": "R", "entry": "index.html",
                "files": ["index.html"] }]
        });
        assert!(parse(v)
            .unwrap_err()
            .contains("does not match any ui.screens id"));
    }

    #[test]
    fn v2_screens_are_capped_and_deduped() {
        // screens > 16
        let screen = |i: usize| {
            serde_json::json!({ "id": format!("s{i}"), "title": "S",
                "entry": "index.html", "files": ["index.html"] })
        };
        let mut v = base_v2();
        v["ui"] = serde_json::json!({ "screens": (0..17).map(screen).collect::<Vec<_>>() });
        assert!(parse(v).unwrap_err().contains("max 16"));

        // duplicate screen id
        let mut v = base_v2();
        v["ui"] = serde_json::json!({ "screens": [screen(0), screen(0)] });
        assert!(parse(v).unwrap_err().contains("duplicated"));

        // files empty / over 64
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "screens": [{ "id": "s", "title": "S", "entry": "index.html", "files": [] }]
        });
        assert!(parse(v).unwrap_err().contains("1-64 entries"));
        let files: Vec<String> = (0..65).map(|i| format!("f{i}.css")).collect();
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "screens": [{ "id": "s", "title": "S", "entry": "index.html",
                "files": files }]
        });
        assert!(parse(v).unwrap_err().contains("1-64 entries"));

        // duplicate file
        let mut v = base_v2();
        v["ui"] = serde_json::json!({
            "screens": [{ "id": "s", "title": "S", "entry": "index.html",
                "files": ["index.html", "index.html"] }]
        });
        assert!(parse(v).unwrap_err().contains("duplicated"));
    }

    #[test]
    fn resolve_screen_asset_is_exact_match_only() {
        let screens = vec![ScreenContribution {
            id: "home".into(),
            title: "Home".into(),
            entry: "ui/index.html".into(),
            files: vec!["ui/index.html".into(), "ui/app.js".into()],
        }];
        // Listed file resolves; everything else — unknown screen, unlisted
        // file, and any normalization/traversal spelling — is None.
        assert_eq!(
            resolve_screen_asset(&screens, "home", "ui/index.html"),
            Some("ui/index.html")
        );
        assert_eq!(resolve_screen_asset(&screens, "home", "ui/app.js"), Some("ui/app.js"));
        assert_eq!(resolve_screen_asset(&screens, "ghost", "ui/index.html"), None);
        assert_eq!(resolve_screen_asset(&screens, "home", "ui/secret.js"), None);
        assert_eq!(resolve_screen_asset(&screens, "home", "ui/../ui/index.html"), None);
        assert_eq!(resolve_screen_asset(&screens, "home", "UI/INDEX.HTML"), None);
        assert_eq!(resolve_screen_asset(&screens, "home", "/ui/index.html"), None);
        assert_eq!(resolve_screen_asset(&screens, "home", ""), None);
    }

    #[test]
    fn v2_service_template_paths_reject_traversal() {
        let mut v = base_v2();
        v["services"] = serde_json::json!([{ "templateFile": "../escape.json" }]);
        assert!(parse(v).unwrap_err().contains("package-relative"));
    }

    #[test]
    fn v2_journalled_command_must_be_declared() {
        let mut v = base_v2();
        v["commands"] = serde_json::json!({ "journalled": ["ghost.command"] });
        assert!(parse(v).unwrap_err().contains("not declared by any connector"));
    }

    #[test]
    fn schema_version_out_of_range_refused() {
        let mut v = base_manifest();
        v["schemaVersion"] = serde_json::json!(3);
        assert!(parse(v).unwrap_err().contains("not supported"));
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
            // schemaVersion 2 is now VALID (PLG-201); 0 and 3 are out of range.
            ("schemaVersion", serde_json::json!(0), "schemaVersion"),
            ("schemaVersion", serde_json::json!(3), "schemaVersion"),
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
