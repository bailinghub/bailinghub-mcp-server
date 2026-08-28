# Threat Model

## Assets

- BailingHub Client Token;
- Agent access/refresh tokens and local session binding;
- loopback callback state and PKCE verifier;
- configured route boundary;
- business task text and public job result;
- client-scoped idempotency and job ownership;
- integrity of the MCP stdio protocol.

## Trust Domains

| Domain | Trust assumption |
| --- | --- |
| Model and MCP host input | Untrusted for identity, authority, approval, and route selection |
| MCP server process | Trusted to hold the route-scoped Client Token and enforce projection |
| Local credential store | Trusted to protect an approved Agent Session from other users |
| BailingHub Client API | Trusted to enforce client ownership, route allowlist, rate limits, and contract |
| Business system | Final authority for subject, object state, tenant scope, and business authorization |

## Attacker Capabilities

A compromised prompt, model, or MCP host conversation may:

- choose task text and `request_id`;
- repeat tool calls;
- provide arbitrary job IDs;
- attempt to inject credentials or identity claims into task text;
- cause large, malformed, or adversarial upstream responses.

It must not be able to:

- replace the configured BailingHub origin, Client Token, or route through tool arguments;
- call BailingHub administrator, executor, approval-decision, tool-proxy, or configuration APIs;
- convert task text into a trusted acting subject;
- make the MCP server assert final business authorization;
- force an unbounded wait;
- receive arbitrary top-level BailingHub response fields;
- recover a secret from a raw upstream error body;
- replace the login callback, PKCE verifier, approved Agent client, or approved route.

## Security Invariants

1. Configuration fails closed when URL, Token, or route is absent or malformed.
2. Non-loopback HTTP requires an explicit operator override.
3. Every submission body contains exactly `request_id`, configured `route`, and `input`.
4. Job lookups are limited to UUIDs and BailingHub client ownership.
5. Unknown job statuses fail closed.
6. Response bodies are limited to 1 MiB and top-level fields are projected.
7. Waiting is bounded to 60 seconds and never resubmits a job.
8. stdout contains MCP protocol traffic only; diagnostics use stderr.
9. The adapter never accepts a subject, approval result, credential, callback, metadata, or
   arbitrary route as a tool parameter.
10. Agent login binds a random `127.0.0.1` port, validates `state`, uses PKCE S256, and never
    places access or refresh tokens in CLI output or command arguments.
11. macOS stores Agent credentials in Keychain. Linux and other POSIX platforms have no
    silent plaintext fallback; an explicitly enabled file store requires current-user
    ownership and mode 0600. Windows Agent Session credential storage fails closed until a
    native secure store is implemented.
12. Agent API requests use only the approved session route, retry one 401 after rotating the
    refresh token, and never fall back to the Client API.
13. Multi-connection registry entries contain only public Hub/client/workspace metadata and an
    opaque local instance id; `connectionName` is not an identity assertion. The SDK compares only
    Core's trusted `on_behalf_of`, replaces an older same-binding/same-identity local Session, and
    preserves different identities. A host may expose selection only through user-controlled UI or
    commands, never as a model tool.
14. A newly stored Session remains `authorized` when old-connection inspection or revocation is
    deferred. The SDK returns `cleanupRequired` and preserves unreconciled credentials instead of
    reporting a failed login that could induce another authorization. Registry mutations and
    same-binding reconciliation are cross-process locked; no token or `on_behalf_of` is persisted
    in registry or lock metadata. A Session 401 deletes local credentials only after a lock-held
    comparison confirms the observed Session and tokens are still current.

## Non-Guarantees

This adapter cannot prove that a compromised MCP server process preserved credentials, that
BailingHub itself is uncompromised, or that an audit record authored by one runtime is
independent cryptographic evidence. It also does not provide a delegation chain across
multiple agents. Those require separate trust, attestation, and delegation protocols.

## Validation

Automated tests cover:

- startup configuration and HTTPS policy;
- tool schema exclusion of privileged fields;
- exact request projection and Authorization header;
- top-level response projection;
- unknown status and response-size rejection;
- bounded waiting without resubmission;
- loopback state and PKCE request projection;
- secure credential-store selection and refresh-token rotation;
- Agent API isolation and one bounded 401 refresh retry;
- identity-aware multi-connection reconciliation, safe staged reauthorization, cross-process
  registry locking, compare-before-delete 401 cleanup, secret-free listing, and
  revoke-before-remove failure behavior;
- an end-to-end stdio MCP call against a no-side-effect mock BailingHub.
