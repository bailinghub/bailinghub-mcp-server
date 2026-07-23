# Privacy

`bailinghub-mcp-server` does not collect telemetry and does not send data to the project
maintainers.

For `submit_governed_job`, it sends the following data to the BailingHub deployment selected
by the operator:

- `request_id`;
- the operator-configured `route`;
- `input`.

For job lookup and bounded waiting, it sends the job ID in the request path. The Client Token
is read from process environment and used only in the fixed Authorization header. It is not
exposed as an MCP tool argument or result.

The adapter filters top-level job responses before returning them to the MCP host. Arbitrary
server metadata and dispatch configuration are not included. Public business results inside
the Client API's `result`, `report`, `usage`, and `raw_result` fields may be returned and are
therefore subject to the deploying organization's MCP host, BailingHub, and business-system
retention and privacy policies.

