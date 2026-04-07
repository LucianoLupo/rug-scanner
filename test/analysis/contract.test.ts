import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AlchemyProvider } from '../../src/providers/alchemy.js';
import { functionSelectors } from 'evmole';

vi.mock('evmole', () => ({
  functionSelectors: vi.fn().mockReturnValue([]),
}));

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

describe('analyzeContract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1.1 No Bytecode
  it('returns no_bytecode flag when getBytecode returns null', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    const provider = createMockProvider();

    const result = await analyzeContract(provider, TOKEN);

    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]).toMatchObject({
      severity: 'critical',
      type: 'no_bytecode',
      value: true,
    });
    expect(result.data.owner_renounced).toBe(true);
    expect(provider.getStorageAt).not.toHaveBeenCalled();
    expect(provider.call).not.toHaveBeenCalled();
    expect(functionSelectors).not.toHaveBeenCalled();
  });

  // 1.2 Clean Contract (No Dangerous Selectors)
  it('returns no flags for a clean ERC20 contract', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue(['18160ddd', '70a08231', 'dd62ed3e', 'a9059cbb']);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.flags).toHaveLength(0);
    expect(result.data.can_mint).toBe(false);
    expect(result.data.can_blacklist).toBe(false);
    expect(result.data.can_pause).toBe(false);
    expect(result.data.has_fee_setter).toBe(false);
    expect(result.data.is_proxy).toBe(false);
    expect(result.data.owner_renounced).toBe(true);
  });

  // 1.3 Mint Selector Detected
  it('detects can_mint when mint selector is present', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue(['40c10f19', '18160ddd', '70a08231']);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.can_mint).toBe(true);
    const mintFlag = result.flags.find(f => f.type === 'can_mint');
    expect(mintFlag).toBeDefined();
    expect(mintFlag!.severity).toBe('high');
  });

  // 1.4 All Selectors Present (Mint + Blacklist + Pause + Fee)
  it('detects all dangerous selectors when all are present', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue(['40c10f19', '44337ea1', '8456cb59', '69fe0e2d']);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.can_mint).toBe(true);
    expect(result.data.can_blacklist).toBe(true);
    expect(result.data.can_pause).toBe(true);
    expect(result.data.has_fee_setter).toBe(true);

    const flagTypes = result.flags.map(f => f.type);
    expect(flagTypes).toContain('can_mint');
    expect(flagTypes).toContain('can_blacklist');
    expect(flagTypes).toContain('can_pause');
    expect(flagTypes).toContain('has_fee_setter');
    expect(result.flags).toHaveLength(4);
  });

  // 1.5 Alternative Selectors (Second Variant)
  it('detects alternative selector variants for mint, blacklist, and pause', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue(['a0712d68', '0ecb93c0', '02329a29']);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.can_mint).toBe(true);
    expect(result.data.can_blacklist).toBe(true);
    expect(result.data.can_pause).toBe(true);
  });

  // 1.6 Third Mint Variant
  it('detects third mint selector variant', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue(['4e6ec247']);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.can_mint).toBe(true);
  });

  // 1.7 Third Blacklist Variant
  it('detects third blacklist selector variant', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue(['f9f92be4']);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.can_blacklist).toBe(true);
  });

  // 1.8 EIP-1967 Proxy Detected
  it('detects proxy when EIP-1967 slot has non-zero implementation address', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue([]);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
      getStorageAt: vi.fn().mockResolvedValue('0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12'),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.is_proxy).toBe(true);
    const proxyFlag = result.flags.find(f => f.type === 'is_proxy');
    expect(proxyFlag).toBeDefined();
    expect(proxyFlag!.severity).toBe('medium');
  });

  // 1.9 Proxy Slot Returns `0x`
  it('is_proxy is false when storage slot returns 0x', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue([]);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
      getStorageAt: vi.fn().mockResolvedValue('0x'),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.is_proxy).toBe(false);
    expect(result.flags.find(f => f.type === 'is_proxy')).toBeUndefined();
  });

  // 1.10 Proxy Storage Read Throws
  it('is_proxy is false when getStorageAt throws', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue([]);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
      getStorageAt: vi.fn().mockRejectedValue(new Error('RPC timeout')),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.is_proxy).toBe(false);
    expect(result.flags.find(f => f.type === 'is_proxy')).toBeUndefined();
  });

  // 1.11 Owner Not Renounced
  it('detects owner_not_renounced when owner returns non-zero address', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue([]);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
      call: vi.fn().mockResolvedValue('0x000000000000000000000000d8dA6BF26964aF9D7eEd9e03E53415D37aA96045'),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.owner_renounced).toBe(false);
    const ownerFlag = result.flags.find(f => f.type === 'owner_not_renounced');
    expect(ownerFlag).toBeDefined();
    expect(ownerFlag!.severity).toBe('low');
  });

  // 1.12 Owner Returns Zero Address (Renounced)
  it('owner_renounced is true when owner call returns zero address', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue([]);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
      call: vi.fn().mockResolvedValue(ZERO_SLOT),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.owner_renounced).toBe(true);
    expect(result.flags.find(f => f.type === 'owner_not_renounced')).toBeUndefined();
  });

  // 1.13 Owner Call Reverts
  it('treats owner_renounced as true when owner call reverts', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue([]);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
      call: vi.fn().mockRejectedValue(new Error('execution reverted')),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.owner_renounced).toBe(true);
    expect(result.flags.find(f => f.type === 'owner_not_renounced')).toBeUndefined();
  });

  // 1.14 Owner Returns `0x` (Empty Response)
  it('treats owner_renounced as true when owner call returns 0x', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue([]);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
      call: vi.fn().mockResolvedValue('0x'),
    });

    const result = await analyzeContract(provider, TOKEN);

    expect(result.data.owner_renounced).toBe(true);
    expect(result.flags.find(f => f.type === 'owner_not_renounced')).toBeUndefined();
  });

  // 1.15 Bytecode With `0x` Prefix Stripping
  it('strips 0x prefix before passing bytecode to functionSelectors', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue([]);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('0x6080604052'),
    });

    await analyzeContract(provider, TOKEN);

    expect(functionSelectors).toHaveBeenCalledWith('6080604052', 0);
  });

  // 1.16 Bytecode Without `0x` Prefix
  it('passes bytecode as-is when it has no 0x prefix', async () => {
    const { analyzeContract } = await import('../../src/analysis/contract.js');
    vi.mocked(functionSelectors).mockReturnValue([]);
    const provider = createMockProvider({
      getBytecode: vi.fn().mockResolvedValue('6080604052'),
    });

    await analyzeContract(provider, TOKEN);

    expect(functionSelectors).toHaveBeenCalledWith('6080604052', 0);
  });
});
