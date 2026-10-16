"""
oauth_gate.py

Minimal OAuth 2.0 authorization server for the WhatsApp MCP, just enough for
Claude's custom-connector flow (RFC 8414 discovery, RFC 7591 dynamic client
registration, authorization code + PKCE, token exchange).

Gated by a single passphrase (personal use, single user). The access token
issued is the fixed value of OAUTH_GATE_ACCESS_TOKEN, which must equal the
MCP_AUTH_TOKEN that src/mcp.js checks, so /mcp needs no changes.

Required environment variables:
  ISSUER                  public base URL, e.g. https://whatsapp-mcp.example.com
  OAUTH_GATE_PASSPHRASE   passphrase typed on the authorize page
  OAUTH_GATE_ACCESS_TOKEN same value as MCP_AUTH_TOKEN
Optional:
  GATE_PORT               default 8005 (bound to 127.0.0.1)
"""
import base64
import hashlib
import os
import secrets
import time

from flask import Flask, request, redirect, jsonify, Response

app = Flask(__name__)

ISSUER = os.environ["ISSUER"].rstrip("/")
PASSPHRASE = os.environ["OAUTH_GATE_PASSPHRASE"]
FIXED_ACCESS_TOKEN = os.environ["OAUTH_GATE_ACCESS_TOKEN"]
GATE_PORT = int(os.environ.get("GATE_PORT", "8005"))

# In-memory only. Restarts just make Claude re-register and re-authorize.
CLIENTS = {}     # client_id -> {redirect_uris: [...]}
AUTH_CODES = {}  # code -> {client_id, redirect_uri, code_challenge, expires_at}

CODE_TTL_SECONDS = 300


def _b64url_no_pad(raw_bytes):
    return base64.urlsafe_b64encode(raw_bytes).rstrip(b"=").decode()


@app.get("/.well-known/oauth-authorization-server")
def discovery():
    return jsonify({
        "issuer": ISSUER,
        "authorization_endpoint": f"{ISSUER}/authorize",
        "token_endpoint": f"{ISSUER}/token",
        "registration_endpoint": f"{ISSUER}/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    })


@app.post("/register")
def register():
    body = request.get_json(force=True, silent=True) or {}
    redirect_uris = body.get("redirect_uris") or []
    if not redirect_uris:
        return jsonify({"error": "invalid_client_metadata",
                        "error_description": "redirect_uris is required"}), 400
    client_id = secrets.token_urlsafe(16)
    CLIENTS[client_id] = {"redirect_uris": redirect_uris}
    return jsonify({
        "client_id": client_id,
        "redirect_uris": redirect_uris,
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }), 201


PASSPHRASE_FORM = """
<!doctype html>
<html><head><title>WhatsApp MCP - Authorize</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body {{ font-family: -apple-system, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 20px; }}
input {{ font-size: 16px; padding: 10px; width: 100%; box-sizing: border-box; margin: 12px 0; }}
button {{ font-size: 16px; padding: 10px 20px; width: 100%; }}
.error {{ color: #c00; }}
</style></head>
<body>
<h2>Authorize WhatsApp MCP access</h2>
<p>Enter the passphrase to allow this client to connect.</p>
{error}
<form method="POST">
<input type="hidden" name="client_id" value="{client_id}">
<input type="hidden" name="redirect_uri" value="{redirect_uri}">
<input type="hidden" name="state" value="{state}">
<input type="hidden" name="code_challenge" value="{code_challenge}">
<input type="hidden" name="code_challenge_method" value="{code_challenge_method}">
<input type="password" name="passphrase" placeholder="Passphrase" autofocus>
<button type="submit">Authorize</button>
</form>
</body></html>
"""


@app.route("/authorize", methods=["GET", "POST"])
def authorize():
    args = request.args if request.method == "GET" else request.form

    client_id = args.get("client_id", "")
    redirect_uri = args.get("redirect_uri", "")
    state = args.get("state", "")
    code_challenge = args.get("code_challenge", "")
    code_challenge_method = args.get("code_challenge_method", "S256")

    client = CLIENTS.get(client_id)
    if not client or redirect_uri not in client["redirect_uris"]:
        return Response("Unknown client or redirect_uri", status=400)

    if request.method == "GET":
        return PASSPHRASE_FORM.format(
            error="", client_id=client_id, redirect_uri=redirect_uri,
            state=state, code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
        )

    if not secrets.compare_digest(request.form.get("passphrase", ""), PASSPHRASE):
        return PASSPHRASE_FORM.format(
            error='<p class="error">Incorrect passphrase.</p>',
            client_id=client_id, redirect_uri=redirect_uri, state=state,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
        ), 401

    code = secrets.token_urlsafe(32)
    AUTH_CODES[code] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "expires_at": time.time() + CODE_TTL_SECONDS,
    }
    sep = "&" if "?" in redirect_uri else "?"
    dest = f"{redirect_uri}{sep}code={code}"
    if state:
        dest += f"&state={state}"
    return redirect(dest)


@app.post("/token")
def token():
    grant_type = request.form.get("grant_type")

    if grant_type == "refresh_token":
        return jsonify({
            "access_token": FIXED_ACCESS_TOKEN,
            "token_type": "Bearer",
            "refresh_token": request.form.get("refresh_token", "static"),
        })

    if grant_type != "authorization_code":
        return jsonify({"error": "unsupported_grant_type"}), 400

    code = request.form.get("code", "")
    redirect_uri = request.form.get("redirect_uri", "")
    code_verifier = request.form.get("code_verifier", "")

    entry = AUTH_CODES.pop(code, None)
    if not entry or entry["expires_at"] < time.time():
        return jsonify({"error": "invalid_grant"}), 400
    if entry["redirect_uri"] != redirect_uri:
        return jsonify({"error": "invalid_grant",
                        "error_description": "redirect_uri mismatch"}), 400

    expected_challenge = entry.get("code_challenge")
    if expected_challenge:
        computed = _b64url_no_pad(hashlib.sha256(code_verifier.encode()).digest())
        if computed != expected_challenge:
            return jsonify({"error": "invalid_grant",
                            "error_description": "PKCE verification failed"}), 400

    return jsonify({
        "access_token": FIXED_ACCESS_TOKEN,
        "token_type": "Bearer",
        "refresh_token": "static",
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=GATE_PORT)
