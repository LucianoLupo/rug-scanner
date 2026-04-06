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

const app = new Hono<{ Bindings: Env }>();

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
    return c.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      400,
    );
  }

  const { token, chain } = parsed.data;

  // Check cache
  const cache = new CacheService(
    c.env.UPSTASH_REDIS_REST_URL,
    c.env.UPSTASH_REDIS_REST_TOKEN,
  );
  const cacheKey = `scan:${chain}:${token}`;
  const cached = await cache.get<ScanResult>(cacheKey);
  if (cached) {
    return c.json(cached);
  }

  const provider = new AlchemyProvider(c.env.ALCHEMY_API_KEY, chain);
  const explorerKey =
    chain === 'base' ? c.env.BASESCAN_API_KEY : c.env.ETHERSCAN_API_KEY;

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
