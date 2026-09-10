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

The optional host SDK conversation archive API, added in 0.4.0, has a Core 0.6.0 API minimum;
Core 0.7.0 is the matching server for the 0.5.0 feature set. It sends visible user/assistant text, stable
archive/event/turn IDs, frozen Agent Session membership, display labels and original run links
to the selected BailingHub deployment. Every member must confirm with its own credential before
combined text is accepted. Text is stored once in the administrative audit domain and is not
copied into each authorization's memory. The SDK does not persist a transcript queue: the host
must define and disclose its local durable outbox, retention and retry behavior. Hidden reasoning,
attachments, arbitrary tool payloads and credentials are not part of the archive DTO. The standalone
MCP tools do not automatically capture conversations or call this host-only API.

Version 0.5.0 adds each selected member's public Client App and route
to archive registration, with one independent Session per target on the same Hub and within one
administrator audit domain. Its capability
probe sends no conversation body. Frozen Hub URLs and connection keys remain local. Hosts must
explicitly select the participating systems and limit each system's business input to the task
it needs; using one Hub is not permission to broadcast other systems' results. Combined text
retains the same administrator-only audit visibility and is not written into each system's memory.

Optional authorization subject names are business-provided display data, separate from credentials and
identity. The SDK stores them in a mode-0600 sidecar bound to the original connection, Hub, app,
workspace and Session. `connectionsList()` reads this local cache without contacting the Hub;
`status()` can refresh it after identity validation. Cached names do not prove that an authorization
is currently valid. Controlled system descriptions are read only for selected targets, without
sending conversation text, creating a business run or loading business tools.
