import { paymentMiddlewareFromConfig } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/index.js';

const BASE_MAINNET = 'eip155:8453' as const;

export function createX402Middleware(env: Env): MiddlewareHandler {
  // Skip x402 if wallet not configured (local dev without payment gate)
  if (!env.X402_WALLET_ADDRESS) {
    return async (_c, next) => { await next(); };
  }

  const facilitatorUrl = env.X402_FACILITATOR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402';
  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });

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
