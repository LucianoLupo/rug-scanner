import { generateJwt } from '@coinbase/cdp-sdk/auth';

async function main() {
  const token = await generateJwt({
    apiKeyId: process.env.CDP_API_KEY_ID!,
    apiKeySecret: process.env.CDP_API_KEY_SECRET!,
    requestMethod: 'GET',
    requestHost: 'api.cdp.coinbase.com',
    requestPath: '/platform/v2/x402/supported',
    expiresIn: 120,
  });

  const r = await fetch('https://api.cdp.coinbase.com/platform/v2/x402/supported', {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await r.json() as { kinds: Array<{ network: string; scheme: string; x402Version: number; extra?: unknown }> };
  const baseEntries = data.kinds.filter(
    (k) => k.network === 'base' || k.network === 'eip155:8453',
  );

  console.log('Base entries:', JSON.stringify(baseEntries, null, 2));
  console.log('');
  console.log('All x402Version values:', [...new Set(data.kinds.map((k) => k.x402Version))]);
  console.log('All networks:', [...new Set(data.kinds.map((k) => k.network))]);
}

main().catch(console.error);
