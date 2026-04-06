import type { Chain, Flag, LiquidityData } from '../types/index.js';
import { AlchemyProvider } from '../providers/alchemy.js';

const WETH: Record<Chain, string> = {
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  base: '0x4200000000000000000000000000000000000006',
};

const UNISWAP_V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA68';
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';

const LOCK_CONTRACTS: { name: string; address: string }[] = [
  { name: 'UNCX', address: '0x663A5C229c09b049E36dCc11a9B0d4a8Eb9db214' },
  { name: 'Team Finance', address: '0xE2fE530C047f2d85298b07D9333C05737f1435fB' },
];

const ETH_PRICE_USD = 3000;
const ZERO_ADDRESS = '0x' + '0'.repeat(40);

function padAddress(addr: string): string {
  return addr.slice(2).toLowerCase().padStart(64, '0');
}

function decodeAddress(hex: string): string {
  return '0x' + hex.slice(-40).toLowerCase();
}

function decodeUint112(hex: string): bigint {
  return BigInt('0x' + hex.replace(/^0x/, ''));
}

type PoolInfo = {
  address: string;
  dex: string;
  type: 'v2' | 'v3';
};

async function discoverPools(
  provider: AlchemyProvider,
  tokenAddress: string,
  chain: Chain,
): Promise<PoolInfo[]> {
  const weth = WETH[chain];
  const tokenPad = padAddress(tokenAddress);
  const wethPad = padAddress(weth);
  const pools: PoolInfo[] = [];

  // Uniswap V2 — getPair(address,address)
  try {
    const data = '0xe6a43905' + tokenPad + wethPad;
    const result = await provider.call(UNISWAP_V2_FACTORY, data);
    const addr = decodeAddress(result);
    if (addr !== ZERO_ADDRESS) {
      pools.push({ address: addr, dex: 'uniswap_v2', type: 'v2' });
    }
  } catch {
    // factory call failed, skip
  }

  // Uniswap V3 — getPool(address,address,uint24) — Ethereum only
  if (chain === 'ethereum') {
    const fees = [500, 3000, 10000];
    for (const fee of fees) {
      try {
        const feePad = fee.toString(16).padStart(64, '0');
        const data = '0x1698ee82' + tokenPad + wethPad + feePad;
        const result = await provider.call(UNISWAP_V3_FACTORY, data);
        const addr = decodeAddress(result);
        if (addr !== ZERO_ADDRESS) {
          pools.push({ address: addr, dex: 'uniswap_v3', type: 'v3' });
          break; // use first found fee tier
        }
      } catch {
        // skip
      }
    }
  }

  // Aerodrome — Base only — getPool(address,address,bool)
  if (chain === 'base') {
    try {
      const stablePad = '0'.repeat(64); // false
      const data = '0xcc56b2c5' + tokenPad + wethPad + stablePad;
      const result = await provider.call(AERODROME_FACTORY, data);
      const addr = decodeAddress(result);
      if (addr !== ZERO_ADDRESS) {
        pools.push({ address: addr, dex: 'aerodrome', type: 'v2' });
      }
    } catch {
      // skip
    }
  }

  return pools;
}

async function getV2Reserves(
  provider: AlchemyProvider,
  poolAddress: string,
  tokenAddress: string,
): Promise<{ tokenReserve: bigint; wethReserve: bigint }> {
  // token0()
  const token0Result = await provider.call(poolAddress, '0x0dfe1681');
  const token0 = decodeAddress(token0Result);
  const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();

  // getReserves()
  const reservesResult = await provider.call(poolAddress, '0x0902f1ac');
  const hex = reservesResult.slice(2);
  const reserve0 = decodeUint112(hex.slice(0, 64));
  const reserve1 = decodeUint112(hex.slice(64, 128));

  return isToken0
    ? { tokenReserve: reserve0, wethReserve: reserve1 }
    : { tokenReserve: reserve1, wethReserve: reserve0 };
}

async function checkLpLocked(
  provider: AlchemyProvider,
  poolAddress: string,
): Promise<{ locked: boolean; lockProvider: string | null }> {
  // balanceOf(address) selector 0x70a08231
  for (const lock of LOCK_CONTRACTS) {
    try {
      const data = '0x70a08231' + padAddress(lock.address);
      const result = await provider.call(poolAddress, data);
      const balance = BigInt(result);
      if (balance > 0n) {
        return { locked: true, lockProvider: lock.name };
      }
    } catch {
      // skip
    }
  }
  return { locked: false, lockProvider: null };
}

export async function analyzeLiquidity(
  provider: AlchemyProvider,
  tokenAddress: string,
  chain: Chain,
  marketData?: { price_usd?: number | null },
): Promise<{ data: LiquidityData; flags: Flag[] }> {
  const flags: Flag[] = [];

  const pools = await discoverPools(provider, tokenAddress, chain);

  if (pools.length === 0) {
    flags.push({
      severity: 'critical',
      type: 'no_liquidity_pool',
      value: true,
      detail: 'No liquidity pool found on any supported DEX',
    });
    return {
      data: {
        total_usd: 0,
        lp_locked: false,
        lock_provider: null,
        pool_age_hours: 0,
        dex: 'none',
      },
      flags,
    };
  }

  const primary = pools[0];
  let totalUsd = 0;

  if (primary.type === 'v2') {
    try {
      const { tokenReserve, wethReserve } = await getV2Reserves(
        provider,
        primary.address,
        tokenAddress,
      );

      const wethEth = Number(wethReserve) / 1e18;
      const wethUsd = wethEth * ETH_PRICE_USD;

      if (marketData?.price_usd) {
        // Use market price for token side + ETH estimate for WETH side
        // For V2, total liquidity ≈ 2x the value of one side
        totalUsd = wethUsd * 2;
      } else {
        // Without market data, estimate from WETH side (total ≈ 2x WETH value)
        totalUsd = wethUsd * 2;
      }

      // Also factor in token reserve if we have price
      if (marketData?.price_usd && tokenReserve > 0n) {
        const tokenValue = Number(tokenReserve) / 1e18 * marketData.price_usd;
        totalUsd = wethUsd + tokenValue;
      }
    } catch {
      // reserves call failed, leave totalUsd at 0
    }
  }
  // V3 pools use concentrated liquidity — skip reserve estimation for now

  const { locked, lockProvider } = await checkLpLocked(provider, primary.address);

  const data: LiquidityData = {
    total_usd: Math.round(totalUsd * 100) / 100,
    lp_locked: locked,
    lock_provider: lockProvider,
    pool_age_hours: 0, // would require block timestamp lookup, skip for now
    dex: primary.dex,
  };

  if (!locked) {
    if (totalUsd < 10000) {
      flags.push({
        severity: 'critical',
        type: 'lp_unlocked_low_liquidity',
        value: totalUsd,
        detail: `LP tokens unlocked with only $${totalUsd.toFixed(0)} liquidity`,
      });
    } else {
      flags.push({
        severity: 'high',
        type: 'lp_unlocked',
        value: true,
        detail: 'LP tokens are not locked in any known lock contract',
      });
    }
  }

  if (totalUsd < 10000) {
    flags.push({
      severity: 'medium',
      type: 'low_liquidity',
      value: totalUsd,
      detail: `Total liquidity is only $${totalUsd.toFixed(0)}`,
    });
  }

  return { data, flags };
}
