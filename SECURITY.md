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
a current-user-owned mode-0600 file. Windows Agent Session credential storage fails closed
until a native secure store is implemented; Client Token mode remains compatible. Agent
tokens and login parameters are process-side state and must never become MCP tool arguments.
The adapter does not call the business approval endpoint itself.

The stdio transport reserves stdout for MCP JSON-RPC. Runtime diagnostics must use stderr and
must never contain credentials, private response bodies, or task payloads.

## Dependency Advisory Scope

The official MCP TypeScript SDK `1.29.0` currently depends on
`@hono/node-server` `1.x`, which is covered by `GHSA-frvp-7c67-39w9`. The advisory concerns
Windows path traversal in Hono's static-file serving helper.

This package exposes stdio only. It does not start Hono, serve files, or expose an HTTP
transport, so the vulnerable code path is not reachable through this adapter. CI still blocks
high and critical production dependency advisories. This exception must be removed when the
official SDK adopts a compatible fixed dependency; the project must not force an unverified
cross-major override merely to suppress the audit report.
