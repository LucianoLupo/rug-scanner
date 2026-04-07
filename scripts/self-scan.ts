/**
 * Self-scan script — pays $0.05 USDC to your own endpoint to:
 * 1. Verify x402 payment flow works end-to-end
 * 2. Trigger x402 Bazaar auto-indexing
 *
 * Usage: PRIVATE_KEY=0x... npx tsx scripts/self-scan.ts
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';

const API_URL = 'https://rug-scanner-production.up.railway.app';
const TOKEN_TO_SCAN = '0x4200000000000000000000000000000000000006'; // WETH on Base

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('Set PRIVATE_KEY env var (with 0x prefix)');
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`Wallet: ${account.address}`);
  console.log(`Scanning: ${TOKEN_TO_SCAN} (WETH on Base)`);
  console.log(`Price: $0.05 USDC`);
  console.log('');

  // Create public client for balance/nonce checks
  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  // Create x402 client with EVM signer
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register('eip155:8453', new ExactEvmScheme(signer));

  // Wrap fetch with x402 payment handling
  const x402Fetch = wrapFetchWithPayment(fetch, client);

  // Send paid scan request
  console.log('Sending paid scan request...');
  const response = await x402Fetch(`${API_URL}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN_TO_SCAN, chain: 'base' }),
  });

  console.log(`Status: ${response.status}`);

  if (response.ok) {
    const result = await response.json() as {
      verdict: string;
      score: number;
      confidence: number;
      flags: Array<{ severity: string; type: string; detail: string }>;
    };
    console.log('');
    console.log('=== SCAN RESULT ===');
    console.log(`Verdict: ${result.verdict}`);
    console.log(`Score: ${result.score}`);
    console.log(`Confidence: ${result.confidence}`);
    console.log(`Flags: ${result.flags?.length ?? 0}`);
    result.flags?.forEach((f) => {
      console.log(`  [${f.severity}] ${f.type}: ${f.detail}`);
    });
    console.log('');
    console.log('Payment settled! x402 Bazaar should auto-index within 30-60 seconds.');
  } else {
    const body = await response.text();
    console.log(`Error (${response.status}): ${body}`);
  }
}

main().catch(console.error);
