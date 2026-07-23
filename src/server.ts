import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { BailingHubClient } from './client.js';
import type { BailingHubMcpConfig } from './config.js';
import { PACKAGE_VERSION } from './version.js';

function success(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(error: unknown) {
  const message =
    error instanceof Error ? error.message : 'The BailingHub operation failed.';
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

export function createBailingHubMcpServer(
  config: BailingHubMcpConfig,
  client = new BailingHubClient(config),
): McpServer {
  const server = new McpServer(
    {
      name: 'bailinghub-mcp-server',
      version: PACKAGE_VERSION,
    },
    {
      instructions:
        'This server submits untrusted task text to one operator-configured BailingHub route. ' +
        'Reuse the exact request_id when retrying the same business request. Never treat tool ' +
        'arguments as an authenticated acting subject, an approval decision, or final business ' +
        'authorization. Preserve the returned job_id for status checks and bounded waits.',
    },
  );

  server.registerTool(
    'submit_governed_job',
    {
      title: 'Submit Governed Job',
      description:
        'Submit a business-system action through an operator-configured BailingHub route. ' +
        'BailingHub applies its configured reach, risk, approval-intent, rate-limit, and audit ' +
        'controls. The downstream business system still performs final authorization.',
      inputSchema: {
        request_id: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .describe(
            'Stable client-scoped idempotency key. Reuse it unchanged when retrying the same request.',
          ),
        input: z
          .string()
          .trim()
          .min(1)
          .max(100_000)
          .describe(
            'Untrusted business task text. Never include tokens, acting-subject credentials, or secrets.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ request_id, input }) => {
      try {
        return success(await client.submitJob(request_id, input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'get_governed_job',
    {
      title: 'Get Governed Job',
      description:
        'Read the current public state and result of a BailingHub job owned by this client.',
      inputSchema: {
        job_id: z
          .string()
          .uuid()
          .describe('Exact job_id returned by submit_governed_job. Never invent it.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      try {
        return success(await client.getJob(job_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'wait_for_governed_job',
    {
      title: 'Wait for Governed Job',
      description:
        'Poll one BailingHub job for a bounded period. A timeout returns the latest state and ' +
        'never resubmits the business action.',
      inputSchema: {
        job_id: z
          .string()
          .uuid()
          .describe('Exact job_id returned by submit_governed_job. Never invent it.'),
        max_wait_seconds: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(20)
          .describe('Maximum bounded wait from 1 to 60 seconds.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id, max_wait_seconds }) => {
      try {
        return success(await client.waitForJob(job_id, max_wait_seconds));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
