import type { Chain, Flag, TradingData } from '../types/index.js';
import { AlchemyProvider } from './alchemy.js';

const WETH: Record<Chain, string> = {
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  base: '0x4200000000000000000000000000000000000006',
};

const ROUTERS: Record<string, Record<Chain, string | null>> = {
  uniswap_v2: {
    ethereum: '0x7a250d5C2e172789FaA508100449C43e80D7c5ac',
    base: null,
  },
  aerodrome: {
    ethereum: null,
    base: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
  },
};

const AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';

// 0.01 ETH in wei
const BUY_AMOUNT_WEI = 10000000000000000n;

function padAddress(addr: string): string {
  return addr.slice(2).toLowerCase().padStart(64, '0');
}

function padUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

function encodeGetAmountsOut(amountIn: bigint, path: string[]): string {
  const selector = '0xd06ca61f';
  const amountPad = padUint256(amountIn);
  // offset to dynamic array (64 bytes = 0x40)
  const offset = padUint256(64n);
  // array length
  const length = padUint256(BigInt(path.length));
  // array elements
  const elements = path.map(padAddress).join('');

  return selector + amountPad + offset + length + elements;
}

function encodeAerodromeGetAmountsOut(
  amountIn: bigint,
  from: string,
  to: string,
  stable: boolean,
  factory: string,
): string {
  // getAmountsOut(uint256,(address,address,bool,address)[])
  const selector = '0x5509a1ac';
  const amountPad = padUint256(amountIn);
  // offset to dynamic routes array (64 bytes = 0x40)
  const offset = padUint256(64n);
  // array length = 1 route
  const length = padUint256(1n);
  // Route struct: (address from, address to, bool stable, address factory)
  const fromPad = padAddress(from);
  const toPad = padAddress(to);
  const stablePad = padUint256(stable ? 1n : 0n);
  const factoryPad = padAddress(factory);

  return selector + amountPad + offset + length + fromPad + toPad + stablePad + factoryPad;
}

function decodeAmountsOut(result: string): bigint[] {
  const hex = result.slice(2);
  // First 32 bytes: offset to array
  // Next 32 bytes: array length
  const length = Number(BigInt('0x' + hex.slice(64, 128)));
  const amounts: bigint[] = [];
  for (let i = 0; i < length; i++) {
    const start = 128 + i * 64;
    amounts.push(BigInt('0x' + hex.slice(start, start + 64)));
  }
  return amounts;
}

function getRouterAddress(dex: string, chain: Chain): string | null {
  // uniswap_v2 router works for uniswap_v2 on ethereum
  // aerodrome router works for aerodrome on base
  // For uniswap_v3, simulation via getAmountsOut is not applicable (different interface)
  if (dex === 'uniswap_v3') return null;

  const routerMap = ROUTERS[dex];
  if (!routerMap) return null;
  return routerMap[chain] ?? null;
}

export async function simulateTrade(
  provider: AlchemyProvider,
  tokenAddress: string,
  chain: Chain,
  poolAddress: string,
  dex: string,
): Promise<{ data: TradingData; flags: Flag[] }> {
  const skipped: { data: TradingData; flags: Flag[] } = {
    data: {
      buy_tax_pct: null,
      sell_tax_pct: null,
      can_sell: null,
      simulation_method: 'skipped',
    },
    flags: [],
  };

  try {
    const router = getRouterAddress(dex, chain);
    if (!router) return skipped;

    const weth = WETH[chain];
    const isAerodrome = dex === 'aerodrome';

    // Step 1: Simulate buy — getAmountsOut(0.01 ETH, [WETH, token])
    let tokensOut: bigint;
    try {
      const buyData = isAerodrome
        ? encodeAerodromeGetAmountsOut(BUY_AMOUNT_WEI, weth, tokenAddress, false, AERODROME_FACTORY)
        : encodeGetAmountsOut(BUY_AMOUNT_WEI, [weth, tokenAddress]);
      const buyResult = await provider.call(router, buyData);
      const buyAmounts = decodeAmountsOut(buyResult);
      tokensOut = buyAmounts[buyAmounts.length - 1];
    } catch {
      // Buy simulation failed — can't proceed
      return skipped;
    }

    if (tokensOut === 0n) return skipped;

    // Step 2: Simulate sell — getAmountsOut(tokensOut, [token, WETH])
    let wethBack: bigint;
    let canSell = true;
    try {
      const sellData = isAerodrome
        ? encodeAerodromeGetAmountsOut(tokensOut, tokenAddress, weth, false, AERODROME_FACTORY)
        : encodeGetAmountsOut(tokensOut, [tokenAddress, weth]);
      const sellResult = await provider.call(router, sellData);
      const sellAmounts = decodeAmountsOut(sellResult);
      wethBack = sellAmounts[sellAmounts.length - 1];
    } catch {
      // Sell reverted — honeypot
      canSell = false;
      wethBack = 0n;
    }

    // Step 3: Calculate taxes from round-trip
    // Total round-trip loss includes DEX fees (0.3% each way ≈ 0.6%) + token taxes
    // Round-trip tax = (amountIn - amountOut) / amountIn * 100
    const flags: Flag[] = [];

    if (!canSell) {
      flags.push({
        severity: 'critical',
        type: 'honeypot_cant_sell',
        value: true,
        detail: 'Sell simulation reverted — token may be a honeypot',
      });

      return {
        data: {
          buy_tax_pct: null,
          sell_tax_pct: null,
          can_sell: false,
          simulation_method: 'getAmountsOut_roundtrip',
        },
        flags,
      };
    }

    const roundTripTaxPct =
      Number(BUY_AMOUNT_WEI - wethBack) / Number(BUY_AMOUNT_WEI) * 100;

    // DEX fee is ~0.3% per swap = ~0.6% round trip
    const dexFeePct = 0.6;
    const tokenTaxTotal = Math.max(0, roundTripTaxPct - dexFeePct);

    // Split roughly: buy tax ≈ 0, sell tax ≈ most of the token tax
    // (Most rug tokens tax on sell, not buy)
    const buyTaxPct = Math.round(tokenTaxTotal * 0.1 * 100) / 100;
    const sellTaxPct = Math.round(tokenTaxTotal * 0.9 * 100) / 100;

    if (sellTaxPct > 10) {
      flags.push({
        severity: 'high',
        type: 'high_sell_tax',
        value: sellTaxPct,
        detail: `Estimated sell tax is ${sellTaxPct.toFixed(1)}%`,
      });
    }

    if (sellTaxPct - buyTaxPct > 5) {
      flags.push({
        severity: 'high',
        type: 'asymmetric_tax',
        value: sellTaxPct - buyTaxPct,
        detail: `Sell tax (${sellTaxPct.toFixed(1)}%) significantly exceeds buy tax (${buyTaxPct.toFixed(1)}%)`,
      });
    }

    return {
      data: {
        buy_tax_pct: buyTaxPct,
        sell_tax_pct: sellTaxPct,
        can_sell: true,
        simulation_method: 'getAmountsOut_roundtrip',
      },
      flags,
    };
  } catch {
    return skipped;
  }
}
