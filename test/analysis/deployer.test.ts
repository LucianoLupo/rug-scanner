import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AlchemyProvider } from '../../src/providers/alchemy.js';

const ZERO_SLOT = '0x' + '0'.repeat(64);

function createMockProvider(overrides: Partial<Record<keyof AlchemyProvider, any>> = {}): AlchemyProvider {
  return {
    getBytecode: vi.fn().mockResolvedValue(null),
    getStorageAt: vi.fn().mockResolvedValue(ZERO_SLOT),
    getBalance: vi.fn().mockResolvedValue(0n),
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getAssetTransfers: vi.fn().mockResolvedValue([]),
    call: vi.fn().mockResolvedValue(ZERO_SLOT),
    getChainUrl: vi.fn().mockReturnValue('https://mock.alchemy.com'),
    ...overrides,
  } as unknown as AlchemyProvider;
}

const TOKEN = '0x1234567890abcdef1234567890abcdef12345678';
const DEPLOYER_ADDR = '0xDeployer123000000000000000000000000000001';
const FUNDER_ADDR = '0xFunder456000000000000000000000000000002';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('getDeployerAddress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 3.1 Deployer Found via ERC20 Mint (Primary Method)
  it('returns deployer address from ERC20 mint (transfer from zero address)', async () => {
    const { getDeployerAddress } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn().mockResolvedValueOnce([
        { from: ZERO_ADDRESS, to: DEPLOYER_ADDR, asset: TOKEN },
      ]),
    });

    const result = await getDeployerAddress(provider, TOKEN);

    expect(result).toBe(DEPLOYER_ADDR);
    expect(provider.getAssetTransfers).toHaveBeenCalledTimes(1);
    expect(provider.getAssetTransfers).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: ZERO_ADDRESS,
        category: ['erc20'],
      }),
    );
  });

  // 3.2 Deployer Found via External TX Fallback
  it('falls back to external tx when no ERC20 mint found', async () => {
    const { getDeployerAddress } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn()
        .mockResolvedValueOnce([]) // erc20 mint: empty
        .mockResolvedValueOnce([{ from: FUNDER_ADDR, to: TOKEN }]), // external fallback
    });

    const result = await getDeployerAddress(provider, TOKEN);

    expect(result).toBe(FUNDER_ADDR);
    expect(provider.getAssetTransfers).toHaveBeenCalledTimes(2);
    expect(provider.getAssetTransfers).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toAddress: TOKEN,
        category: ['external'],
      }),
    );
  });

  // 3.3 Deployer Not Found (Both Methods Fail)
  it('returns null when both methods return empty', async () => {
    const { getDeployerAddress } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    });

    const result = await getDeployerAddress(provider, TOKEN);

    expect(result).toBeNull();
    expect(provider.getAssetTransfers).toHaveBeenCalledTimes(2);
  });

  // 3.4 Primary Method Throws, Fallback Succeeds
  it('uses fallback when primary method throws', async () => {
    const { getDeployerAddress } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn()
        .mockRejectedValueOnce(new Error('RPC error'))
        .mockResolvedValueOnce([{ from: FUNDER_ADDR, to: TOKEN }]),
    });

    const result = await getDeployerAddress(provider, TOKEN);

    expect(result).toBe(FUNDER_ADDR);
  });

  // 3.5 Both Methods Throw
  it('returns null when both methods throw', async () => {
    const { getDeployerAddress } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn()
        .mockRejectedValueOnce(new Error('RPC error 1'))
        .mockRejectedValueOnce(new Error('RPC error 2')),
    });

    const result = await getDeployerAddress(provider, TOKEN);

    expect(result).toBeNull();
  });
});

describe('analyzeDeployer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 3.6 Deployer Unknown
  it('returns deployer_unknown flag when deployer cannot be found', async () => {
    const { analyzeDeployer } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    });

    const result = await analyzeDeployer(provider, TOKEN);

    expect(result.data).toEqual({ age_days: -1, tx_count: 0, eth_balance: 0 });
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]).toMatchObject({
      severity: 'medium',
      type: 'deployer_unknown',
      value: true,
    });
    expect(provider.getTransactionCount).not.toHaveBeenCalled();
    expect(provider.getBalance).not.toHaveBeenCalled();
  });

  // 3.7 Disposable Wallet (tx_count < 5)
  it('flags deployer_disposable when tx_count < 5', async () => {
    const { analyzeDeployer } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn().mockResolvedValueOnce([
        { from: ZERO_ADDRESS, to: DEPLOYER_ADDR },
      ]),
      getTransactionCount: vi.fn().mockResolvedValue(3),
      getBalance: vi.fn().mockResolvedValue(500000000000000000n), // 0.5 ETH
    });

    const result = await analyzeDeployer(provider, TOKEN);

    expect(result.data.tx_count).toBe(3);
    const disposableFlag = result.flags.find(f => f.type === 'deployer_disposable');
    expect(disposableFlag).toBeDefined();
    expect(disposableFlag!.severity).toBe('high');
    expect(disposableFlag!.value).toBe(3);
  });

  // 3.8 Fresh Wallet (tx_count 5-19)
  it('flags deployer_fresh_wallet when tx_count is between 5 and 19', async () => {
    const { analyzeDeployer } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn().mockResolvedValueOnce([
        { from: ZERO_ADDRESS, to: DEPLOYER_ADDR },
      ]),
      getTransactionCount: vi.fn().mockResolvedValue(12),
      getBalance: vi.fn().mockResolvedValue(500000000000000000n),
    });

    const result = await analyzeDeployer(provider, TOKEN);

    expect(result.data.tx_count).toBe(12);
    const freshFlag = result.flags.find(f => f.type === 'deployer_fresh_wallet');
    expect(freshFlag).toBeDefined();
    expect(freshFlag!.severity).toBe('medium');
    expect(freshFlag!.value).toBe(12);
    expect(result.flags.find(f => f.type === 'deployer_disposable')).toBeUndefined();
  });

  // 3.9 Established Wallet (tx_count >= 20)
  it('does not flag deployer_disposable or deployer_fresh_wallet when tx_count >= 20', async () => {
    const { analyzeDeployer } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn().mockResolvedValueOnce([
        { from: ZERO_ADDRESS, to: DEPLOYER_ADDR },
      ]),
      getTransactionCount: vi.fn().mockResolvedValue(150),
      getBalance: vi.fn().mockResolvedValue(500000000000000000n),
    });

    const result = await analyzeDeployer(provider, TOKEN);

    expect(result.data.tx_count).toBe(150);
    expect(result.flags.find(f => f.type === 'deployer_disposable')).toBeUndefined();
    expect(result.flags.find(f => f.type === 'deployer_fresh_wallet')).toBeUndefined();
  });

  // 3.10 Low Balance (< 0.1 ETH)
  it('flags deployer_low_balance when balance < 0.1 ETH', async () => {
    const { analyzeDeployer } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn().mockResolvedValueOnce([
        { from: ZERO_ADDRESS, to: DEPLOYER_ADDR },
      ]),
      getTransactionCount: vi.fn().mockResolvedValue(150),
      getBalance: vi.fn().mockResolvedValue(50000000000000000n), // 0.05 ETH
    });

    const result = await analyzeDeployer(provider, TOKEN);

    expect(result.data.eth_balance).toBeCloseTo(0.05);
    const lowBalanceFlag = result.flags.find(f => f.type === 'deployer_low_balance');
    expect(lowBalanceFlag).toBeDefined();
    expect(lowBalanceFlag!.severity).toBe('low');
  });

  // 3.11 Normal Balance (>= 0.1 ETH)
  it('does not flag deployer_low_balance when balance >= 0.1 ETH', async () => {
    const { analyzeDeployer } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn().mockResolvedValueOnce([
        { from: ZERO_ADDRESS, to: DEPLOYER_ADDR },
      ]),
      getTransactionCount: vi.fn().mockResolvedValue(150),
      getBalance: vi.fn().mockResolvedValue(500000000000000000n), // 0.5 ETH
    });

    const result = await analyzeDeployer(provider, TOKEN);

    expect(result.data.eth_balance).toBeCloseTo(0.5);
    expect(result.flags.find(f => f.type === 'deployer_low_balance')).toBeUndefined();
  });

  // 3.12 Both Disposable and Low Balance
  it('flags both deployer_disposable and deployer_low_balance together', async () => {
    const { analyzeDeployer } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn().mockResolvedValueOnce([
        { from: ZERO_ADDRESS, to: DEPLOYER_ADDR },
      ]),
      getTransactionCount: vi.fn().mockResolvedValue(2),
      getBalance: vi.fn().mockResolvedValue(10000000000000000n), // 0.01 ETH
    });

    const result = await analyzeDeployer(provider, TOKEN);

    expect(result.data.tx_count).toBe(2);
    expect(result.data.eth_balance).toBeCloseTo(0.01);
    const disposableFlag = result.flags.find(f => f.type === 'deployer_disposable');
    const lowBalanceFlag = result.flags.find(f => f.type === 'deployer_low_balance');
    expect(disposableFlag).toBeDefined();
    expect(lowBalanceFlag).toBeDefined();
  });

  // 3.13 getTransactionCount Throws
  it('defaults tx_count to 0 and flags deployer_disposable when getTransactionCount throws', async () => {
    const { analyzeDeployer } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn().mockResolvedValueOnce([
        { from: ZERO_ADDRESS, to: DEPLOYER_ADDR },
      ]),
      getTransactionCount: vi.fn().mockRejectedValue(new Error('RPC timeout')),
      getBalance: vi.fn().mockResolvedValue(500000000000000000n),
    });

    const result = await analyzeDeployer(provider, TOKEN);

    expect(result.data.tx_count).toBe(0);
    const disposableFlag = result.flags.find(f => f.type === 'deployer_disposable');
    expect(disposableFlag).toBeDefined();
    expect(disposableFlag!.value).toBe(0);
  });

  // 3.14 getBalance Throws
  it('defaults eth_balance to 0 and flags deployer_low_balance when getBalance throws', async () => {
    const { analyzeDeployer } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn().mockResolvedValueOnce([
        { from: ZERO_ADDRESS, to: DEPLOYER_ADDR },
      ]),
      getTransactionCount: vi.fn().mockResolvedValue(150),
      getBalance: vi.fn().mockRejectedValue(new Error('RPC timeout')),
    });

    const result = await analyzeDeployer(provider, TOKEN);

    expect(result.data.eth_balance).toBe(0);
    const lowBalanceFlag = result.flags.find(f => f.type === 'deployer_low_balance');
    expect(lowBalanceFlag).toBeDefined();
  });

  // 3.15 age_days is Always -1
  it('always sets age_days to -1 (sentinel value)', async () => {
    const { analyzeDeployer } = await import('../../src/analysis/deployer.js');

    // With deployer found
    const providerWithDeployer = createMockProvider({
      getAssetTransfers: vi.fn().mockResolvedValueOnce([
        { from: ZERO_ADDRESS, to: DEPLOYER_ADDR },
      ]),
      getTransactionCount: vi.fn().mockResolvedValue(50),
      getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
    });
    const resultWithDeployer = await analyzeDeployer(providerWithDeployer, TOKEN);
    expect(resultWithDeployer.data.age_days).toBe(-1);

    // With deployer unknown
    const providerNoDeployer = createMockProvider({
      getAssetTransfers: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    });
    const resultNoDeployer = await analyzeDeployer(providerNoDeployer, TOKEN);
    expect(resultNoDeployer.data.age_days).toBe(-1);
  });

  // 3.16 Deployer with Exactly 5 Transactions
  it('flags deployer_fresh_wallet (not deployer_disposable) at exactly 5 transactions', async () => {
    const { analyzeDeployer } = await import('../../src/analysis/deployer.js');
    const provider = createMockProvider({
      getAssetTransfers: vi.fn().mockResolvedValueOnce([
        { from: ZERO_ADDRESS, to: DEPLOYER_ADDR },
      ]),
      getTransactionCount: vi.fn().mockResolvedValue(5),
      getBalance: vi.fn().mockResolvedValue(500000000000000000n),
    });

    const result = await analyzeDeployer(provider, TOKEN);

    expect(result.data.tx_count).toBe(5);
    expect(result.flags.find(f => f.type === 'deployer_disposable')).toBeUndefined();
    const freshFlag = result.flags.find(f => f.type === 'deployer_fresh_wallet');
    expect(freshFlag).toBeDefined();
    expect(freshFlag!.severity).toBe('medium');
    expect(freshFlag!.value).toBe(5);
  });
});
