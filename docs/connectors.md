# Connectors and MCP (phone + laptop)

*2026-09-19. Design agreed with the user; implementation in phases below.*

## What the user chose

- **Google first, as a built-in connector** (Gmail, Calendar, Drive through
  Google's REST APIs), not Google's official MCP servers: those are a
  Workspace Developer Preview and need a Workspace account; the user's
  account is a personal gmail.com one.
- **Custom MCP servers**: add any server by URL (both devices) or by command
  (laptop only).
- **Sync definitions and tokens.** A connector added on one device appears on
  the other. Secrets (OAuth refresh tokens, API keys) sync too, **encrypted on
  the device** with a key derived from a sync passphrase the user types once
  per device. Supabase only ever stores ciphertext.
- **Phone reach:** URL servers run on both; command (stdio) servers are
  laptop-only and show as "laptop only" on the phone.

## Architecture

```
 Settings (frontend)          IndexedDB / localStorage        Supabase
 ─ Google: client id/secret,  connectors table (synced)  ⇄    connectors
   Connect / Disconnect       secrets: AES-GCM ciphertext      (ciphertext only)
 ─ MCP servers: add/test/     passphrase-derived key
   toggle tools               (PBKDF2, never stored remotely)
          │ decrypted on device, handed over on connect (memory only,
          ▼ same rule as the OpenRouter key: /api/local/credentials)
 Backend  app/connectors/
 ─ registry.py   live connectors → ToolSpecs (dynamic, per process)
 ─ google.py     OAuth (installed-app, PKCE, loopback redirect) + Gmail/
                 Calendar/Drive tools
 ─ mcp_client.py minimal MCP client: Streamable HTTP (both devices) and
                 stdio (laptop), initialize → tools/list → tools/call
          │ tools join tools.enabled_specs(); routed by keyword groups
          ▼
 Agent turn: model calls gmail_search / calendar_create_event / mcp__srv__tool
```

### Why a minimal MCP client of our own
The official Python SDK (v2) pulls a new HTTP stack and many dependencies
that must also build under Chaquopy on Android. The subset JARVIS needs
(JSON-RPC `initialize`, `tools/list`, `tools/call`, `Mcp-Session-Id`, JSON or
SSE responses, stdio framing) is small and has no new dependencies, so it
runs unchanged on both platforms. Revisit if servers need sampling,
elicitation or resources.

### Google sign-in
- The user creates one free **Google Cloud OAuth client, type "Desktop app"**,
  and enables the Gmail, Calendar and Drive APIs. The client id/secret are
  entered in Settings and sync (a Desktop-app secret is not confidential by
  Google's own definition, but it is stored encrypted anyway).
- Sign-in runs on the laptop: the browser opens Google's consent page with
  PKCE, Google redirects to `http://127.0.0.1:8000/api/connectors/google/callback`
  (the local backend), which exchanges the code for tokens.
- The refresh token is encrypted and synced, so the **phone needs no sign-in
  of its own**. Access tokens are refreshed in memory on each device.
- The OAuth app should be set to **In production** (unverified is fine for a
  personal app, with a warning screen at consent). In **Testing**, Google
  expires refresh tokens after 7 days.
- Scopes: `gmail.readonly`, `gmail.compose` (drafts + send),
  `calendar.events`, `drive.readonly`.

### Tools offered to the model (Google)
| Tool | Effect | Gate |
|---|---|---|
| `gmail_search` | list matching threads (from, subject, date, snippet) | read |
| `gmail_read` | one message's text (truncated) | read |
| `gmail_draft` | create a draft | medium, no confirm (nothing leaves) |
| `gmail_send` | send a message | **confirm** (preview, then `confirmed=true`) |
| `calendar_list_events` | events in a range / matching text | read |
| `calendar_create_event` | add an event | confirm only if it has guests |
| `calendar_delete_event` | delete an event | **confirm** |
| `drive_search` | find files | read |
| `drive_read` | a file's text (Docs exported as text) | read |

MCP tools are offered as `mcp__<server>__<tool>`. Tools whose MCP annotations
say `readOnlyHint` run directly; everything else goes through the same
confirm step. Per-tool enable toggles live in Settings.

### Safety rules
- Email bodies, file contents and MCP results are **untrusted data**: wrapped
  and labelled as such in the tool result; they never change permissions.
- Sending, deleting and any non-read-only MCP tool always need the user's yes.
- Secrets are never logged, never written to backend files, and only
  ciphertext leaves the device.
- Only the tools of connected services are offered, and only when a turn's
  words route to them, so the prompt (and cost) stays small.

## Phases
1. **Backend core** — connector registry, Google OAuth + tools, MCP client
   (HTTP + stdio), API endpoints, offline tests against fakes. *(in progress)*
2. **Frontend** — Settings UI, `connectors` synced table (IndexedDB, backend
   sync columns, Supabase SQL), passphrase encryption, hand-off to backend.
3. **Builds + live checks** — laptop sign-in with the user's Google account,
   phone using the synced token, one real MCP server end to end.
