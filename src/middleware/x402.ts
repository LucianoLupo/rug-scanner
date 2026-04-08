import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
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

let cachedMiddleware: MiddlewareHandler | null = null;

export function createX402Middleware(env: Env): MiddlewareHandler {
  if (!env.X402_WALLET_ADDRESS || !env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) {
    console.log('x402 payment gate disabled — missing wallet or CDP keys');
    return async (_c, next) => { await next(); };
  }

  if (cachedMiddleware) return cachedMiddleware;

  console.log('[x402] Initializing payment gate...');
  console.log(`[x402] Wallet: ${env.X402_WALLET_ADDRESS}`);
  console.log(`[x402] CDP Key ID: ${env.CDP_API_KEY_ID.slice(0, 8)}...`);
  console.log(`[x402] Facilitator: ${CDP_FACILITATOR_URL}`);

  const facilitator = new HTTPFacilitatorClient({
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: () => createCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET),
  });

  const server = new x402ResourceServer(facilitator)
    .register(BASE_MAINNET, new ExactEvmScheme());

  server
    .onAfterVerify(async (ctx) => {
      if (!ctx.result.isValid) {
        console.error('[x402] Verify rejected:', ctx.result.invalidReason);
      }
    })
    .onVerifyFailure(async (ctx) => {
      console.error('[x402] Verify FAILED:', ctx.error.message);
    })
    .onAfterSettle(async (ctx) => {
      console.log('[x402] Settled — tx:', ctx.result.transaction);
    })
    .onSettleFailure(async (ctx) => {
      console.error('[x402] Settle FAILED:', ctx.error.message);
    });

  cachedMiddleware = paymentMiddleware(
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
    server,
  );

  console.log('[x402] Payment gate initialized');
  return cachedMiddleware;
}
