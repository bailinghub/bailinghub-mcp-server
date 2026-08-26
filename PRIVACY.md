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
restricted to a current-user-owned mode-0600 file. Windows Agent Session credential storage
is not yet supported and fails closed. Logout removes local credentials only after the remote
revocation endpoint confirms success; otherwise it keeps them so revocation can be retried.

The adapter filters top-level job responses before returning them to the MCP host. Arbitrary
server metadata and dispatch configuration are not included. Public business results inside
the Client API's `result`, `report`, `usage`, and `raw_result` fields may be returned and are
therefore subject to the deploying organization's MCP host, BailingHub, and business-system
retention and privacy policies.
