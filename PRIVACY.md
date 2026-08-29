# Privacy

`bailinghub-mcp-server` does not collect telemetry and does not send data to the project
maintainers.

For `submit_governed_job`, it sends the following data to the BailingHub deployment selected
by the operator:

- `request_id`;
- the operator-configured `route`;
- `input`.

For job lookup and bounded waiting, it sends the job ID in the request path. In compatible
mode the Client Token is read from process environment and used only in the fixed
Authorization header. In Agent Session mode, login sends the public client ID, requested
route, device label, loopback redirect, state, and PKCE challenge; token exchange sends the
one-time code and PKCE verifier. Access and refresh tokens are stored locally and used only
with the configured BailingHub deployment. No credential is exposed as an MCP tool argument,
result, or CLI status field.

macOS Agent credentials are stored in Keychain. Linux and other POSIX platforms have no
automatic plaintext fallback. If the operator explicitly enables the file store, it is
restricted to a current-user-owned mode-0600 file. Windows stores a CurrentUser DPAPI-protected
binary file under LocalAppData; the file contains ciphertext rather than a portable login, and
PowerShell/DPAPI failure does not enable plaintext storage. Logout removes local credentials only after the remote
revocation endpoint confirms success; otherwise it keeps them so revocation can be retried.

The multi-connection registry stores only public connection name, normalized Hub URL, public
client app id, workspace, insecure-HTTP opt-in, timestamps, and current selection. Credentials are
stored separately per binding. Connection listing never returns access or refresh tokens, and
connection removal follows the same remote-revoke-before-local-delete rule as logout.

The adapter filters top-level job responses before returning them to the MCP host. Arbitrary
server metadata and dispatch configuration are not included. Public business results inside
the Client API's `result`, `report`, `usage`, and `raw_result` fields may be returned and are
therefore subject to the deploying organization's MCP host, BailingHub, and business-system
retention and privacy policies.
