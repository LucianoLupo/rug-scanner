import { paymentMiddlewareFromConfig } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { generateJwt } from '@coinbase/cdp-sdk/auth';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/index.js';

const BASE_MAINNET = 'eip155:8453' as const;
const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

async function createCdpAuthHeaders(
  apiKeyId: string,
  apiKeySecret: string,
): Promise<{ verify: Record<string, string>; settle: Record<string, string>; supported: Record<string, string> }> {
  const makeHeaders = async (method: string, path: string) => {
    const token = await generateJwt({
      apiKeyId,
      apiKeySecret,
      requestMethod: method,
      requestHost: 'api.cdp.coinbase.com',
      requestPath: path,
      expiresIn: 120,
    });
    return { Authorization: `Bearer ${token}` };
  };

  return {
    verify: await makeHeaders('POST', '/platform/v2/x402/verify'),
    settle: await makeHeaders('POST', '/platform/v2/x402/settle'),
    supported: await makeHeaders('GET', '/platform/v2/x402/supported'),
  };
}

export function createX402Middleware(env: Env): MiddlewareHandler {
  if (!env.X402_WALLET_ADDRESS || !env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) {
    console.log('x402 payment gate disabled — missing wallet or CDP keys');
    return async (_c, next) => { await next(); };
  }

  const facilitator = new HTTPFacilitatorClient({
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: () => createCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET),
  });

  return paymentMiddlewareFromConfig(
    {
      'POST /scan': {
        accepts: {
          scheme: 'exact',
          payTo: env.X402_WALLET_ADDRESS,
          price: '$0.05',
          network: BASE_MAINNET,
        },
        description: 'Rug Scanner — on-chain token risk analysis',
      },
    },
    facilitator,
  );
}
