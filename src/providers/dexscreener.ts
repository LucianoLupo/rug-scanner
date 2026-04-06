import type { Chain, MarketData } from '../types/index.js';

type DexScreenerPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string | null;
  volume: { h24: number } | null;
  pairCreatedAt: number | null;
  priceChange: { h24: number } | null;
  liquidity: { usd: number } | null;
};

type DexScreenerResponse = {
  pairs: DexScreenerPair[] | null;
};

const CHAIN_MAP: Record<Chain, string> = {
  base: 'base',
  ethereum: 'ethereum',
};

export async function getTokenPairs(chain: Chain, tokenAddress: string): Promise<MarketData> {
  const response = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
  );
  const json = (await response.json()) as DexScreenerResponse;

  const chainId = CHAIN_MAP[chain];
  const pairs = json.pairs?.filter((p) => p.chainId === chainId) ?? [];

  if (pairs.length === 0) {
    return {
      price_usd: null,
      volume_24h: null,
      pair_age_hours: null,
      price_change_24h_pct: null,
    };
  }

  const primary = pairs[0];
  const pairAgeHours = primary.pairCreatedAt
    ? (Date.now() - primary.pairCreatedAt) / (1000 * 60 * 60)
    : null;

  return {
    price_usd: primary.priceUsd ? parseFloat(primary.priceUsd) : null,
    volume_24h: primary.volume?.h24 ?? null,
    pair_age_hours: pairAgeHours ? Math.round(pairAgeHours * 100) / 100 : null,
    price_change_24h_pct: primary.priceChange?.h24 ?? null,
  };
}
