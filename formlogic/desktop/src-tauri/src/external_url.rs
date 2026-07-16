//! Validation for URLs handed directly to the operating system's browser
//! launcher.
//!
//! The launchers are invoked with `std::process::Command` arguments (never a
//! shell command), so normal URL query separators such as `&` are data, not
//! metacharacters.  Parsing and canonicalizing the URL gives us a narrower and
//! more reliable trust boundary than a shell-character blacklist.

/// A generous bound for interactive browser links while preventing an
/// accidentally or maliciously huge IPC payload from reaching an OS launcher.
pub const MAX_EXTERNAL_URL_BYTES: usize = 8 * 1024;

/// Parse and validate an external browser URL.
///
/// Only hierarchical HTTP(S) URLs with a valid host and no embedded
/// credentials are accepted. The returned `Url` is the parser's canonical
/// representation; its already-percent-encoded path/query components remain
/// encoded when passed to the launcher.
pub fn validate_external_http_url(raw: &str) -> Result<url::Url, String> {
    if raw.is_empty() {
        return Err("URL is empty".into());
    }
    if raw.len() > MAX_EXTERNAL_URL_BYTES {
        return Err(format!(
            "URL exceeds the {MAX_EXTERNAL_URL_BYTES}-byte limit"
        ));
    }
    // WHATWG URL parsing deliberately strips some ASCII whitespace. Reject it
    // before parsing so a control/whitespace-bearing input cannot validate as
    // a different URL from the bytes supplied by the caller.
    if raw.chars().any(char::is_whitespace) || raw.chars().any(char::is_control) {
        return Err("URL contains whitespace or control characters".into());
    }

    let parsed = url::Url::parse(raw).map_err(|_| "URL is invalid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) URLs are allowed".into());
    }
    // `url` follows the browser URL standard and will repair inputs such as
    // `https:///missing-host` into a different hierarchical URL. The OS
    // launcher should only receive an explicitly formed `scheme://authority`
    // URL, so reject that parser recovery at this trust boundary.
    let authority = raw
        .get(parsed.scheme().len()..)
        .and_then(|suffix| suffix.strip_prefix("://"))
        .and_then(|suffix| suffix.split(['/', '?', '#']).next())
        .filter(|authority| !authority.is_empty())
        .ok_or_else(|| "URL must contain an explicit host".to_string())?;
    if parsed.cannot_be_a_base() || parsed.host().is_none() {
        return Err("URL must contain a valid host".into());
    }
    if authority.contains('@') || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL credentials are not allowed".into());
    }

    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_multi_parameter_oauth_url_without_losing_encoding() {
        let raw = concat!(
            "http://formlogic.local/oauth/authorize?response_type=code",
            "&client_id=formlogic-desktop",
            "&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback",
            "&scope=connector%3Arelay+aokie%3Arealtime",
            "&code_challenge=abc-DEF_123",
            "&code_challenge_method=S256",
            "&state=state_123",
            "&device=DESKTOP-HESQH3A"
        );

        let parsed = validate_external_http_url(raw).expect("OAuth URL is valid");
        assert_eq!(parsed.as_str(), raw);
        assert!(parsed.as_str().contains("&scope="));
        assert!(parsed
            .as_str()
            .contains("connector%3Arelay+aokie%3Arealtime"));
    }

    #[test]
    fn accepts_https_localhost_ipv4_and_ipv6_hosts() {
        for raw in [
            "https://formlogic.local/path?q=one&next=two",
            "http://localhost:1420/",
            "http://127.0.0.1:17872/api/health",
            "http://[::1]:49152/callback?code=x&state=y",
        ] {
            assert!(validate_external_http_url(raw).is_ok(), "rejected {raw}");
        }
    }

    #[test]
    fn rejects_schemes_credentials_missing_or_invalid_hosts_and_controls() {
        for raw in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "data:text/html,hello",
            "ftp://example.com/file",
            "https://user@example.com/",
            "https://user:password@example.com/",
            "https://@example.com/",
            "https:///missing-host",
            "https://exa mple.com/",
            "https://example.com/\nnext",
            "https://example.com/\u{0000}",
        ] {
            assert!(validate_external_http_url(raw).is_err(), "accepted {raw:?}");
        }
    }

    #[test]
    fn rejects_empty_and_oversized_urls() {
        assert!(validate_external_http_url("").is_err());
        let oversized = format!("https://example.com/{}", "a".repeat(MAX_EXTERNAL_URL_BYTES));
        assert!(validate_external_http_url(&oversized).is_err());
    }
}
