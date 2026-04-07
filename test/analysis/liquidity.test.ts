import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AlchemyProvider } from '../../src/providers/alchemy.js';

const ZERO_ADDRESS_RESULT = '0x' + '0'.repeat(64);
const POOL_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const POOL_ADDRESS_PADDED = '0x' + '0'.repeat(24) + '1234567890abcdef1234567890abcdef12345678';
const TOKEN_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const UNISWAP_V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA68';
const UNISWAP_V3_FACTORY_ETH = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const UNISWAP_V3_FACTORY_BASE = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';

// Lock contract addresses
const UNCX_ETH = '0x663A5C229c09b049E36dCc11a9B0d4a8Eb9db214';
const TEAM_FINANCE_ETH = '0xE2fE530C047f2d85298b07D9333C05737f1435fB';
const UNCX_BASE = '0xFD235968e65B0990584585763f837A5b5330e6DE';
const TEAM_FINANCE_BASE = '0xe2eCEBcfc12F231e9468F8c1C3FC1aB45AC9268C';

function padAddress(addr: string): string {
  return addr.slice(2).toLowerCase().padStart(64, '0');
}

function createMockProvider(overrides: Partial<Record<keyof AlchemyProvider, any>> = {}): AlchemyProvider {
  return {
    getBytecode: vi.fn().mockResolvedValue(null),
    getStorageAt: vi.fn().mockResolvedValue(ZERO_ADDRESS_RESULT),
    getBalance: vi.fn().mockResolvedValue(0n),
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getAssetTransfers: vi.fn().mockResolvedValue([]),
    call: vi.fn().mockResolvedValue(ZERO_ADDRESS_RESULT),
    getChainUrl: vi.fn().mockReturnValue('https://mock.alchemy.com'),
    ...overrides,
  } as unknown as AlchemyProvider;
}

function mockEthPriceFetch(fetchSpy: ReturnType<typeof vi.spyOn>, priceUsd: string = '3000') {
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify({ pairs: [{ priceUsd }] }), { status: 200 }),
  );
}

/**
 * Build a reserves hex: 2x uint112 packed (each 64 hex chars = 256 bits).
 * reserve0 first, reserve1 second, plus 64 chars for blockTimestampLast.
 */
function encodeReserves(reserve0: bigint, reserve1: bigint): string {
  const r0Hex = reserve0.toString(16).padStart(64, '0');
  const r1Hex = reserve1.toString(16).padStart(64, '0');
  const tsHex = '0'.repeat(64);
  return '0x' + r0Hex + r1Hex + tsHex;
}

function encodeAddressResult(addr: string): string {
  return '0x' + padAddress(addr);
}

describe('analyzeLiquidity', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    mockEthPriceFetch(fetchSpy);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // 4.1 No Pools Found
  it('returns no_liquidity_pool flag when all factory calls return zero address', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');
    const provider = createMockProvider();

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    expect(result.data.dex).toBe('none');
    expect(result.data.total_usd).toBe(0);
    expect(result.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'critical', type: 'no_liquidity_pool' }),
      ]),
    );
  });

  // 4.2 Uniswap V2 Pool Found (Ethereum)
  it('finds Uniswap V2 pool on Ethereum with correct reserves', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    // token is token0, WETH is token1
    const wethReserve = 5n * 10n ** 18n;
    const tokenReserve = 1000000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        // V2 factory getPair
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase() && data.startsWith('0xe6a43905')) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        // V3 factory - return zero
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        // Pool token0()
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        // Pool getReserves()
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        // Lock contract balanceOf - return 0
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    expect(result.data.dex).toBe('uniswap_v2');
    expect(result.data.total_usd).toBeGreaterThan(0);
  });

  // 4.3 Uniswap V3 Pool Found
  it('finds Uniswap V3 pool when V2 returns zero', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    const v3PoolAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const v3PoolPadded = '0x' + padAddress(v3PoolAddress);

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        // V2 factory - return zero
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        // V3 factory getPool - return pool
        if (to.toLowerCase() === UNISWAP_V3_FACTORY_ETH.toLowerCase() && data.startsWith('0x1698ee82')) {
          return Promise.resolve(v3PoolPadded);
        }
        // Lock contract balanceOf - return 0
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    expect(result.data.dex).toBe('uniswap_v3');
    // V3 reserves not estimated
    expect(result.data.total_usd).toBe(0);
  });

  // 4.4 Aerodrome Pool Found (Base Only)
  it('finds Aerodrome pool on Base', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    const aeroPoolAddress = '0xcccccccccccccccccccccccccccccccccccccccc';
    const aeroPoolPadded = '0x' + padAddress(aeroPoolAddress);
    const wethReserve = 3n * 10n ** 18n;
    const tokenReserve = 500000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        // V2 factory - return zero
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        // V3 factory - return zero
        if (to.toLowerCase() === UNISWAP_V3_FACTORY_BASE.toLowerCase()) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        // Aerodrome factory
        if (to.toLowerCase() === AERODROME_FACTORY.toLowerCase() && data.startsWith('0x79bc57d5')) {
          return Promise.resolve(aeroPoolPadded);
        }
        // Pool token0()
        if (to.toLowerCase() === aeroPoolAddress.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        // Pool getReserves()
        if (to.toLowerCase() === aeroPoolAddress.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        // Lock balanceOf - return 0
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'base');

    expect(result.data.dex).toBe('aerodrome');
    expect(result.data.total_usd).toBeGreaterThan(0);
  });

  // 4.5 Aerodrome NOT Queried on Ethereum
  it('does not query Aerodrome factory on Ethereum', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    const callMock = vi.fn().mockResolvedValue(ZERO_ADDRESS_RESULT);
    const provider = createMockProvider({ call: callMock });

    await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    const calls = callMock.mock.calls;
    const calledAddresses = calls.map((c: any[]) => c[0].toLowerCase());
    expect(calledAddresses).not.toContain(AERODROME_FACTORY.toLowerCase());
  });

  // 4.6 LP Locked (UNCX on Ethereum)
  it('detects LP locked via UNCX on Ethereum', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        // V2 factory - return pool
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        // V3 - not called after V2 found, but return zero just in case
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        // Pool token0
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        // Pool getReserves
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          const wethReserve = 10n * 10n ** 18n;
          const tokenReserve = 1000000n * 10n ** 18n;
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        // UNCX balanceOf on pool - return >0
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() &&
            data.includes(padAddress(UNCX_ETH))) {
          return Promise.resolve('0x' + (1000n).toString(16).padStart(64, '0'));
        }
        // Other lock contracts - return 0
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    expect(result.data.lp_locked).toBe(true);
    expect(result.data.lock_provider).toBe('UNCX');
    const unlockFlag = result.flags.find((f) => f.type === 'lp_unlocked');
    expect(unlockFlag).toBeUndefined();
  });

  // 4.7 LP Locked (Team Finance on Base)
  it('detects LP locked via Team Finance on Base', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    const aeroPoolAddress = '0xdddddddddddddddddddddddddddddddddddddd';
    const aeroPoolPadded = '0x' + padAddress(aeroPoolAddress);

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        // V2 factory - return zero
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        // V3 factory - return zero
        if (to.toLowerCase() === UNISWAP_V3_FACTORY_BASE.toLowerCase()) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        // Aerodrome factory - return pool
        if (to.toLowerCase() === AERODROME_FACTORY.toLowerCase()) {
          return Promise.resolve(aeroPoolPadded);
        }
        // Pool token0
        if (to.toLowerCase() === aeroPoolAddress.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        // Pool getReserves
        if (to.toLowerCase() === aeroPoolAddress.toLowerCase() && data === '0x0902f1ac') {
          const wethReserve = 10n * 10n ** 18n;
          const tokenReserve = 1000000n * 10n ** 18n;
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        // UNCX on Base - return 0
        if (to.toLowerCase() === aeroPoolAddress.toLowerCase() &&
            data.includes(padAddress(UNCX_BASE))) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        // balanceOf calls for lock detection
        if (data.startsWith('0x70a08231')) {
          // Team Finance on Base - return >0
          if (data.includes(padAddress(TEAM_FINANCE_BASE).toLowerCase())) {
            return Promise.resolve('0x' + (5000n).toString(16).padStart(64, '0'));
          }
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'base');

    expect(result.data.lp_locked).toBe(true);
    expect(result.data.lock_provider).toBe('Team Finance');
  });

  // 4.8 LP Unlocked with High Liquidity
  it('flags lp_unlocked (high) when locks are zero and liquidity > $10k', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    // 5 WETH * $3000 * 2 = $30000
    const wethReserve = 5n * 10n ** 18n;
    const tokenReserve = 1000000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    expect(result.data.lp_locked).toBe(false);
    const unlocked = result.flags.find((f) => f.type === 'lp_unlocked');
    expect(unlocked).toBeDefined();
    expect(unlocked!.severity).toBe('high');
    // Should NOT have the critical lp_unlocked_low_liquidity
    const criticalUnlocked = result.flags.find((f) => f.type === 'lp_unlocked_low_liquidity');
    expect(criticalUnlocked).toBeUndefined();
  });

  // 4.9 LP Unlocked with Low Liquidity (<$10k)
  it('flags lp_unlocked_low_liquidity (critical) and low_liquidity when totalUsd < $10k', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    // 1 WETH * $3000 * 2 = $6000
    const wethReserve = 1n * 10n ** 18n;
    const tokenReserve = 100000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    const criticalFlag = result.flags.find((f) => f.type === 'lp_unlocked_low_liquidity');
    expect(criticalFlag).toBeDefined();
    expect(criticalFlag!.severity).toBe('critical');

    const lowLiqFlag = result.flags.find((f) => f.type === 'low_liquidity');
    expect(lowLiqFlag).toBeDefined();
    expect(lowLiqFlag!.severity).toBe('medium');
  });

  // 4.10 Low Liquidity Flag
  it('flags low_liquidity (medium) when totalUsd < $10k', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    // 0.5 WETH * $3000 * 2 = $3000
    const wethReserve = 5n * 10n ** 17n;
    const tokenReserve = 50000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    const lowLiqFlag = result.flags.find((f) => f.type === 'low_liquidity');
    expect(lowLiqFlag).toBeDefined();
    expect(lowLiqFlag!.severity).toBe('medium');
  });

  // 4.11 V2 Reserve Calculation (WETH * 2)
  it('calculates totalUsd as wethUsd * 2 when no market data', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    // token is token0, WETH is token1
    // 5 WETH * $3000 = $15000 WETH side => $30000 total
    const wethReserve = 5n * 10n ** 18n;
    const tokenReserve = 1000000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    expect(result.data.total_usd).toBe(30000);
  });

  // 4.12 V2 Reserve Calculation (Token is token1)
  it('handles WETH as token0 and calculates correctly', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    // WETH is token0 (reserve0), token is token1 (reserve1)
    const wethReserve = 10n * 10n ** 18n;
    const tokenReserve = 2000000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        // token0() returns WETH address
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(WETH_ETH));
        }
        // getReserves: reserve0 = WETH, reserve1 = token
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(wethReserve, tokenReserve));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    // 10 WETH * $3000 * 2 = $60000
    expect(result.data.total_usd).toBe(60000);
  });

  // 4.13 ETH Price Fetch Fails (Fallback $3000)
  it('uses $3000 fallback when fetch throws', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    fetchSpy.mockRejectedValue(new Error('Network error'));

    const wethReserve = 1n * 10n ** 18n;
    const tokenReserve = 100000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    // 1 WETH * $3000 fallback * 2 = $6000
    expect(result.data.total_usd).toBe(6000);
  });

  // 4.14 ETH Price Fetch Returns Non-OK Response
  it('uses $3000 fallback when fetch returns 500', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    fetchSpy.mockResolvedValue(new Response('Server Error', { status: 500 }));

    const wethReserve = 2n * 10n ** 18n;
    const tokenReserve = 200000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    // 2 WETH * $3000 fallback * 2 = $12000
    expect(result.data.total_usd).toBe(12000);
  });

  // 4.15 ETH Price Fetch Returns No Pairs
  it('uses $3000 fallback when response has pairs: null', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ pairs: null }), { status: 200 }),
    );

    const wethReserve = 1n * 10n ** 18n;
    const tokenReserve = 100000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    // 1 WETH * $3000 * 2 = $6000
    expect(result.data.total_usd).toBe(6000);
  });

  // 4.16 ETH Price Fetch Returns Null Price
  it('uses $3000 fallback when pair has priceUsd: null', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ pairs: [{ priceUsd: null }] }), { status: 200 }),
    );

    const wethReserve = 1n * 10n ** 18n;
    const tokenReserve = 100000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    // 1 WETH * $3000 * 2 = $6000
    expect(result.data.total_usd).toBe(6000);
  });

  // 4.17 V2 getReserves Throws
  it('returns total_usd: 0 when getReserves throws', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        // token0() succeeds
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        // getReserves() throws
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.reject(new Error('RPC call failed'));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    expect(result.data.total_usd).toBe(0);
    // Should not crash
    expect(result.data.dex).toBe('uniswap_v2');
  });

  // 4.18 Lock Check Throws for One Provider
  it('returns lp_locked: false when lock check throws and does not crash', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          const wethReserve = 5n * 10n ** 18n;
          const tokenReserve = 1000000n * 10n ** 18n;
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        // UNCX lock check throws
        if (data.startsWith('0x70a08231') && data.includes(padAddress(UNCX_ETH))) {
          return Promise.reject(new Error('Lock check failed'));
        }
        // Team Finance returns 0
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    expect(result.data.lp_locked).toBe(false);
  });

  // 4.19 Multiple Pools — Uses First Found
  it('uses V2 pool when both V2 and V3 return valid pools', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    const v3PoolAddress = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const v3PoolPadded = '0x' + padAddress(v3PoolAddress);

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        // V2 returns pool
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        // V3 also returns pool
        if (to.toLowerCase() === UNISWAP_V3_FACTORY_ETH.toLowerCase()) {
          return Promise.resolve(v3PoolPadded);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          const wethReserve = 5n * 10n ** 18n;
          const tokenReserve = 1000000n * 10n ** 18n;
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    // First found is V2
    expect(result.data.dex).toBe('uniswap_v2');
  });

  // 4.20 V3 Fee Tier Search — Stops at First Match
  it('stops V3 fee tier search at first match', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    const v3Pool3000 = '0xfffffffffffffffffffffffffffffffffffffff1';
    const v3Pool3000Padded = '0x' + padAddress(v3Pool3000);

    const callMock = vi.fn().mockImplementation((to: string, data: string) => {
      // V2 returns zero
      if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }
      // V3 factory
      if (to.toLowerCase() === UNISWAP_V3_FACTORY_ETH.toLowerCase() && data.startsWith('0x1698ee82')) {
        // fee=500 -> zero
        const fee500Pad = (500).toString(16).padStart(64, '0');
        if (data.includes(fee500Pad)) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        // fee=3000 -> found
        const fee3000Pad = (3000).toString(16).padStart(64, '0');
        if (data.includes(fee3000Pad)) {
          return Promise.resolve(v3Pool3000Padded);
        }
        // fee=10000 -> should not be called
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }
      if (data.startsWith('0x70a08231')) {
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }
      return Promise.resolve(ZERO_ADDRESS_RESULT);
    });

    const provider = createMockProvider({ call: callMock });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    expect(result.data.dex).toBe('uniswap_v3');

    // Check that fee=10000 was never queried
    const v3Calls = callMock.mock.calls.filter(
      (c: any[]) => c[0].toLowerCase() === UNISWAP_V3_FACTORY_ETH.toLowerCase(),
    );
    const fee10000Pad = (10000).toString(16).padStart(64, '0');
    const has10000Call = v3Calls.some((c: any[]) => c[1].includes(fee10000Pad));
    expect(has10000Call).toBe(false);
  });

  // 4.21 MarketData Price Used for Token Side
  it('uses marketData.price_usd for token side of liquidity calculation', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    // WETH reserve: 2 WETH, token reserve: 100000 tokens (18 decimals)
    const wethReserve = 2n * 10n ** 18n;
    const tokenReserve = 100000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        // decimals() selector for token
        if (to.toLowerCase() === TOKEN_ADDRESS.toLowerCase() && data === '0x313ce567') {
          // Return 18 decimals
          return Promise.resolve('0x' + (18).toString(16).padStart(64, '0'));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum', {
      price_usd: 0.5,
    });

    // WETH side: 2 * 3000 = $6000
    // Token side: 100000 * 0.5 = $50000
    // Total: $56000
    expect(result.data.total_usd).toBe(56000);
  });

  // 4.22 totalUsd Rounded to 2 Decimal Places
  it('rounds total_usd to 2 decimal places', async () => {
    const { analyzeLiquidity } = await import('../../src/analysis/liquidity.js');

    // Use a fractional WETH reserve that produces a non-round number
    // 1.123456789 WETH * 2 * $3000 = $6740.740734
    const wethReserve = 1123456789000000000n; // ~1.123456789 WETH
    const tokenReserve = 100000n * 10n ** 18n;

    const provider = createMockProvider({
      call: vi.fn().mockImplementation((to: string, data: string) => {
        if (to.toLowerCase() === UNISWAP_V2_FACTORY.toLowerCase()) {
          return Promise.resolve(POOL_ADDRESS_PADDED);
        }
        if (data.startsWith('0x1698ee82')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0dfe1681') {
          return Promise.resolve(encodeAddressResult(TOKEN_ADDRESS));
        }
        if (to.toLowerCase() === POOL_ADDRESS.toLowerCase() && data === '0x0902f1ac') {
          return Promise.resolve(encodeReserves(tokenReserve, wethReserve));
        }
        if (data.startsWith('0x70a08231')) {
          return Promise.resolve(ZERO_ADDRESS_RESULT);
        }
        return Promise.resolve(ZERO_ADDRESS_RESULT);
      }),
    });

    const result = await analyzeLiquidity(provider, TOKEN_ADDRESS, 'ethereum');

    const totalStr = result.data.total_usd.toString();
    const decimalPart = totalStr.includes('.') ? totalStr.split('.')[1] : '';
    expect(decimalPart.length).toBeLessThanOrEqual(2);
  });
});
