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

