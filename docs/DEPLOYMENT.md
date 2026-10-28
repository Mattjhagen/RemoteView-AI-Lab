# Cloudflare Tunnel deployment — airemoteview.buzz

## Status and approval boundary

This release prepares deployment; it does **not** enable a public hostname, DNS record, tunnel connector, or systemd unit. Existing services and tunnel configurations are unchanged. The current local application can still be run with `python3 -m remoteview.app` and reached through the existing SSH forward on localhost:18000.

The commands below are an operator runbook, not commands executed by this release. Installing/starting the app service requires a deliberate cutover of the existing RemoteView process on port 8000. Any change to an existing service/tunnel needs explicit approval. Prefer a **new dedicated tunnel and connector service** so unrelated applications remain untouched. Complete authentication/security validation before the final hostname step.

## Read-only infrastructure inventory

Inspected 2026-10-28:

| Item | Observation |
| --- | --- |
| `cloudflared.service` | Active/enabled, system-level service using a token-file reference. No credential contents read or copied. |
| `cloudflared-purepulse-r510.service` | Active/enabled as `matt`, locally managed through `/home/matt/.cloudflared/config.yml`. Shared ingress contains many unrelated hostnames plus a terminal 404. |
| `cloudflared-purepulse-marketing.service` | Active/enabled as `matt`, token-managed. Token arguments were redacted during inspection. |
| Installed CLI | `/usr/local/bin/cloudflared`, version 2026.10.1. Existing units may use other binary paths; do not replace them. |
| systemd | 255 on Ubuntu. |
| RemoteView listener | 127.0.0.1:8000; do not start a second process on this port. |
| DNS | NS lookup returned `salvador.ns.cloudflare.com` and `haley.ns.cloudflare.com`. Porkbun remains the registrar; no registrar/nameserver change is needed for this preparation. |

The unit files and shared local ingress file were fingerprinted before and after development to verify no edits. No tunnel tokens, certificate contents, account credentials, or unrelated hostname inventory are included in this repository.

## 1. Verify the checkout before installing anything

```sh
cd /home/matt/RemoteView-AI-Lab
python3 -m unittest discover -s tests -v
node --check static/app.js
npm ci
npm run test:e2e
systemd-analyze verify deploy/remoteview-ai.service
cloudflared tunnel --config deploy/cloudflared-remoteview.yml.example ingress validate
```

The browser suite uses two disposable in-memory servers at ports 18765/18766, with mock Ollama responses and a test-only password. It does not authenticate against or modify production services. All security tests must pass before proceeding. Never reuse test passwords for deployment.

## 2. Choose the application password and prepare private configuration

Generate a long, unique password using your password manager. The helper prompts twice without echo and prints only a salted scrypt hash:

```sh
python3 -m remoteview.password
```

After approval to install this new service, prepare its environment file:

```sh
sudo install -o root -g root -m 0600 deploy/remoteview-ai.env.example /etc/remoteview-ai.env
sudoedit /etc/remoteview-ai.env
```

Replace the empty `AUTH_PASSWORD_HASH=` line with the helper's output. Do not store a plaintext password or commit the deployed environment file. Keep the literal `$` characters in the scrypt hash; systemd EnvironmentFile does not perform shell variable expansion. The template intentionally refuses startup until a valid hash is provided.

The required production values are:

```dotenv
OLLAMA_BASE_URL=http://100.92.82.62:11434
OLLAMA_MODEL=qwen2.5-coder:3b
PUBLIC_ORIGIN=https://airemoteview.buzz
TRUSTED_HOSTS=airemoteview.buzz,127.0.0.1,localhost
TRUSTED_PROXIES=127.0.0.1/32
COOKIE_SECURE=true
AUTH_PASSWORD_HASH=<generated-scrypt-hash>
```

`PUBLIC_ORIGIN` requires HTTPS, a trusted hostname, a valid password hash, secure cookies, and explicit proxy addresses. The service also forces `REQUIRE_PUBLIC_CONFIG=1`, so a missing/empty production origin cannot silently fall back to anonymous local mode. Its command forces `PORT=8000` and skips the repository `.env`; the root-owned environment file supplies Ollama and security settings. No Ollama installation, download, or configuration change is needed.

## 3. Private service cutover, after approval

The supplied `remoteview-ai.service` runs as a dedicated non-login user, reads source from the existing project directory, can write only project `data/` under its filesystem sandbox, checks `/healthz` after starting, restarts on failures, and is enabled through `multi-user.target` after operator installation. Its Python listener always binds IPv4 loopback. No firewall or other application configuration change is required.

First identify the **specific existing RemoteView process** with `ss -ltnp 'sport = :8000'` and verify its working directory. Stop only that process through its owning terminal/supervisor. Do not use `killall`, `pkill python`, or stop unrelated services. Do not overwrite an existing `remoteview-ai.service`; inspect and obtain approval if one is present.

While RemoteView is stopped, take a consistent backup and prepare the dedicated identity. These commands are intentionally limited to this app's data and a new account:

```sh
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin remoteview-ai
sudo install -d -o matt -g matt -m 0700 data/backups
python3 - <<'PY'
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
source = sqlite3.connect('data/lab.sqlite3')
path = Path('data/backups') / ('before-systemd-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.sqlite3')
with sqlite3.connect(path) as backup:
    source.backup(backup)
source.close()
print(path)
PY
sudo chown -R remoteview-ai:remoteview-ai /home/matt/RemoteView-AI-Lab/data
sudo find /home/matt/RemoteView-AI-Lab/data -type d -exec chmod 0700 {} +
sudo find /home/matt/RemoteView-AI-Lab/data -type f -exec chmod 0600 {} +
```

If the account already exists, inspect its identity instead of recreating it. The new user needs traversal through `/home/matt`, which is private; grant only traversal on that parent (requires an installed `setfacl` tool). Keep unrelated home directories private:

```sh
sudo setfacl -m u:remoteview-ai:--x /home/matt
sudo -u remoteview-ai test -r /home/matt/RemoteView-AI-Lab/remoteview/app.py
sudo -u remoteview-ai test -w /home/matt/RemoteView-AI-Lab/data
sudo install -o root -g root -m 0644 deploy/remoteview-ai.service /etc/systemd/system/remoteview-ai.service
sudo systemctl daemon-reload
sudo systemctl enable --now remoteview-ai.service
sudo systemctl status remoteview-ai.service --no-pager
sudo journalctl -u remoteview-ai.service -n 40 --no-pager
```

If `setfacl` is unavailable, stop and arrange targeted traversal permission; do not make the whole home directory public. Do not recursively change ownership of the source checkout. The application user is deliberately different from the future dedicated connector user. Existing local browser records stay in SQLite, but cookies do not move automatically from localhost to a new domain. Download important transcripts from the old browser before cutover. Same-host legacy owner cookies are upgraded on successful login with credential rotation; finalized record content is preserved. Cross-host continuity requires a separately designed owner-transfer workflow; never paste owner cookies into public links.

## 4. Validate the private production origin before adding a route

These are local loopback checks. Supplying proxy headers here simulates the explicitly trusted connector; it does not enable a tunnel:

```sh
curl --fail --max-time 5 http://127.0.0.1:8000/healthz
curl --max-time 5 -i http://127.0.0.1:8000/api/sessions
curl --max-time 5 -i http://127.0.0.1:8000/api/sessions \
  -H 'Host: airemoteview.buzz' -H 'X-Forwarded-Proto: https'
curl --max-time 5 -i http://127.0.0.1:8000/api/auth \
  -H 'Host: airemoteview.buzz' -H 'X-Forwarded-Proto: https'
ss -ltnp 'sport = :8000'
```

Expected: health 200 with only `{"status":"ok"}`; plain-origin data request 403; simulated HTTPS unauthenticated data request 401; auth bootstrap 200 with a `__Host-rv_csrf` cookie containing `Secure; HttpOnly; SameSite=Strict; Path=/`, no Domain attribute, and HSTS. Listener must show **127.0.0.1:8000**, never 0.0.0.0 or an external address. No private session, target, transcript, model list, or judge assignment may appear without login. Authentication tests exercise valid/invalid passwords, expiry, logout, fixation protection, cross-browser isolation, and same-host legacy migration.

`/healthz` is intentionally unauthenticated and returns no version, paths, counts, configuration, or model details. It checks database responsiveness without calling Ollama, so an Ollama outage does not cause a restart loop. Use this local URL for origin monitoring. Once Access is configured, external health monitoring must authenticate to Access; do not add a public bypass rule.

## 5. Configure Cloudflare Access first (additional protective layer)

In Cloudflare Zero Trust, create a **self-hosted Access application** for all of `airemoteview.buzz` (all paths, including APIs and judging images). Use an explicit approved-email/group allow policy, a short session duration, and an identity provider with MFA where available. Do not select Everyone or add Bypass policies. Keep the application's own password login enabled.

Record the Access team subdomain and application AUD tag. Enable **Protect with Access** / token validation on the connector's public-hostname origin settings. `cloudflared` must validate the Access JWT before forwarding; merely trusting a `Cf-Access-Authenticated-User-Email` header is not authentication. The application intentionally ignores Cloudflare identity headers. [Cloudflare documents connector-side Access validation and the required team/AUD parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/#access).

## 6. Dedicated tunnel/connector, without touching existing units

After the private-origin security checks pass and the operator approves the network step:

1. In the Cloudflare dashboard, create a **new remotely managed tunnel** named `remoteview-ai` in the account that owns `airemoteview.buzz`. Do not add a public hostname yet. Obtain its connector token privately.
2. Use a new connector identity and directory. Do not copy existing tunnels' tokens or edit their units/configuration files:

   ```sh
   sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin cloudflared-remoteview
   sudo install -d -o root -g cloudflared-remoteview -m 0750 /etc/cloudflared-remoteview
   sudo install -o root -g cloudflared-remoteview -m 0640 /dev/null /etc/cloudflared-remoteview/token
   sudoedit /etc/cloudflared-remoteview/token
   ```

   Paste only the **new tunnel token** into that file. Never put it into shell arguments, shell history, Git, or a shared service. Inspect existing names before creating anything; do not overwrite existing files.
3. Review and install `deploy/cloudflared-remoteview.service.example` as a **new** `/etc/systemd/system/cloudflared-remoteview.service`. It uses the existing `/usr/local/bin/cloudflared` with a token file. It does not run `cloudflared service install`, which could replace the existing generic service. Then `sudo systemctl daemon-reload` and `sudo systemctl enable --now cloudflared-remoteview.service`. With no hostname configured, this connector does not route this app publicly.
4. Verify the dedicated connector is healthy and the existing three tunnel services remain active. Set Access protection/team/AUD and the origin values in the next step **before saving** the hostname. Do not save an unprotected hostname temporarily.

For a separately approved **locally managed** dedicated tunnel, `deploy/cloudflared-remoteview.yml.example` documents equivalent origin and Access validation settings. Replace its UUID/credential/team/AUD placeholders with that new tunnel's values and validate with `cloudflared tunnel --config <dedicated-file> ingress validate`. This is an alternative to token-managed configuration, not an instruction to merge it into `/home/matt/.cloudflared/config.yml`.

## 7. Final public-routing step — not performed in this task

Only after approval and successful private checks, publish the dedicated tunnel hostname with:

| Field | Value |
| --- | --- |
| Hostname | `airemoteview.buzz` (apex; no subdomain) |
| Service type / URL | HTTP / `127.0.0.1:8000` |
| HTTP Host Header | `airemoteview.buzz` |
| Disable Chunked Encoding | Enabled (`disableChunkedEncoding: true`), matching the origin’s strict Content-Length framing |
| Protect with Access | Enabled; correct team subdomain and Access application AUD |
| All other hostnames | No route in this dedicated tunnel |

The connector must preserve/set `X-Forwarded-Proto: https` from Cloudflare and the real single-valued `CF-Connecting-IP`. The app ignores `Forwarded`, `X-Forwarded-Host`, `X-Forwarded-For`, `X-Real-IP`, and Access identity headers. It trusts only X-Forwarded-Proto and CF-Connecting-IP from explicitly configured peer IP networks. Never configure `0.0.0.0/0` as a trusted proxy, rewrite Host to localhost, enable a broad wildcard hostname, or open port 8000 externally. Another proxy hop requires a fresh trust review; a Docker bridge is not IPv4 loopback.

Cloudflare's hostname workflow creates a proxied DNS record targeting the new tunnel UUID (`<UUID>.cfargotunnel.com`). Inspect existing apex records first; obtain approval before replacing any conflict. Because Cloudflare is authoritative DNS, do not add an R510 A record at Porkbun, change nameservers, or expose inbound ports. [Cloudflare's tunnel documentation describes hostname-to-local-service routing](https://developers.cloudflare.com/tunnel/); [its header reference defines the visitor protocol/IP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

After publication, verify an unapproved identity is denied at Access, an approved identity still reaches the application password gate, app cookies are Secure/HttpOnly/host-only, and a full disposable session still seals, blind-judges, and reveals correctly. Remove the route immediately if either authentication layer fails. Existing localhost/SSH access remains separate; in production mode it serves only health over plain HTTP, so use the HTTPS hostname for the application.

## Operation and rollback

- App logs: `sudo journalctl -u remoteview-ai.service -f`; connector logs: `sudo journalctl -u cloudflared-remoteview.service -f`. Treat backup files, cookies, judge links, environment files and connector tokens as private. App logs omit judge capabilities and request query strings/bodies.
- Password change: replace `AUTH_PASSWORD_HASH` in `/etc/remoteview-ai.env` and restart **only** `remoteview-ai.service`. A changed password hash automatically revokes existing authentication sessions at startup. For immediate emergency revocation without changing the password, run `sudo -u remoteview-ai /usr/bin/python3 -m remoteview.sessions revoke-all` from the project directory. Existing observations/results remain intact. This helper is local administration, not a web API.
- Rate limits are per-process/per-minute fixed windows: requests 120/client, login 5/client plus global 30, inference 10/client and 10/owner; inference concurrency 2 and HTTP workers 24. Headers cap at 16 KiB, URL at 4 KiB, body at 40000 bytes, and reading at an absolute 15-second deadline. Tune only in the private environment file after review. Keep Cloudflare rate/WAF protections as an additional layer; process-local counters reset on restart.
- To withdraw deployment, remove **only this new hostname route**, then stop/disable **only** the dedicated RemoteView connector and app units. Do not stop existing generic/PurePulse services. Preserve `/etc/remoteview-ai.env`, the database, and backups. Restore data from a consistent SQLite backup only while the app is stopped, with service-user ownership and 0600 permissions.
- The shared app password is an admission gate, not per-person accounts or roles. Owner cookies still partition browser history. Any judge needs both Access/app admission and its assignment link. The service is not a credential-isolated target vault, and local administrators remain trusted.
