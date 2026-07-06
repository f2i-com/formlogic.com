# MCP OAuth connector — "Authorization with the MCP server failed"

Claude/ChatGPT reach the consent page, you approve, and the client then reports
**"Authorization with the MCP server failed"**. The OAuth flow itself is verified working
end-to-end (discovery → CIMD client fetch → consent → code → PKCE token exchange →
authenticated MCP call all succeed when driven directly against the server, including with
Claude's real published client document). So when a specific remote client fails, the cause is
almost always **environmental** — something between the AI's servers and PHP. Work the list below
in order.

## 1. Read the log — this is decisive

Every OAuth token request is now logged on arrival, and every rejection is logged with its exact
reason. After a failed Claude/ChatGPT attempt, on the server:

```bash
tail -n 100 api/logs/app.log | grep "MCP OAuth"
```

- **You see `token request received` with `ip` in `160.79.104.*`** → the request reached PHP.
  The `request rejected` line right after it names the exact reason (e.g. `PKCE verification
  failed`, `resource does not match`, `Authorization code expired`). Fix that specific cause.
- **You see NOTHING** during the attempt (no `token request received`) → **the request never
  reached PHP.** An edge layer ate it — go to step 2. This is the most common cause.

## 2. Cloudflare / WAF / bot protection (most common)

The AI's token exchange is a server-to-server POST from a datacenter IP range
(**Anthropic: `160.79.104.0/21`**), with no browser fingerprint. Cloudflare "Bot Fight Mode",
"Super Bot Fight Mode", or a WAF managed rule will challenge or block exactly this shape of
request — the AI receives a challenge/HTML page instead of the JSON token and reports an
authorization failure. Discovery (GET) often passes while the POST is challenged.

Fix (Cloudflare dashboard):

- **Security → Bots**: turn OFF Bot Fight Mode, **or** add a WAF *skip* rule (see below).
- **Security → WAF → Custom rules**, create a rule that **Skips** (Bot Fight Mode + Managed
  Rules + Rate limiting) when the path matches the connector surface:
  ```
  (http.request.uri.path starts_with "/api/oauth/")
  or (http.request.uri.path eq "/api/mcp")
  or (http.request.uri.path starts_with "/.well-known/oauth-")
  ```
- Optionally scope it tighter to Anthropic's range: also require
  `ip.src in {160.79.104.0/21}` (OpenAI publishes its own ranges; add theirs for ChatGPT).
- If you use "Under Attack" mode, exclude these paths — a JS challenge is unsolvable by an API
  client.

After changing Cloudflare, remove and re-add the connector in Claude to restart the flow.

## 3. HTTPS + reverse proxy

- The connector requires **public HTTPS** (Secure cookies + the spec). `http://` and LAN hosts
  cannot be reached by hosted Claude/ChatGPT.
- If PHP sits behind a TLS-terminating proxy, it must forward `X-Forwarded-Proto: https` (or set
  `APP_ENV=production`, under which FormLogic already assumes https for the issuer/resource).
  Verify the discovery docs report `https://` URLs:
  ```bash
  curl -s https://YOUR-DOMAIN/.well-known/oauth-authorization-server | grep -o '"issuer":"[^"]*"'
  ```
  It must be `https://YOUR-DOMAIN` (no http, no port surprises).

## 4. Latency

The AI's discovery/registration/token calls time out at ~10s (refresh ~30s). A cold PHP-FPM pool
or a slow first query can exceed this on the very first request. Warm the endpoint (`curl` the
`/.well-known/` docs once) before connecting, and make sure the box isn't swapping.

## 5. Confirm the server itself is healthy (rules the code out)

Run the discovery chain from anywhere — all four must succeed:

```bash
D=https://YOUR-DOMAIN
curl -s -i -X POST $D/api/mcp -d '{}' | grep -i www-authenticate      # 401 + Bearer resource_metadata=...
curl -s $D/.well-known/oauth-protected-resource/api/mcp | head -c 200 # resource == $D/api/mcp
curl -s $D/.well-known/oauth-authorization-server | head -c 200       # issuer, token_endpoint, S256
curl -s "$D/api/oauth/authorize-info?client_id=https%3A%2F%2Fclaude.ai%2Foauth%2Fmcp-oauth-client-metadata&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=aDwRlRF5Ng-bYKUvQzpqhekV2HDaxbf3O9Wo4IXzy6I&code_challenge_method=S256&scope=apps%3Aread&resource=$D%2Fapi%2Fmcp"
```

The last call fetching Claude's client document and returning `{"clientName":"Claude",...}` proves
your server can reach `claude.ai` (CIMD) and the whole AS is live. If that works but the connector
still fails, the problem is between the AI and your server (steps 1–4), not the code.
