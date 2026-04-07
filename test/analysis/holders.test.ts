import { describe, it, expect, vi } from 'vitest';
import { analyzeHolders } from '../../src/analysis/holders.js';
import type { AlchemyProvider } from '../../src/providers/alchemy.js';

const TOTAL_SUPPLY_SELECTOR = '0x18160ddd';
const BALANCE_OF_PREFIX = '0x70a08231';

function toHex(value: bigint): string {
  return '0x' + value.toString(16).padStart(64, '0');
}

function createMockProvider(
  overrides: Partial<Record<keyof AlchemyProvider, any>> = {},
): AlchemyProvider {
  return {
    getBytecode: vi.fn().mockResolvedValue(null),
    getStorageAt: vi.fn().mockResolvedValue('0x' + '0'.repeat(64)),
    getBalance: vi.fn().mockResolvedValue(0n),
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getAssetTransfers: vi.fn().mockResolvedValue([]),
    call: vi.fn().mockResolvedValue('0x' + '0'.repeat(64)),
    getChainUrl: vi.fn().mockReturnValue('https://mock.alchemy.com'),
    ...overrides,
  } as unknown as AlchemyProvider;
}

function makeTransfer(from: string, to: string | null) {
  return { from, to, value: 1, asset: 'TOKEN', category: 'erc20', blockNum: '0x1', hash: '0xabc' };
}

function makeAddresses(count: number, prefix = '0xaddr'): string[] {
  return Array.from({ length: count }, (_, i) =>
    (prefix + i.toString().padStart(40 - prefix.length + 2, '0')).slice(0, 42),
  );
}

const TOKEN = '0x1111111111111111111111111111111111111111';
const DEPLOYER = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

describe('analyzeHolders', () => {
  // 2.1 Zero Total Supply
  it('returns zero_supply flag when total supply is zero', async () => {
    const provider = createMockProvider();

    const { data, flags } = await analyzeHolders(provider, TOKEN, DEPLOYER);

    expect(data.total_approx).toBe(0);
    expect(data.top5_pct).toBe(0);
    expect(data.top10_pct).toBe(0);
    expect(data.deployer_pct).toBe(0);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      severity: 'high',
      type: 'zero_supply',
      value: true,
    });
    expect(provider.getAssetTransfers).not.toHaveBeenCalled();
  });

  // 2.2 Normal Distribution (No Flags)
  it('returns no flags for a normally distributed token', async () => {
    const totalSupply = 1_000_000n * 10n ** 18n;
    const addrs = makeAddresses(200);

    const balances: Record<string, bigint> = {};
    // Distribute top 5 at 6% each = 30% total
    for (let i = 0; i < 5; i++) {
      balances[addrs[i].toLowerCase()] = 60_000n * 10n ** 18n;
    }
    // Next 5 at 3% each = 15% → top10 = 45%
    for (let i = 5; i < 10; i++) {
      balances[addrs[i].toLowerCase()] = 30_000n * 10n ** 18n;
    }
    // Remaining 10 at 1% each
    for (let i = 10; i < 20; i++) {
      balances[addrs[i].toLowerCase()] = 10_000n * 10n ** 18n;
    }

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) {
        const addrPadded = data.slice(BALANCE_OF_PREFIX.length);
        const addr = '0x' + addrPadded.replace(/^0+/, '');
        return Promise.resolve(toHex(balances[addr.toLowerCase()] ?? 0n));
      }
      return Promise.resolve(toHex(0n));
    });

    const transfers = addrs.map((a) => makeTransfer(ZERO_ADDR, a));

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    // Deployer holds 2%
    balances[DEPLOYER.toLowerCase()] = 20_000n * 10n ** 18n;

    const { data, flags } = await analyzeHolders(provider, TOKEN, DEPLOYER);

    expect(data.total_approx).toBeGreaterThanOrEqual(200);
    expect(flags.filter((f) => f.type === 'top5_holders_above_50')).toHaveLength(0);
    expect(flags.filter((f) => f.type === 'top10_holders_above_80')).toHaveLength(0);
    expect(flags.filter((f) => f.type === 'deployer_holds_majority')).toHaveLength(0);
    expect(flags.filter((f) => f.type === 'low_holder_count')).toHaveLength(0);
  });

  // 2.3 Top 5 Hold >50% (Critical)
  it('flags top5_holders_above_50 when top 5 hold >50%', async () => {
    const totalSupply = 100_000n;
    const addrs = makeAddresses(20);

    // 5 holders with 12,000 each = 60,000 total = 60%
    const bigBalance = 12_000n;
    const smallBalance = 500n;

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) {
        const addrPadded = data.slice(BALANCE_OF_PREFIX.length);
        const addr = '0x' + addrPadded.replace(/^0+/, '');
        const idx = addrs.findIndex((a) => a.toLowerCase() === addr.toLowerCase());
        if (idx >= 0 && idx < 5) return Promise.resolve(toHex(bigBalance));
        return Promise.resolve(toHex(smallBalance));
      }
      return Promise.resolve(toHex(0n));
    });

    const transfers = addrs.map((a) => makeTransfer(ZERO_ADDR, a));

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { flags } = await analyzeHolders(provider, TOKEN, '');

    const flag = flags.find((f) => f.type === 'top5_holders_above_50');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('critical');
    expect(flag!.value).toBeCloseTo(60, 0);
  });

  // 2.4 Top 10 Hold >80% (High)
  it('flags top10_holders_above_80 without top5_holders_above_50', async () => {
    const totalSupply = 100_000n;
    const addrs = makeAddresses(20);

    // top 5 at 8,000 each = 40,000 = 40%
    // next 5 at 9,000 each = 45,000 → top10 = 85,000 = 85%
    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) {
        const addrPadded = data.slice(BALANCE_OF_PREFIX.length);
        const addr = '0x' + addrPadded.replace(/^0+/, '');
        const idx = addrs.findIndex((a) => a.toLowerCase() === addr.toLowerCase());
        if (idx >= 0 && idx < 5) return Promise.resolve(toHex(8_000n));
        if (idx >= 5 && idx < 10) return Promise.resolve(toHex(9_000n));
        return Promise.resolve(toHex(100n));
      }
      return Promise.resolve(toHex(0n));
    });

    const transfers = addrs.map((a) => makeTransfer(ZERO_ADDR, a));

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { flags } = await analyzeHolders(provider, TOKEN, '');

    expect(flags.find((f) => f.type === 'top5_holders_above_50')).toBeUndefined();
    const flag = flags.find((f) => f.type === 'top10_holders_above_80');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('high');
    expect(flag!.value).toBeCloseTo(85, 0);
  });

  // 2.5 Deployer Holds >50% (Critical)
  it('flags deployer_holds_majority as critical when deployer >50%', async () => {
    const totalSupply = 100_000n;
    const addrs = makeAddresses(20);

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) {
        const addrPadded = data.slice(BALANCE_OF_PREFIX.length);
        const addr = '0x' + addrPadded.replace(/^0+/, '');
        if (addr.toLowerCase() === DEPLOYER.toLowerCase()) return Promise.resolve(toHex(60_000n));
        return Promise.resolve(toHex(500n));
      }
      return Promise.resolve(toHex(0n));
    });

    const transfers = addrs.map((a) => makeTransfer(ZERO_ADDR, a));

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { data, flags } = await analyzeHolders(provider, TOKEN, DEPLOYER);

    expect(data.deployer_pct).toBe(60);
    const flag = flags.find((f) => f.type === 'deployer_holds_majority');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('critical');
  });

  // 2.6 Deployer Holds 10-50% (High)
  it('flags deployer_holds_majority as high when deployer 10-50%', async () => {
    const totalSupply = 100_000n;
    const addrs = makeAddresses(20);

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) {
        const addrPadded = data.slice(BALANCE_OF_PREFIX.length);
        const addr = '0x' + addrPadded.replace(/^0+/, '');
        if (addr.toLowerCase() === DEPLOYER.toLowerCase()) return Promise.resolve(toHex(25_000n));
        return Promise.resolve(toHex(500n));
      }
      return Promise.resolve(toHex(0n));
    });

    const transfers = addrs.map((a) => makeTransfer(ZERO_ADDR, a));

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { data, flags } = await analyzeHolders(provider, TOKEN, DEPLOYER);

    expect(data.deployer_pct).toBe(25);
    const flag = flags.find((f) => f.type === 'deployer_holds_majority');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('high');
  });

  // 2.7 Deployer Holds <10% (No Flag)
  it('does not flag deployer_holds_majority when deployer <10%', async () => {
    const totalSupply = 100_000n;
    const addrs = makeAddresses(20);

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) {
        const addrPadded = data.slice(BALANCE_OF_PREFIX.length);
        const addr = '0x' + addrPadded.replace(/^0+/, '');
        if (addr.toLowerCase() === DEPLOYER.toLowerCase()) return Promise.resolve(toHex(5_000n));
        return Promise.resolve(toHex(500n));
      }
      return Promise.resolve(toHex(0n));
    });

    const transfers = addrs.map((a) => makeTransfer(ZERO_ADDR, a));

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { data, flags } = await analyzeHolders(provider, TOKEN, DEPLOYER);

    expect(data.deployer_pct).toBe(5);
    expect(flags.find((f) => f.type === 'deployer_holds_majority')).toBeUndefined();
  });

  // 2.8 Low Holder Count (<100)
  it('flags low_holder_count when fewer than 100 unique addresses', async () => {
    const totalSupply = 100_000n;
    const addrs = makeAddresses(50);

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) return Promise.resolve(toHex(1_000n));
      return Promise.resolve(toHex(0n));
    });

    const transfers = addrs.map((a) => makeTransfer(ZERO_ADDR, a));

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { data, flags } = await analyzeHolders(provider, TOKEN, '');

    expect(data.total_approx).toBe(50);
    const flag = flags.find((f) => f.type === 'low_holder_count');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('medium');
    expect(flag!.value).toBe(50);
  });

  // 2.9 Empty Transfer History
  it('handles empty transfer history gracefully', async () => {
    const totalSupply = 100_000n;

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      return Promise.resolve(toHex(0n));
    });

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue([]),
    });

    const { data, flags } = await analyzeHolders(provider, TOKEN, '');

    expect(data.total_approx).toBe(0);
    const flag = flags.find((f) => f.type === 'low_holder_count');
    expect(flag).toBeDefined();
  });

  // 2.10 Transfer History Throws
  it('catches getAssetTransfers errors gracefully', async () => {
    const totalSupply = 100_000n;

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      return Promise.resolve(toHex(0n));
    });

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockRejectedValue(new Error('rate limited')),
    });

    const { data, flags } = await analyzeHolders(provider, TOKEN, '');

    expect(data.total_approx).toBe(0);
    const flag = flags.find((f) => f.type === 'low_holder_count');
    expect(flag).toBeDefined();
  });

  // 2.11 Zero Address Filtered Out
  it('filters out the zero address from holder list', async () => {
    const totalSupply = 100_000n;
    const realAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) return Promise.resolve(toHex(5_000n));
      return Promise.resolve(toHex(0n));
    });

    const transfers = [
      makeTransfer(ZERO_ADDR, realAddr),
      makeTransfer(ZERO_ADDR, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    ];

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { data } = await analyzeHolders(provider, TOKEN, '');

    // Zero address should be filtered, so only 2 real addresses
    expect(data.total_approx).toBe(2);

    // Verify balanceOf was never called for the zero address
    const callArgs = (callMock.mock.calls as [string, string][])
      .filter(([, d]) => d.startsWith(BALANCE_OF_PREFIX))
      .map(([, d]) => d.slice(BALANCE_OF_PREFIX.length));
    const zeroAddrPadded = '0'.repeat(64);
    expect(callArgs).not.toContain(zeroAddrPadded);
  });

  // 2.12 Deployer Address Empty String
  it('returns deployer_pct 0 when deployerAddress is empty', async () => {
    const totalSupply = 100_000n;
    const addrs = makeAddresses(10);

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) return Promise.resolve(toHex(1_000n));
      return Promise.resolve(toHex(0n));
    });

    const transfers = addrs.map((a) => makeTransfer(ZERO_ADDR, a));

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { data } = await analyzeHolders(provider, TOKEN, '');

    expect(data.deployer_pct).toBe(0);
  });

  // 2.13 All Balances Zero
  it('returns 0 for top5_pct and top10_pct when all balances are zero', async () => {
    const totalSupply = 100_000n;
    const addrs = makeAddresses(20);

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      return Promise.resolve(toHex(0n));
    });

    const transfers = addrs.map((a) => makeTransfer(ZERO_ADDR, a));

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { data } = await analyzeHolders(provider, TOKEN, '');

    expect(data.top5_pct).toBe(0);
    expect(data.top10_pct).toBe(0);
  });

  // 2.14 BalanceOf Call Fails for Some Holders
  it('handles partial balanceOf failures gracefully', async () => {
    const totalSupply = 100_000n;
    const addrs = makeAddresses(20);
    let balanceCallCount = 0;

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) {
        balanceCallCount++;
        if (balanceCallCount > 10) return Promise.reject(new Error('RPC error'));
        return Promise.resolve(toHex(1_000n));
      }
      return Promise.resolve(toHex(0n));
    });

    const transfers = addrs.map((a) => makeTransfer(ZERO_ADDR, a));

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { data } = await analyzeHolders(provider, TOKEN, '');

    // Should not crash, and should have some valid percentages
    expect(data.top5_pct).toBeGreaterThan(0);
    expect(data.total_approx).toBe(20);
  });

  // 2.15 More Than 20 Unique Addresses
  it('queries balanceOf for at most 20 addresses from transfers', async () => {
    const totalSupply = 1_000_000n;
    const addrs = makeAddresses(500);

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) return Promise.resolve(toHex(1_000n));
      return Promise.resolve(toHex(0n));
    });

    const transfers = addrs.map((a) => makeTransfer(ZERO_ADDR, a));

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { data } = await analyzeHolders(provider, TOKEN, DEPLOYER);

    expect(data.total_approx).toBe(500);

    // Count balanceOf calls: should be 20 (from slice) + 1 (deployer) + 1 (totalSupply) = 22
    const balanceOfCalls = (callMock.mock.calls as [string, string][]).filter(
      ([, d]) => d.startsWith(BALANCE_OF_PREFIX),
    );
    // 20 from address list + 1 for deployer
    expect(balanceOfCalls).toHaveLength(21);
  });

  // 2.16 Percentage Calculation Precision
  it('calculates percentages with basis-point precision', async () => {
    const totalSupply = 3n;
    const holder = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const callMock = vi.fn().mockImplementation((_to: string, data: string) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return Promise.resolve(toHex(totalSupply));
      if (data.startsWith(BALANCE_OF_PREFIX)) {
        const addrPadded = data.slice(BALANCE_OF_PREFIX.length);
        const addr = '0x' + addrPadded.replace(/^0+/, '');
        if (addr.toLowerCase() === holder.toLowerCase()) return Promise.resolve(toHex(1n));
        return Promise.resolve(toHex(0n));
      }
      return Promise.resolve(toHex(0n));
    });

    const transfers = [makeTransfer(ZERO_ADDR, holder)];

    const provider = createMockProvider({
      call: callMock,
      getAssetTransfers: vi.fn().mockResolvedValue(transfers),
    });

    const { data } = await analyzeHolders(provider, TOKEN, '');

    // 1/3 * 10000 = 3333 (integer division) → 3333/100 = 33.33
    expect(data.top5_pct).toBeCloseTo(33.33, 1);
  });
});
