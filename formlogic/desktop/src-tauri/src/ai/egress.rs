//! AI-404 — outbound egress hardening for the AI gateway.
//!
//! A provider `baseUrl` is user-supplied and may point anywhere, so every
//! outbound request is validated + the resolved address pinned:
//!   * HTTPS required unless the host is loopback (an explicit LAN/loopback
//!     opt-in is the ONLY way a plaintext or private endpoint is allowed);
//!   * no embedded credentials, no control/whitespace;
//!   * DNS is resolved HERE and the socket pinned to the resolved address
//!     (rebinding protection); every resolved address must be a public unicast
//!     IP — loopback, link-local, metadata (169.254.169.254), unique-local,
//!     multicast, and RFC-1918 private ranges are refused for a non-loopback
//!     provider;
//!   * redirects are disabled at the client (a 3xx is surfaced, never
//!     followed to a fresh, unvalidated host).
//!
//! Mirrors the aokie plugin's endpoint_http posture; kept desktop-local so the
//! gateway has no cross-repo dependency.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};

/// Whether a provider endpoint has opted into LAN/loopback (plaintext http or
/// a private/loopback host). Off by default: a normal cloud provider is HTTPS
/// to a public host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalAccess {
    /// Public HTTPS only (the default for cloud providers).
    PublicOnly,
    /// The user explicitly allowed a loopback / private / plaintext endpoint
    /// (a local model server, an on-prem gateway).
    AllowLocal,
}

#[derive(Debug)]
pub struct EgressError(pub String);

impl std::fmt::Display for EgressError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// A validated outbound target: the parsed URL plus the single resolved socket
/// address the client must pin to.
pub struct ValidatedTarget {
    pub url: url::Url,
    pub host: String,
    pub port: u16,
    pub pinned: std::net::SocketAddr,
    pub is_loopback: bool,
}

fn ip_is_public_unicast(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_public(v4),
        IpAddr::V6(v6) => ipv6_public(v6),
    }
}

fn ipv4_public(ip: Ipv4Addr) -> bool {
    // Refuse loopback, private, link-local (incl. 169.254.169.254 metadata),
    // broadcast, documentation, shared (CGNAT), multicast, unspecified.
    if ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || ip.is_unspecified()
    {
        return false;
    }
    let o = ip.octets();
    // 100.64.0.0/10 CGNAT (shared address space) — not stable in std as a
    // predicate, check by hand.
    if o[0] == 100 && (o[1] & 0xC0) == 0x40 {
        return false;
    }
    // 0.0.0.0/8 "this network".
    if o[0] == 0 {
        return false;
    }
    true
}

fn ipv6_public(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    // Map an IPv4-mapped/-compatible address and re-check as v4.
    if let Some(v4) = ip.to_ipv4() {
        return ipv4_public(v4);
    }
    let seg = ip.segments();
    // fe80::/10 link-local, fc00::/7 unique-local.
    if (seg[0] & 0xffc0) == 0xfe80 {
        return false;
    }
    if (seg[0] & 0xfe00) == 0xfc00 {
        return false;
    }
    true
}

/// Validate a base URL + capability path into a pinned outbound target.
/// `access` decides whether a loopback/private/plaintext endpoint is allowed.
pub fn validate(base_url: &str, path: &str, access: LocalAccess) -> Result<ValidatedTarget, EgressError> {
    if base_url.len() > 4096 {
        return Err(EgressError("provider base URL is too long".into()));
    }
    if base_url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(EgressError("provider base URL has control/whitespace characters".into()));
    }
    // Join base + path without letting an absolute path escape the base.
    let base = base_url.trim_end_matches('/');
    let joined = if path.is_empty() {
        base.to_string()
    } else {
        format!("{base}/{}", path.trim_start_matches('/'))
    };
    let url = url::Url::parse(&joined).map_err(|_| EgressError("provider URL is invalid".into()))?;
    match url.scheme() {
        "https" => {}
        "http" => {
            if access != LocalAccess::AllowLocal {
                return Err(EgressError(
                    "plaintext http is only allowed for endpoints you explicitly marked local".into(),
                ));
            }
        }
        other => return Err(EgressError(format!("unsupported URL scheme {other:?}"))),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(EgressError("provider URL must not embed credentials".into()));
    }
    let host = url
        .host_str()
        .ok_or_else(|| EgressError("provider URL has no host".into()))?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| EgressError("provider URL has no port".into()))?;

    // Resolve DNS once and pin. A bare IP literal resolves to itself.
    let addrs: Vec<std::net::SocketAddr> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| EgressError(format!("cannot resolve {host}: {e}")))?
        .collect();
    if addrs.is_empty() {
        return Err(EgressError(format!("{host} did not resolve to any address")));
    }
    // Every resolved address must satisfy the policy (a name that resolves to
    // multiple addresses can't smuggle a private one in).
    let mut chosen: Option<std::net::SocketAddr> = None;
    let mut any_loopback = false;
    for a in &addrs {
        let public = ip_is_public_unicast(a.ip());
        let loopback = a.ip().is_loopback();
        any_loopback = any_loopback || loopback;
        match access {
            LocalAccess::PublicOnly => {
                if !public {
                    return Err(EgressError(format!(
                        "{host} resolves to a non-public address ({}) — refused (mark the provider \
                         local to allow loopback/private endpoints)",
                        a.ip()
                    )));
                }
            }
            LocalAccess::AllowLocal => {
                // Local providers may be loopback OR public; still refuse
                // metadata/link-local (169.254.x) which is never a legitimate
                // model endpoint.
                if let IpAddr::V4(v4) = a.ip() {
                    if v4.is_link_local() {
                        return Err(EgressError(
                            "link-local addresses (169.254.x) are never allowed".into(),
                        ));
                    }
                }
                if let IpAddr::V6(v6) = a.ip() {
                    if (v6.segments()[0] & 0xffc0) == 0xfe80 {
                        return Err(EgressError("link-local IPv6 is never allowed".into()));
                    }
                }
            }
        }
        if chosen.is_none() {
            chosen = Some(*a);
        }
    }
    let pinned = chosen.expect("at least one address");
    Ok(ValidatedTarget {
        url,
        host,
        port,
        pinned,
        is_loopback: any_loopback,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_only_rejects_private_and_metadata() {
        // These are IP literals so DNS resolution is deterministic.
        assert!(validate("http://127.0.0.1:8080", "v1/models", LocalAccess::PublicOnly).is_err());
        assert!(validate("https://127.0.0.1:8080", "v1/models", LocalAccess::PublicOnly).is_err());
        assert!(validate("https://10.0.0.5", "x", LocalAccess::PublicOnly).is_err());
        assert!(validate("https://192.168.1.10", "x", LocalAccess::PublicOnly).is_err());
        assert!(validate("https://169.254.169.254", "latest/meta-data", LocalAccess::PublicOnly).is_err());
        assert!(validate("https://100.64.0.1", "x", LocalAccess::PublicOnly).is_err());
    }

    #[test]
    fn public_https_ip_is_allowed() {
        // 1.1.1.1 is a public unicast literal — validate w/o a network round trip.
        let t = validate("https://1.1.1.1", "v1/models", LocalAccess::PublicOnly).expect("public ok");
        assert_eq!(t.host, "1.1.1.1");
        assert_eq!(t.port, 443);
        assert!(!t.is_loopback);
    }

    #[test]
    fn allow_local_permits_loopback_but_not_link_local() {
        let t = validate("http://127.0.0.1:11434", "v1/chat/completions", LocalAccess::AllowLocal)
            .expect("loopback allowed when local");
        assert!(t.is_loopback);
        assert!(validate("http://169.254.169.254", "x", LocalAccess::AllowLocal).is_err());
    }

    #[test]
    fn plaintext_public_refused_and_credentials_refused() {
        assert!(validate("http://1.1.1.1", "x", LocalAccess::PublicOnly).is_err());
        assert!(validate("https://user:pw@1.1.1.1", "x", LocalAccess::PublicOnly).is_err());
        assert!(validate("ftp://1.1.1.1", "x", LocalAccess::PublicOnly).is_err());
    }
}
