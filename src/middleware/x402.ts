import { paymentMiddlewareFromConfig } from '@x402/hono';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/index.js';

export function createX402Middleware(env: Env): MiddlewareHandler {
  return paymentMiddlewareFromConfig({
    '/scan': {
      accepts: {
        scheme: 'exact',
        payTo: env.X402_WALLET_ADDRESS,
        price: '$0.05',
        network: 'eip155:84532',
      },
      description: 'Rug Scanner token analysis',
    },
  });
}
