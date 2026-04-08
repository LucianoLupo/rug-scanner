/**
 * x402 diagnostic script — tests the payment flow step by step:
 * 1. Sends unpaid request → expects 402
 * 2. Parses 402 response (headers + body) exactly as @x402/fetch would
 * 3. Optionally creates payment and resends if PRIVATE_KEY is set
 *
 * Usage:
 *   npx tsx scripts/x402-diag.ts                         # Test 402 response only
 *   npx tsx scripts/x402-diag.ts http://localhost:3000    # Against local server
 *   PRIVATE_KEY=0x... npx tsx scripts/x402-diag.ts        # Full payment flow
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const API_URL = process.argv[2] || 'https://rug-scanner-production.up.railway.app';
const TOKEN_TO_SCAN = '0x4200000000000000000000000000000000000006'; // WETH on Base

async function step1_test402() {
  console.log('=== STEP 1: Test 402 response ===');
  console.log(`URL: ${API_URL}/scan`);
  console.log('');

  const response = await fetch(`${API_URL}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN_TO_SCAN, chain: 'base' }),
  });

  console.log(`Status: ${response.status}`);
  console.log('');

  // Log all response headers
  console.log('--- Response Headers ---');
  response.headers.forEach((value, key) => {
    // Truncate very long headers for readability
    const display = value.length > 200 ? `${value.slice(0, 200)}...` : value;
    console.log(`  ${key}: ${display}`);
  });
  console.log('');

  if (response.status === 402) {
    // Check for v2 header (PAYMENT-REQUIRED)
    const paymentRequired = response.headers.get('payment-required');
    if (paymentRequired) {
      console.log('--- PAYMENT-REQUIRED header (v2) ---');
      try {
        const decoded = JSON.parse(Buffer.from(paymentRequired, 'base64').toString());
        console.log(JSON.stringify(decoded, null, 2));
      } catch {
        console.log('Failed to decode base64, raw:', paymentRequired.slice(0, 200));
      }
    } else {
      console.log('No PAYMENT-REQUIRED header found (v2 header missing)');
    }

    // Also check body for v1 format
    const body = await response.text();
    if (body) {
      console.log('');
      console.log('--- Response Body ---');
      try {
        const parsed = JSON.parse(body);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(body.slice(0, 500));
      }
    }

    return true;
  }

  if (response.status === 200) {
    console.log('Got 200 — x402 middleware is NOT active (payment gate disabled)');
    const body = await response.json() as Record<string, unknown>;
    console.log('Response:', JSON.stringify(body, null, 2).slice(0, 300));
    return false;
  }

  const body = await response.text();
  console.log(`Unexpected status ${response.status}:`, body.slice(0, 500));
  return false;
}

async function step2_testPayment() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.log('');
    console.log('=== STEP 2: Skipped (no PRIVATE_KEY) ===');
    console.log('Set PRIVATE_KEY=0x... to test full payment flow');
    return;
  }

  console.log('');
  console.log('=== STEP 2: Full payment flow ===');

  const { ExactEvmScheme, toClientEvmSigner } = await import('@x402/evm');
  const { x402Client, wrapFetchWithPayment } = await import('@x402/fetch');

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`Wallet: ${account.address}`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register('eip155:8453', new ExactEvmScheme(signer));

  // Wrap fetch with verbose logging
  const originalFetch = globalThis.fetch;
  const loggingFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method || 'GET';
    console.log(`  [fetch] ${method} ${url}`);

    // Log payment header if present
    const headers = init?.headers;
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase().includes('payment')) {
          const display = typeof value === 'string' && value.length > 100
            ? `${value.slice(0, 100)}...`
            : value;
          console.log(`  [fetch] Header: ${key} = ${display}`);
        }
      }
    }

    const response = await originalFetch(input, init);
    console.log(`  [fetch] → ${response.status}`);
    return response;
  };

  const x402Fetch = wrapFetchWithPayment(loggingFetch, client);

  console.log('');
  console.log('Sending paid request...');
  try {
    const response = await x402Fetch(`${API_URL}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN_TO_SCAN, chain: 'base' }),
    });

    console.log('');
    console.log(`Final status: ${response.status}`);

    // Log response headers
    console.log('--- Final Response Headers ---');
    response.headers.forEach((value, key) => {
      if (key.toLowerCase().includes('payment') || key.toLowerCase().includes('x-')) {
        console.log(`  ${key}: ${value.slice(0, 200)}`);
      }
    });

    const body = await response.text();
    console.log('');
    console.log('--- Final Response Body ---');
    try {
      console.log(JSON.stringify(JSON.parse(body), null, 2).slice(0, 1000));
    } catch {
      console.log(body.slice(0, 500));
    }
  } catch (error) {
    console.error('');
    console.error('Payment flow FAILED:');
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  }
}

async function step3_checkDiag() {
  console.log('');
  console.log('=== DIAG: Server config ===');
  try {
    const response = await fetch(`${API_URL}/x402-diag`);
    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Diag endpoint not available (${response.status})`);
    }
  } catch (error) {
    console.log('Diag endpoint not reachable:', (error as Error).message);
  }
}

async function main() {
  await step3_checkDiag();
  const got402 = await step1_test402();
  if (got402) {
    await step2_testPayment();
  }
}

main().catch(console.error);
