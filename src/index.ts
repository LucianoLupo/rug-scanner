import { Hono } from 'hono';
import { z } from 'zod';
import { createX402Middleware } from './middleware/x402.js';
import type { Env, ScanResult } from './types/index.js';

const app = new Hono<{ Bindings: Env }>();

const scanRequestSchema = z.object({
  token: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid token address'),
  chain: z.enum(['base', 'ethereum']),
});

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

app.use('/scan', async (c, next) => {
  const middleware = createX402Middleware(c.env);
  return middleware(c, next);
});

app.post('/scan', async (c) => {
  const body = await c.req.json();
  const parsed = scanRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { token, chain } = parsed.data;

  const mockResult: ScanResult = {
    score: 0,
    verdict: 'SAFE',
    confidence: 0,
    flags: [],
    data: {
      contract: {
        verified: false,
        can_mint: false,
        can_blacklist: false,
        can_pause: false,
        is_proxy: false,
        owner_renounced: false,
        has_fee_setter: false,
      },
      holders: {
        total_approx: 0,
        top5_pct: 0,
        top10_pct: 0,
        deployer_pct: 0,
        method: 'placeholder',
      },
      liquidity: {
        total_usd: 0,
        lp_locked: false,
        lock_provider: null,
        pool_age_hours: 0,
        dex: 'unknown',
      },
      deployer: {
        age_days: 0,
        tx_count: 0,
        eth_balance: 0,
      },
      trading: {
        buy_tax_pct: null,
        sell_tax_pct: null,
        can_sell: null,
        simulation_method: 'placeholder',
      },
      market: {
        price_usd: null,
        volume_24h: null,
        pair_age_hours: null,
        price_change_24h_pct: null,
      },
    },
    checks_completed: 0,
    checks_total: 6,
    disclaimer: `Automated analysis for ${token} on ${chain}. Not financial advice.`,
    scanned_at: new Date().toISOString(),
  };

  return c.json(mockResult);
});

export default app;
