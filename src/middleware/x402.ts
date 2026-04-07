import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/index.js';

// x402 payment middleware
// Disabled until CDP facilitator keys are configured
// To enable: install @x402/hono + @x402/evm, uncomment below
export function createX402Middleware(_env: Env): MiddlewareHandler {
  // Passthrough for now — x402 payment gate disabled until facilitator is configured
  return async (_c, next) => {
    await next();
  };

  /* Enable when CDP keys are ready:
  const { paymentMiddlewareFromConfig } = await import('@x402/hono');
  return paymentMiddlewareFromConfig({
    '/scan': {
      accepts: {
        scheme: 'exact',
        payTo: env.X402_WALLET_ADDRESS,
        price: '$0.05',
        network: 'eip155:8453', // Base mainnet
      },
      description: 'Rug Scanner token analysis',
    },
  });
  */
}
