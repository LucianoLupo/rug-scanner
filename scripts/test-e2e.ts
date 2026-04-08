/**
 * End-to-end x402 payment flow test with a fresh random wallet.
 * The wallet has no USDC — the facilitator will reject with "insufficient balance"
 * but this confirms the full flow works up to on-chain validation.
 *
 * Usage: npx tsx scripts/test-e2e.ts [url]
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';

const API_URL = process.argv[2] || 'http://localhost:3000';

async function main() {
  // Generate a fresh random wallet for signing
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`Test wallet: ${account.address} (fresh, no USDC)`);
  console.log(`Target: ${API_URL}`);
  console.log('');

  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register('eip155:8453', new ExactEvmScheme(signer));

  // Intercept fetch to log the full flow
  let requestCount = 0;
  const loggingFetch: typeof fetch = async (input, init) => {
    requestCount++;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method || 'GET';
    console.log(`--- Request #${requestCount}: ${method} ${url} ---`);

    // Check for payment header
    if (init?.headers && typeof init.headers === 'object') {
      const entries = init.headers instanceof Headers
        ? Array.from(init.headers.entries())
        : Object.entries(init.headers as Record<string, string>);
      for (const [key, value] of entries) {
        if (key.toLowerCase().includes('payment')) {
          console.log(`  Header: ${key} = ${String(value).slice(0, 80)}...`);
          // Try to decode the payment signature
          try {
            const decoded = JSON.parse(Buffer.from(String(value), 'base64').toString());
            console.log(`  Decoded payment payload:`);
            console.log(`    x402Version: ${decoded.x402Version}`);
            console.log(`    accepted.scheme: ${decoded.accepted?.scheme}`);
            console.log(`    accepted.network: ${decoded.accepted?.network}`);
            console.log(`    accepted.amount: ${decoded.accepted?.amount}`);
            console.log(`    accepted.payTo: ${decoded.accepted?.payTo}`);
            console.log(`    payload keys: ${Object.keys(decoded.payload || {}).join(', ')}`);
            if (decoded.payload?.authorization) {
              console.log(`    authorization.from: ${decoded.payload.authorization.from}`);
              console.log(`    authorization.to: ${decoded.payload.authorization.to}`);
              console.log(`    authorization.value: ${decoded.payload.authorization.value}`);
            }
          } catch {
            // not decodable
          }
        }
      }
    }

    const response = await fetch(input, init);
    console.log(`  Response: ${response.status}`);

    // Log key response headers
    const paymentRequiredHeader = response.headers.get('payment-required');
    if (paymentRequiredHeader) {
      console.log(`  PAYMENT-REQUIRED header present (${paymentRequiredHeader.length} chars)`);
    }

    // Clone and peek at body for non-200 responses
    if (response.status !== 200) {
      const cloned = response.clone();
      const body = await cloned.text();
      if (body && body.length < 1000) {
        try {
          const parsed = JSON.parse(body);
          console.log(`  Body: ${JSON.stringify(parsed)}`);
        } catch {
          console.log(`  Body: ${body.slice(0, 200)}`);
        }
      }
    }

    console.log('');
    return response;
  };

  const x402Fetch = wrapFetchWithPayment(loggingFetch, client);

  console.log('=== Starting x402 payment flow ===');
  console.log('');

  try {
    const response = await x402Fetch(`${API_URL}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: '0x4200000000000000000000000000000000000006',
        chain: 'base',
      }),
    });

    console.log('=== Final Result ===');
    console.log(`Status: ${response.status}`);

    const body = await response.text();
    try {
      const parsed = JSON.parse(body);
      console.log(JSON.stringify(parsed, null, 2).slice(0, 1000));
    } catch {
      console.log(body.slice(0, 500));
    }
  } catch (error) {
    console.error('=== FLOW FAILED ===');
    console.error(error instanceof Error ? `${error.message}\n${error.stack}` : error);
  }
}

main().catch(console.error);
