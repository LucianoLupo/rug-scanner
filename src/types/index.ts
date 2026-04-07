export type Chain = 'base' | 'ethereum';

export type ScanRequest = {
  token: string;
  chain: Chain;
};

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type Flag = {
  severity: Severity;
  type: string;
  value: string | number | boolean;
  detail: string;
};

export type ContractData = {
  verified: boolean;
  can_mint: boolean;
  can_blacklist: boolean;
  can_pause: boolean;
  is_proxy: boolean;
  owner_renounced: boolean;
  has_fee_setter: boolean;
};

export type HolderData = {
  total_approx: number;
  top5_pct: number;
  top10_pct: number;
  deployer_pct: number;
  method: string;
};

export type LiquidityData = {
  total_usd: number;
  lp_locked: boolean;
  lock_provider: string | null;
  pool_age_hours: number;
  dex: string;
};

export type DeployerData = {
  age_days: number;
  tx_count: number;
  eth_balance: number;
};

export type TradingData = {
  buy_tax_pct: number | null;
  sell_tax_pct: number | null;
  can_sell: boolean | null;
  simulation_method: string;
};

export type MarketData = {
  price_usd: number | null;
  volume_24h: number | null;
  pair_age_hours: number | null;
  price_change_24h_pct: number | null;
};

export type Verdict = 'CRITICAL' | 'HIGH_RISK' | 'MEDIUM_RISK' | 'LOW_RISK' | 'SAFE';

export type ScanResult = {
  score: number;
  verdict: Verdict;
  confidence: number;
  flags: Flag[];
  data: {
    contract: ContractData;
    holders: HolderData;
    liquidity: LiquidityData;
    deployer: DeployerData;
    trading: TradingData;
    market: MarketData;
  };
  checks_completed: number;
  checks_total: number;
  disclaimer: string;
  scanned_at: string;
};

export type Env = {
  ALCHEMY_API_KEY: string;
  BASESCAN_API_KEY: string;
  ETHERSCAN_API_KEY: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  X402_WALLET_ADDRESS: string;
  X402_FACILITATOR_URL: string;
  CDP_API_KEY_ID: string;
  CDP_API_KEY_SECRET: string;
};
