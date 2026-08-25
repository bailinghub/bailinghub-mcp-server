#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { runCli } from './cli.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createBailingHubMcpServer } from './server.js';

async function main(): Promise<void> {
  if (await runCli(process.argv.slice(2))) return;

  const config = await loadRuntimeConfig();
  const server = createBailingHubMcpServer(config);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await server.connect(transport);
  console.error('BailingHub MCP Server is running on stdio.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup failure.';
  console.error(`BailingHub MCP Server failed to start: ${message}`);
  process.exit(1);
});
