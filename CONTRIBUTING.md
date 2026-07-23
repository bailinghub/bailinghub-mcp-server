# Contributing

Issues and pull requests are welcome.

Before submitting a change:

```bash
npm install
npm run verify
npm pack --dry-run
```

Keep protocol changes in the project that owns them:

- MCP tool schemas, stdio behavior, packaging, and adapter security belong here;
- BailingHub Client API behavior belongs in BailingHub;
- portable governance semantics belong in ACC;
- final authorization and trusted-subject resolution belong in the business system.

Do not commit credentials, private MCP host configuration, deployment URLs, production
payloads, or raw E2E evidence.

