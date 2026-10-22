# Security Policy

Report vulnerabilities through a private GitHub Security Advisory in this repository.
Do not include production tokens, private deployment URLs, personal data, or raw business
payloads in a public issue.

## Supported Versions

Security fixes are provided for the latest published minor version.

## Security Boundary

The MCP server consumes only BailingHub's public Client API or the additive public Agent Auth
and Agent API. It must never receive an administrator token, executor token, tool-provider
secret, business-system credential, or acting-subject credential.

The configured Client Token should be dedicated to one MCP deployment and restricted to the
single configured route. Tool input remains untrusted model output. A BailingHub or business
system boundary must independently resolve any trusted acting subject and final authority.

Agent Session login uses a random `127.0.0.1` callback, `state`, and PKCE S256. It stores the
result in macOS Keychain, or on Linux and other POSIX platforms only after explicit opt-in in
a current-user-owned mode-0600 file. Windows stores only CurrentUser DPAPI-protected ciphertext
under LocalAppData; DPAPI or Windows PowerShell failure closes without a plaintext fallback.
Client Token mode remains compatible. Agent
tokens and login parameters are process-side state and must never become MCP tool arguments.
The adapter does not call the business approval endpoint itself.

The stdio transport reserves stdout for MCP JSON-RPC. Runtime diagnostics must use stderr and
must never contain credentials, private response bodies, or task payloads.

## Dependency Advisory Scope

The official MCP TypeScript SDK is pinned to `1.32.1`. The lockfile also records fixes for
`fast-uri`, `hono`, `ip-address`, and `proxy-addr`. The existing tested
`@hono/node-server` `2.0.12` override remains in place. Dependency changes must pass the
project tests and the production audit gate; normal packaging runs the same checks through
`prepack`. There is no advisory exemption or audit-gate bypass for release packaging.

This package exposes stdio only. The Agent Client SDK uses its own HTTP and authorization
clients with redirects disabled; it does not use the upstream MCP HTTP transports or OAuth
client. No Hono static-file server, MCP HTTP bearer middleware, or experimental MCP
`taskStore` is enabled.

Adding an HTTP transport requires a separate security review. Upgrading the upstream SDK
alone does not enable its optional `maxToolInputElements` budget or bearer
`expectedResource` check. Such an integration must bound request parsing and tool input,
and its token verifier must validate the intended resource and return it as
`AuthInfo.resource`. These are not substitutes for BailingHub's own authorization,
approval, or invocation-size checks.
