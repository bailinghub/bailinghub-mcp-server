# Project Boundaries

## Ownership

`bailinghub-mcp-server` is an independent integration adapter with its own repository,
version, tests, issues, npm package, and release process.

## What Belongs Here

- MCP tool schemas and stdio transport behavior;
- the minimal client for BailingHub's public Client API;
- the local Agent Auth client, loopback/PKCE flow, secure credential store, and Agent API
  projection;
- the host-neutral Agent Client SDK transport, public connection aliases, isolated credentials,
  and progressive active-tool projection used by host adapters;
- MCP-specific packaging, discovery metadata, compatibility checks, and documentation;
- adapter-specific threat modeling, security, and privacy behavior.

## What Does Not Belong Here

| Concern | Owning project or layer |
| --- | --- |
| ACC normative fields and conformance | ACC repository |
| BailingHub routes, approvals, runtime behavior, and trace storage | BailingHub repository |
| Business authorization and trusted-subject resolution | Business system |
| MCP protocol and host behavior | MCP project and host implementation |
| DSH/Codex/OpenClaw-specific lifecycle and UI | Each host adapter repository |
| Private host configuration, URLs, tokens, and run evidence | Deploying organization |

## Dependency Direction

```text
bailinghub-mcp-server -> BailingHub public Client API / Agent API
BailingHub may consume ACC declarations
ACC has no dependency on either implementation
```

BailingHub may link to this adapter as an optional integration. It must not import this
package, synchronize versions with it, or change private behavior to satisfy an MCP client.

## Public API Rule

Client Token mode consumes only:

- `POST /run`;
- `GET /jobs/{job_id}`.

Agent Session mode additionally consumes only the public `/agent-auth/v1/*` authorization,
token, session, and revoke endpoints plus the Agent Client v1 workspace, turn, capability
search, governed invocation/resume, and run-completion endpoints. It does not call the
business Client's approval endpoint; that approval belongs to the Hub/business authorization
boundary opened in the system browser.

A missing public capability must be proposed to BailingHub first. This adapter must never
bypass the public contract with an administrator token or private route.

## One Route Per Process

MCP tool arguments are model-influenced input. The route is therefore fixed by the operator
or approved Agent Session at process startup and absent from every tool schema. Multi-route
Client Token installations use separate server processes and route-scoped Client Tokens.

## Subject Rule

The adapter does not accept identity metadata. A model-provided subject is task data, not an
authenticated principal. Trusted subjects must be resolved and verified at a BailingHub or
business-system boundary that has access to authoritative identity context.
