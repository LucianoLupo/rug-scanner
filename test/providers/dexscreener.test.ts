import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTokenPairs } from '../../src/providers/dexscreener.js';

const VALID_ADDRESS = '0xaabbccdd00112233aabbccdd00112233aabbccdd';

function makePair(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 'base',
    dexId: 'aerodrome',
    pairAddress: '0x1111111111111111111111111111111111111111',
    baseToken: { address: VALID_ADDRESS, name: 'TestToken', symbol: 'TT' },
    quoteToken: { address: '0x4200000000000000000000000000000000000006', name: 'WETH', symbol: 'WETH' },
    priceUsd: '0.00042',
    volume: { h24: 125000.50 },
    pairCreatedAt: 1712400000000,
    priceChange: { h24: -12.5 },
    liquidity: { usd: 50000 },
    ...overrides,
  };
}

describe('getTokenPairs', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // --- SSRF validation ---

  describe('SSRF input validation', () => {
    it('2.1 rejects path traversal', async () => {
      await expect(getTokenPairs('base', '../../../etc/passwd')).rejects.toThrow(
        'Invalid token address',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('2.2 rejects address without 0x prefix', async () => {
      await expect(
        getTokenPairs('base', 'aabbccdd00112233aabbccdd00112233aabbccdd'),
      ).rejects.toThrow('Invalid token address');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('2.3 rejects short address', async () => {
      await expect(getTokenPairs('base', '0xaabb')).rejects.toThrow(
        'Invalid token address',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('2.4 rejects non-hex characters', async () => {
      await expect(
        getTokenPairs('base', '0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'),
      ).rejects.toThrow('Invalid token address');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // --- Successful response ---

  it('2.5 returns parsed market data for matching chain pair', async () => {
    const basePair = makePair();
    const ethPair = makePair({ chainId: 'ethereum', dexId: 'uniswap' });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ pairs: [basePair, ethPair] }), { status: 200 }),
    );

    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1712443200000);

    const result = await getTokenPairs('base', VALID_ADDRESS);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const fetchUrl = fetchSpy.mock.calls[0][0];
    expect(fetchUrl).toBe(
      `https://api.dexscreener.com/latest/dex/tokens/${VALID_ADDRESS}`,
    );

    expect(result.price_usd).toBe(0.00042);
    expect(result.volume_24h).toBe(125000.50);
    expect(result.pair_age_hours).toBe(12);
    expect(result.price_change_24h_pct).toBe(-12.5);

    dateNowSpy.mockRestore();
  });

  // --- Error / edge cases ---

  it('2.6 returns all-null MarketData on non-OK HTTP response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));

    const result = await getTokenPairs('base', VALID_ADDRESS);

    expect(result).toEqual({
      price_usd: null,
      volume_24h: null,
      pair_age_hours: null,
      price_change_24h_pct: null,
    });
  });

  it('2.7 returns all-null MarketData when pairs is null', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ pairs: null }), { status: 200 }),
    );

    const result = await getTokenPairs('base', VALID_ADDRESS);

    expect(result).toEqual({
      price_usd: null,
      volume_24h: null,
      pair_age_hours: null,
      price_change_24h_pct: null,
    });
  });

  it('2.8 returns all-null MarketData when no pairs match requested chain', async () => {
    const solanaPair = makePair({ chainId: 'solana' });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ pairs: [solanaPair] }), { status: 200 }),
    );

    const result = await getTokenPairs('base', VALID_ADDRESS);

    expect(result).toEqual({
      price_usd: null,
      volume_24h: null,
      pair_age_hours: null,
      price_change_24h_pct: null,
    });
  });

  it('2.9 returns all-null MarketData when pair fields are null', async () => {
    const nullPair = makePair({
      priceUsd: null,
      volume: null,
      pairCreatedAt: null,
      priceChange: null,
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ pairs: [nullPair] }), { status: 200 }),
    );

    const result = await getTokenPairs('base', VALID_ADDRESS);

    expect(result).toEqual({
      price_usd: null,
      volume_24h: null,
      pair_age_hours: null,
      price_change_24h_pct: null,
    });
  });
});
