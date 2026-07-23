# Project Boundaries

## Ownership

`bailinghub-mcp-server` is an independent integration adapter with its own repository,
version, tests, issues, npm package, and release process.

## What Belongs Here

- MCP tool schemas and stdio transport behavior;
- the minimal client for BailingHub's public Client API;
- MCP-specific packaging, discovery metadata, compatibility checks, and documentation;
- adapter-specific threat modeling, security, and privacy behavior.

## What Does Not Belong Here

| Concern | Owning project or layer |
| --- | --- |
| ACC normative fields and conformance | ACC repository |
| BailingHub routes, approvals, runtime behavior, and trace storage | BailingHub repository |
| Business authorization and trusted-subject resolution | Business system |
| MCP protocol and host behavior | MCP project and host implementation |
| Private host configuration, URLs, tokens, and run evidence | Deploying organization |

## Dependency Direction

```text
bailinghub-mcp-server -> BailingHub public Client API
BailingHub may consume ACC declarations
ACC has no dependency on either implementation
```

BailingHub may link to this adapter as an optional integration. It must not import this
package, synchronize versions with it, or change private behavior to satisfy an MCP client.

## Public API Rule

The adapter consumes only:

- `POST /run`;
- `GET /jobs/{job_id}`.

A missing public capability must be proposed to BailingHub first. This adapter must never
bypass the public contract with an administrator token or private route.

## One Route Per Process

MCP tool arguments are model-influenced input. The route is therefore fixed by the operator
at process startup and absent from every tool schema. Multi-route installations use separate
server processes and separate route-scoped Client Tokens.

## Subject Rule

The adapter does not accept identity metadata. A model-provided subject is task data, not an
authenticated principal. Trusted subjects must be resolved and verified at a BailingHub or
business-system boundary that has access to authoritative identity context.

