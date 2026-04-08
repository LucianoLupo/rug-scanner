import { Hono } from 'hono';
import { z } from 'zod';
import { createX402Middleware } from './middleware/x402.js';
import { AlchemyProvider } from './providers/alchemy.js';
import { CacheService } from './cache/redis.js';
import { analyzeContract } from './analysis/contract.js';
import { analyzeHolders } from './analysis/holders.js';
import { getDeployerAddress, analyzeDeployer } from './analysis/deployer.js';
import { analyzeLiquidity } from './analysis/liquidity.js';
import { checkSourceVerified } from './providers/explorer.js';
import { getTokenPairs } from './providers/dexscreener.js';
import { simulateTrade } from './providers/simulation.js';
import { getVerdict, calculateConfidence } from './analysis/scorer.js';
import type {
  Env,
  ScanResult,
  ContractData,
  HolderData,
  LiquidityData,
  DeployerData,
  TradingData,
  MarketData,
} from './types/index.js';

function getEnv(): Env {
  return {
    ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY ?? '',
    BASESCAN_API_KEY: process.env.BASESCAN_API_KEY ?? '',
    ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY ?? '',
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ?? '',
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ?? '',
    X402_WALLET_ADDRESS: process.env.X402_WALLET_ADDRESS ?? '',
    X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL ?? '',
    CDP_API_KEY_ID: process.env.CDP_API_KEY_ID ?? '',
    CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET ?? '',
  };
}

const app = new Hono();

// Simple in-memory rate limiter: 10 requests per second per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 1000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    // Cleanup expired entries to prevent memory leak
    if (rateLimitMap.size > 1000) {
      for (const [key, val] of rateLimitMap) {
        if (now >= val.resetAt) rateLimitMap.delete(key);
      }
    }
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

const scanRequestSchema = z.object({
  token: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid token address'),
  chain: z.enum(['base', 'ethereum']),
});

const CHECKS_TOTAL = 7;

const DEFAULT_CONTRACT: ContractData = {
  verified: false,
  can_mint: false,
  can_blacklist: false,
  can_pause: false,
  is_proxy: false,
  owner_renounced: true,
  has_fee_setter: false,
};

const DEFAULT_HOLDERS: HolderData = {
  total_approx: 0,
  top5_pct: 0,
  top10_pct: 0,
  deployer_pct: 0,
  method: 'failed',
};

const DEFAULT_LIQUIDITY: LiquidityData = {
  total_usd: 0,
  lp_locked: false,
  lock_provider: null,
  pool_age_hours: 0,
  dex: 'unknown',
};

const DEFAULT_DEPLOYER: DeployerData = {
  age_days: -1,
  tx_count: 0,
  eth_balance: 0,
};

const DEFAULT_TRADING: TradingData = {
  buy_tax_pct: null,
  sell_tax_pct: null,
  can_sell: null,
  simulation_method: 'skipped',
};

const DEFAULT_MARKET: MarketData = {
  price_usd: null,
  volume_24h: null,
  pair_age_hours: null,
  price_change_24h_pct: null,
};

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// x402 discovery file
let x402Discovery: unknown = null;
try {
  x402Discovery = JSON.parse(readFileSync(join(__dirname, '..', '.well-known', 'x402.json'), 'utf-8'));
} catch {
  // .well-known not found in dist — try from project root
  try {
    x402Discovery = JSON.parse(readFileSync(join(__dirname, '..', '..', '.well-known', 'x402.json'), 'utf-8'));
  } catch {
    // skip
  }
}

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

app.get('/.well-known/x402.json', (c) => {
  if (!x402Discovery) {
    return c.json({ error: 'x402 discovery not configured' }, 404);
  }
  return c.json(x402Discovery);
});

app.get('/.well-known/agent-card.json', (c) => {
  return c.json({
    name: 'Rug Scanner',
    description: 'On-chain token risk analysis — detects rug pull signals, honeypots, and contract red flags on Base and Ethereum.',
    version: '1.0.0',
    url: 'https://rug-scanner-production.up.railway.app',
    provider: {
      organization: 'LucianoLupo',
      url: 'https://github.com/LucianoLupo',
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: 'https://github.com/google-a2a/a2a-x402/v0.1',
          description: '$0.05 USDC on Base per scan via x402 protocol.',
          required: true,
        },
      ],
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'token-risk-analysis',
        name: 'Token Risk Analysis',
        description: 'Analyzes a token contract for rug pull risk: bytecode selectors, holder concentration, LP locks, deployer history, buy/sell tax simulation, source verification, market data. Returns verdict (CRITICAL/HIGH_RISK/MEDIUM_RISK/LOW_RISK/SAFE) with confidence score and flags.',
        tags: ['defi', 'security', 'token-analysis', 'rug-pull', 'risk', 'base', 'ethereum'],
        examples: [
          'Analyze token 0x... on Base for rug pull risk',
          'Is this token safe to buy?',
          'Check if this contract is a honeypot',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
  });
});

app.get('/', (c) => {
  const accept = c.req.header('Accept') || '';
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return c.json({
      name: 'Rug Scanner',
      description: 'On-chain token risk analysis API. Pay-per-scan via x402 ($0.05 USDC on Base).',
      endpoints: {
        'POST /scan': '$0.05 — Full token risk analysis (contract, holders, liquidity, deployer, trading)',
        'GET /health': 'Free — Service health check',
        'GET /.well-known/x402.json': 'Free — x402 discovery file',
      },
      chains: ['base', 'ethereum'],
      verdicts: ['CRITICAL', 'HIGH_RISK', 'MEDIUM_RISK', 'LOW_RISK', 'SAFE'],
      docs: 'https://github.com/LucianoLupo/rug-scanner',
    });
  }

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rug Scanner — On-Chain Token Risk Analysis</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;display:flex;flex-direction:column;align-items:center}
  a{color:#58a6ff;text-decoration:none}
  a:hover{text-decoration:underline}
  .container{max-width:720px;width:100%;padding:48px 24px}
  .badge{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;padding:4px 10px;border-radius:12px;margin-bottom:24px}
  .badge-live{background:#16a34a22;color:#4ade80;border:1px solid #16a34a44}
  h1{font-size:32px;font-weight:700;margin-bottom:8px;color:#fff}
  .subtitle{font-size:16px;color:#888;margin-bottom:40px;line-height:1.5}
  .price{color:#f59e0b;font-weight:600}
  .section{margin-bottom:36px}
  .section h2{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:16px}
  .checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
  .check{background:#141414;border:1px solid #222;border-radius:8px;padding:14px;font-size:13px}
  .check-title{font-weight:600;color:#fff;margin-bottom:4px}
  .check-desc{color:#888;font-size:12px}
  .verdicts{display:flex;gap:8px;flex-wrap:wrap}
  .verdict{font-size:12px;font-weight:600;padding:5px 12px;border-radius:6px;letter-spacing:.3px}
  .v-critical{background:#dc262622;color:#f87171;border:1px solid #dc262644}
  .v-high{background:#ea580c22;color:#fb923c;border:1px solid #ea580c44}
  .v-medium{background:#ca8a0422;color:#fbbf24;border:1px solid #ca8a0444}
  .v-low{background:#2563eb22;color:#60a5fa;border:1px solid #2563eb44}
  .v-safe{background:#16a34a22;color:#4ade80;border:1px solid #16a34a44}
  pre{background:#141414;border:1px solid #222;border-radius:8px;padding:16px;overflow-x:auto;font-size:13px;line-height:1.6;color:#c9d1d9}
  .kw{color:#ff7b72}.str{color:#a5d6ff}.num{color:#79c0ff}.cmt{color:#484f58}
  .endpoint{background:#141414;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:10px;display:flex;align-items:baseline;gap:12px}
  .method{font-size:12px;font-weight:700;padding:3px 8px;border-radius:4px;flex-shrink:0}
  .method-post{background:#8b5cf622;color:#a78bfa;border:1px solid #8b5cf644}
  .method-get{background:#06b6d422;color:#22d3ee;border:1px solid #06b6d444}
  .ep-path{font-family:monospace;color:#fff;font-size:14px}
  .ep-desc{color:#888;font-size:13px;margin-left:auto}
  .chains{display:flex;gap:8px}
  .chain{font-size:12px;font-weight:600;padding:5px 12px;border-radius:6px;background:#141414;border:1px solid #222;color:#fff}
  .footer{margin-top:auto;padding:24px;text-align:center;font-size:12px;color:#444}
  .footer a{color:#555}
  @media(max-width:480px){h1{font-size:24px}.checks{grid-template-columns:1fr}.endpoint{flex-direction:column;gap:6px}.ep-desc{margin-left:0}}
</style>
</head>
<body>
<div class="container">
  <span class="badge badge-live">Live on Base</span>
  <h1>Rug Scanner</h1>
  <p class="subtitle">On-chain token risk analysis for AI agents.<br>7 parallel checks, deterministic scoring, no LLMs.<br><span class="price">$0.05 USDC per scan</span> via <a href="https://www.x402.org/" target="_blank">x402 protocol</a>.</p>

  <div class="section">
    <h2>Endpoints</h2>
    <div class="endpoint">
      <span class="method method-post">POST</span>
      <span class="ep-path">/scan</span>
      <span class="ep-desc">$0.05 — Full token risk analysis</span>
    </div>
    <div class="endpoint">
      <span class="method method-get">GET</span>
      <span class="ep-path">/health</span>
      <span class="ep-desc">Free — Health check</span>
    </div>
    <div class="endpoint">
      <span class="method method-get">GET</span>
      <span class="ep-path">/.well-known/x402.json</span>
      <span class="ep-desc">Free — x402 discovery</span>
    </div>
  </div>

  <div class="section">
    <h2>7 On-Chain Checks</h2>
    <div class="checks">
      <div class="check"><div class="check-title">Contract Bytecode</div><div class="check-desc">Mint, blacklist, pause, proxy, fee selectors via EVMole</div></div>
      <div class="check"><div class="check-title">Holder Concentration</div><div class="check-desc">Top 5/10 holder %, deployer holdings</div></div>
      <div class="check"><div class="check-title">Liquidity Pools</div><div class="check-desc">Uni V2/V3 + Aerodrome, reserves, LP lock status</div></div>
      <div class="check"><div class="check-title">Deployer History</div><div class="check-desc">Wallet age, tx count, ETH balance</div></div>
      <div class="check"><div class="check-title">Buy/Sell Simulation</div><div class="check-desc">Tax detection via router simulation</div></div>
      <div class="check"><div class="check-title">Source Verification</div><div class="check-desc">Basescan / Etherscan verified status</div></div>
      <div class="check"><div class="check-title">Market Data</div><div class="check-desc">Price, volume, pair age via DEXScreener</div></div>
    </div>
  </div>

  <div class="section">
    <h2>Verdicts</h2>
    <div class="verdicts">
      <span class="verdict v-critical">CRITICAL</span>
      <span class="verdict v-high">HIGH RISK</span>
      <span class="verdict v-medium">MEDIUM RISK</span>
      <span class="verdict v-low">LOW RISK</span>
      <span class="verdict v-safe">SAFE</span>
    </div>
  </div>

  <div class="section">
    <h2>Chains</h2>
    <div class="chains">
      <span class="chain">Base</span>
      <span class="chain">Ethereum</span>
    </div>
  </div>

  <div class="section">
    <h2>Example Request</h2>
    <pre><span class="cmt">// Using @x402/fetch — payment is automatic</span>
<span class="kw">const</span> response = <span class="kw">await</span> x402Fetch(<span class="str">'https://rug-scanner-production.up.railway.app/scan'</span>, {
  method: <span class="str">'POST'</span>,
  headers: { <span class="str">'Content-Type'</span>: <span class="str">'application/json'</span> },
  body: JSON.stringify({
    token: <span class="str">'0x...'</span>,
    chain: <span class="str">'base'</span>
  })
});</pre>
  </div>

  <div class="section">
    <h2>Example Response</h2>
    <pre>{
  <span class="str">"verdict"</span>: <span class="str">"HIGH_RISK"</span>,
  <span class="str">"score"</span>: <span class="num">4</span>,
  <span class="str">"confidence"</span>: <span class="num">1.0</span>,
  <span class="str">"flags"</span>: [
    { <span class="str">"severity"</span>: <span class="str">"high"</span>, <span class="str">"type"</span>: <span class="str">"can_mint"</span>, <span class="str">"detail"</span>: <span class="str">"Contract has mint function"</span> },
    { <span class="str">"severity"</span>: <span class="str">"high"</span>, <span class="str">"type"</span>: <span class="str">"lp_unlocked"</span>, <span class="str">"detail"</span>: <span class="str">"LP tokens are not locked"</span> }
  ],
  <span class="str">"data"</span>: { <span class="cmt">/* contract, holders, liquidity, deployer, trading, market */</span> }
}</pre>
  </div>

  <div class="section">
    <h2>Links</h2>
    <p style="font-size:14px;line-height:2">
      <a href="https://github.com/LucianoLupo/rug-scanner" target="_blank">GitHub</a> &middot;
      <a href="/.well-known/x402.json">x402 Discovery</a> &middot;
      <a href="https://www.x402.org/" target="_blank">x402 Protocol</a>
    </p>
  </div>
</div>

<div class="footer">
  Built by <a href="https://github.com/LucianoLupo" target="_blank">LucianoLupo</a> &middot; Powered by x402
</div>
</body>
</html>`);
});

// x402 payment gate
app.use('/scan', async (c, next) => {
  const env = getEnv();
  const middleware = createX402Middleware(env);
  return middleware(c, next);
});

app.post('/scan', async (c) => {
  const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown';
  if (isRateLimited(ip)) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }

  const body = await c.req.json();
  const parsed = scanRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      400,
    );
  }

  const { token, chain } = parsed.data;
  const env = getEnv();

  // Check cache
  const cache = new CacheService(
    env.UPSTASH_REDIS_REST_URL,
    env.UPSTASH_REDIS_REST_TOKEN,
  );
  const cacheKey = `scan:${chain}:${token}`;
  const cached = await cache.get<ScanResult>(cacheKey);
  if (cached) {
    return c.json(cached);
  }

  const provider = new AlchemyProvider(env.ALCHEMY_API_KEY, chain);
  const explorerKey =
    chain === 'base' ? env.BASESCAN_API_KEY : env.ETHERSCAN_API_KEY;

  let checksCompleted = 0;

  // Batch 1: deployer address + contract + explorer + market + liquidity (parallel)
  const [deployerAddrResult, contractResult, explorerResult, marketResult, liquidityResult] =
    await Promise.allSettled([
      getDeployerAddress(provider, token),
      analyzeContract(provider, token),
      checkSourceVerified(chain, token, explorerKey),
      getTokenPairs(chain, token),
      analyzeLiquidity(provider, token, chain),
    ]);

  // Extract contract data
  let contractData = DEFAULT_CONTRACT;
  let contractFlags: import('./types/index.js').Flag[] = [];
  if (contractResult.status === 'fulfilled') {
    contractData = contractResult.value.data;
    contractFlags = contractResult.value.flags;
    checksCompleted++;
  }

  // Extract explorer data and merge verified status into contract
  let explorerFlags: import('./types/index.js').Flag[] = [];
  if (explorerResult.status === 'fulfilled') {
    contractData = { ...contractData, verified: explorerResult.value.verified };
    explorerFlags = explorerResult.value.flags;
    checksCompleted++;
  }

  // Extract market data
  let marketData = DEFAULT_MARKET;
  if (marketResult.status === 'fulfilled') {
    marketData = marketResult.value;
    checksCompleted++;
  }

  // Extract liquidity data
  let liquidityData = DEFAULT_LIQUIDITY;
  let liquidityFlags: import('./types/index.js').Flag[] = [];
  if (liquidityResult.status === 'fulfilled') {
    liquidityData = liquidityResult.value.data;
    liquidityFlags = liquidityResult.value.flags;
    checksCompleted++;
  }

  // Extract deployer address
  const deployerAddr =
    deployerAddrResult.status === 'fulfilled'
      ? deployerAddrResult.value
      : null;

  // Batch 2: holders + deployer analysis (parallel, need deployer address)
  const [holdersResult, deployerResult] = await Promise.allSettled([
    deployerAddr
      ? analyzeHolders(provider, token, deployerAddr)
      : Promise.reject(new Error('No deployer address')),
    analyzeDeployer(provider, token),
  ]);

  // Extract holders data
  let holdersData = DEFAULT_HOLDERS;
  let holdersFlags: import('./types/index.js').Flag[] = [];
  if (holdersResult.status === 'fulfilled') {
    holdersData = holdersResult.value.data;
    holdersFlags = holdersResult.value.flags;
    checksCompleted++;
  }

  // Extract deployer data
  let deployerData = DEFAULT_DEPLOYER;
  let deployerFlags: import('./types/index.js').Flag[] = [];
  if (deployerResult.status === 'fulfilled') {
    deployerData = deployerResult.value.data;
    deployerFlags = deployerResult.value.flags;
    checksCompleted++;
  }

  // Batch 3: trade simulation (needs liquidity pool info)
  let tradingData = DEFAULT_TRADING;
  let tradingFlags: import('./types/index.js').Flag[] = [];
  const hasPool = liquidityData.dex !== 'none' && liquidityData.dex !== 'unknown';

  if (hasPool) {
    try {
      const simResult = await simulateTrade(
        provider,
        token,
        chain,
        '', // pool address not used by simulateTrade internally
        liquidityData.dex,
      );
      tradingData = simResult.data;
      tradingFlags = simResult.flags;
      checksCompleted++;
    } catch {
      // simulation failed, use defaults
    }
  }

  // Collect all flags
  const allFlags = [
    ...contractFlags,
    ...explorerFlags,
    ...holdersFlags,
    ...deployerFlags,
    ...liquidityFlags,
    ...tradingFlags,
  ];

  // Score and verdict
  const { verdict, score } = getVerdict(allFlags);
  const confidence = calculateConfidence(checksCompleted, CHECKS_TOTAL);

  const result: ScanResult = {
    score,
    verdict,
    confidence,
    flags: allFlags,
    data: {
      contract: contractData,
      holders: holdersData,
      liquidity: liquidityData,
      deployer: deployerData,
      trading: tradingData,
      market: marketData,
    },
    checks_completed: checksCompleted,
    checks_total: CHECKS_TOTAL,
    disclaimer:
      'Risk assessment only. Not financial advice. May contain errors. DYOR.',
    scanned_at: new Date().toISOString(),
  };

  // Cache result (30 min TTL)
  await cache.set(cacheKey, result, 1800);

  return c.json(result);
});

export default app;
