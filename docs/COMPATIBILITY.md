# BailingHub Client API Compatibility

This adapter consumes `bailing.client-api.v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/run` | Submit one job through a fixed allowlisted route |
| `GET` | `/jobs/{job_id}` | Read a client-owned job |

The machine-readable declaration is
[`compatibility/client-api.json`](../compatibility/client-api.json). CI compares it with the
current BailingHub contract and rejects:

- endpoint, method, path, or authentication drift;
- a new required request field;
- a removed guaranteed response field;
- unknown or changed status semantics;
- an unclassified public HTTP error;
- adapter limits wider than the core contract.

MCP protocol versions, this npm package version, BailingHub application versions, and Client
API versions are deliberately independent.

The additive Agent Session candidate uses Agent Auth v1 and Agent API v1. It does not alter
the machine-readable `bailing.client-api.v1` compatibility declaration or the behavior of
existing Client Token installations.

Agent Session credential storage currently supports macOS Keychain and an explicitly enabled
current-user-owned mode-0600 file on Linux and other POSIX platforms. Windows fails closed for
Agent Session mode until a native secure credential store is implemented; Client Token mode
remains compatible on Windows.
