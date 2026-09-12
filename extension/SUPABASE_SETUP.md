# Supabase auth setup

## 1. One-time dashboard config (can't be automated from the extension)

In your Supabase project → **Authentication**:

- **Providers**: enable the OAuth provider you're using (e.g. GitHub) and fill in
  its client ID/secret from that provider's own OAuth app settings.
- **URL Configuration → Redirect URLs**: add, verbatim:
  ```
  vscode://<publisher>.<name>/auth-callback
  vscode-insiders://<publisher>.<name>/auth-callback
  ```
  `<publisher>.<name>` must match `publisher` + `name` in `package.json` exactly
  (e.g. `hackathon.agentic-coder`). Add both lines if you or judges might run
  Insiders. Get the exact value from the extension: it's `context.extension.id`.

## 2. Extension-side settings

In VS Code settings (or `.vscode/settings.json` for the team):
```json
{
  "aegis.supabaseUrl": "https://xyzcompany.supabase.co",
  "aegis.supabaseAnonKey": "<anon/public key>",
  "aegis.oauthProvider": "github"
}
```
The anon key is meant to be public/client-side — it's not a secret, Supabase's
row-level security is what actually protects data.

## 3. What the gateway (FastAPI) still needs to do

The extension now hands the gateway a real Supabase-issued JWT as
`Authorization: Bearer <access_token>` on every WS connection. The gateway
must **verify it before `websocket.accept()`**, not trust it blindly:

```python
import jwt  # PyJWT
from fastapi import WebSocket, WebSocketException, status

SUPABASE_JWT_SECRET = os.environ["SUPABASE_JWT_SECRET"]  # Project Settings → API → JWT Secret

async def authenticate(websocket: WebSocket) -> str:
    auth_header = websocket.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)
    token = auth_header.removeprefix("Bearer ")
    try:
        payload = jwt.decode(token, SUPABASE_JWT_SECRET, algorithms=["HS256"], audience="authenticated")
    except jwt.PyJWTError:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)
    return payload["sub"]  # Supabase user id — use this, never a client-supplied id, to look up credits
```

Notes:
- If your Supabase project has migrated to asymmetric JWT signing keys (newer
  projects), verify against the project's JWKS endpoint instead of a shared
  secret — check **Project Settings → API → JWT Keys** to see which mode you're in.
- Look up/decrement credits keyed on that `sub` (the Supabase user id), in a
  `users` table you own in your own Postgres — Supabase's `auth.users` table
  is not where you should store app-specific data like credit balances.
- Reject the connection (`WS_1008_POLICY_VIOLATION` before `accept()`, or an
  `error` event immediately after if you need the client to see the reason)
  if `credits_remaining <= 0`, before `normalize_request` ever runs.
