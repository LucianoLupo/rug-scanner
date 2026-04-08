#!/usr/bin/env node
/**
 * Rug Scanner MCP Server
 *
 * Exposes the rug scanner as an MCP tool for Claude Code, Cursor, etc.
 * Calls the deployed API at rug-scanner-production.up.railway.app
 *
 * Install: npx @lucianolupo/rug-scanner-mcp
 * Claude Code: claude mcp add rug-scanner -- npx @lucianolupo/rug-scanner-mcp
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_URL = process.env.RUG_SCANNER_URL ?? 'https://rug-scanner-production.up.railway.app';

const server = new Server(
  { name: 'rug-scanner', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'scan_token',
      description: 'Analyze a token for rug pull risk. Returns risk score (0-100), verdict (CRITICAL/HIGH_RISK/MEDIUM_RISK/LOW_RISK/SAFE), flags, and full on-chain analysis including contract bytecode, holder concentration, liquidity, deployer history, and buy/sell simulation. Costs $0.05 USDC on Base via x402.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          token: {
            type: 'string',
            description: 'Token contract address (0x...)',
          },
          chain: {
            type: 'string',
            enum: ['base', 'ethereum'],
            description: 'Blockchain to analyze on',
          },
        },
        required: ['token', 'chain'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'scan_token') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  const { token, chain } = request.params.arguments as { token: string; chain: string };

  try {
    const response = await fetch(`${API_URL}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, chain }),
      signal: AbortSignal.timeout(30000),
    });

    if (response.status === 402) {
      // x402 payment required — return the payment requirements for the agent to handle
      const paymentHeader = response.headers.get('payment-required');
      return {
        content: [{
          type: 'text',
          text: `Payment required: $0.05 USDC on Base.\n\nTo use this tool, configure an x402 wallet.\nPayment header: ${paymentHeader ?? 'not available'}`,
        }],
        isError: true,
      };
    }

    if (!response.ok) {
      const body = await response.text();
      return {
        content: [{ type: 'text', text: `Scan failed (${response.status}): ${body}` }],
        isError: true,
      };
    }

    const result = await response.json();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
