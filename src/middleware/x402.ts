// import { paymentMiddlewareFromConfig } from '@x402/hono';
// import { HTTPFacilitatorClient } from '@x402/core/server';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/index.js';

// const BASE_MAINNET = 'eip155:8453' as const;

export function createX402Middleware(_env: Env): MiddlewareHandler {
  // x402 payment gate — requires CDP auth headers for facilitator
  // TODO: Enable once CDP JWT signing is implemented
  // For now, scan endpoint is free — collecting usage data before monetizing
  //
  // When ready to enable:
  // 1. Implement CDP JWT auth (createAuthHeaders with key ID + secret)
  // 2. Pass to HTTPFacilitatorClient config
  // 3. Uncomment the paymentMiddlewareFromConfig below
  return async (_c, next) => { await next(); };
}
