/**
 * Tests the CDP facilitator endpoints directly to verify JWT auth works
 * for verify/settle/supported — not just getSupported (which we know works).
 *
 * Usage: railway run -- npx tsx scripts/test-facilitator.ts
 */

import { generateJwt } from '@coinbase/cdp-sdk/auth';

const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

async function makeJwt(method: string, path: string): Promise<string> {
  return generateJwt({
    apiKeyId: process.env.CDP_API_KEY_ID!,
    apiKeySecret: process.env.CDP_API_KEY_SECRET!,
    requestMethod: method,
    requestHost: 'api.cdp.coinbase.com',
    requestPath: path,
    expiresIn: 120,
  });
}

async function testSupported() {
  console.log('=== Test GET /supported ===');
  const token = await makeJwt('GET', '/platform/v2/x402/supported');
  const response = await fetch(`${CDP_FACILITATOR_URL}/supported`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  console.log(`Status: ${response.status}`);
  const body = await response.text();
  try {
    const parsed = JSON.parse(body);
    console.log('Supported kinds:', JSON.stringify(parsed, null, 2).slice(0, 500));
  } catch {
    console.log('Response:', body.slice(0, 500));
  }
  console.log('');
}

async function testVerify() {
  console.log('=== Test POST /verify (with dummy payload) ===');
  const token = await makeJwt('POST', '/platform/v2/x402/verify');

  // Send a dummy verify request to see what error format we get
  // This should fail with an invalid payload error, NOT an auth error
  const response = await fetch(`${CDP_FACILITATOR_URL}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        payload: {
          authorization: {
            from: '0x0000000000000000000000000000000000000001',
            to: '0x1BBAC180dC1e393ac2bAD9930BC58f532cc866a3',
            value: '50000',
            validAfter: '0',
            validBefore: '9999999999',
            nonce: '0x' + '00'.repeat(32),
          },
          signature: '0x' + '00'.repeat(65),
        },
      },
      paymentRequirements: {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '50000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x1BBAC180dC1e393ac2bAD9930BC58f532cc866a3',
        maxTimeoutSeconds: 300,
        extra: {
          name: 'USD Coin',
          version: '2',
        },
      },
    }),
  });
  console.log(`Status: ${response.status}`);
  const body = await response.text();
  try {
    const parsed = JSON.parse(body);
    console.log('Response:', JSON.stringify(parsed, null, 2));
  } catch {
    console.log('Response:', body.slice(0, 500));
  }

  if (response.status === 401 || response.status === 403) {
    console.log('>>> AUTH FAILURE — JWT not accepted for verify endpoint');
  } else if (response.status === 400 || response.status === 422) {
    console.log('>>> AUTH OK — got expected validation error for dummy payload');
  } else if (response.status === 200) {
    console.log('>>> Unexpected success (dummy payload should not verify)');
  }
  console.log('');
}

async function testSettle() {
  console.log('=== Test POST /settle (with dummy payload) ===');
  const token = await makeJwt('POST', '/platform/v2/x402/settle');

  const response = await fetch(`${CDP_FACILITATOR_URL}/settle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        payload: {},
      },
      paymentRequirements: {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '50000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x1BBAC180dC1e393ac2bAD9930BC58f532cc866a3',
        maxTimeoutSeconds: 300,
      },
    }),
  });
  console.log(`Status: ${response.status}`);
  const body = await response.text();
  try {
    const parsed = JSON.parse(body);
    console.log('Response:', JSON.stringify(parsed, null, 2));
  } catch {
    console.log('Response:', body.slice(0, 500));
  }

  if (response.status === 401 || response.status === 403) {
    console.log('>>> AUTH FAILURE — JWT not accepted for settle endpoint');
  } else {
    console.log('>>> AUTH OK — got expected error for dummy payload');
  }
  console.log('');
}

async function main() {
  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
    console.error('Missing CDP_API_KEY_ID or CDP_API_KEY_SECRET');
    console.error('Run with: railway run -- npx tsx scripts/test-facilitator.ts');
    process.exit(1);
  }

  console.log(`CDP Key: ${process.env.CDP_API_KEY_ID.slice(0, 8)}...`);
  console.log('');

  await testSupported();
  await testVerify();
  await testSettle();
}

main().catch(console.error);
