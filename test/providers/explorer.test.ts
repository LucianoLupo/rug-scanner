import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkSourceVerified } from '../../src/providers/explorer.js';

describe('checkSourceVerified', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const VALID_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

  describe('SSRF validation', () => {
    it('rejects non-hex address', async () => {
      await expect(
        checkSourceVerified('base', 'DROP TABLE;', 'apikey'),
      ).rejects.toThrow('Invalid token address');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects URL-encoded address', async () => {
      await expect(
        checkSourceVerified(
          'base',
          '0x%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00',
          'apikey',
        ),
      ).rejects.toThrow('Invalid token address');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('URL selection', () => {
    it('uses Basescan URL for "base" chain', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: '1', result: [{ SourceCode: 'contract {}' }] })),
      );

      await checkSourceVerified('base', VALID_ADDRESS, 'test-key');

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toMatch(/^https:\/\/api\.basescan\.org\/api\?/);
      expect(url).toContain(VALID_ADDRESS);
      expect(url).toContain('test-key');
    });

    it('uses Etherscan URL for "ethereum" chain', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: '1', result: [{ SourceCode: 'contract {}' }] })),
      );

      await checkSourceVerified('ethereum', VALID_ADDRESS, 'test-key');

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toMatch(/^https:\/\/api\.etherscan\.io\/api\?/);
    });
  });

  describe('response handling', () => {
    it('returns verified=true with no flags for verified contract', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: '1',
            result: [{ SourceCode: 'pragma solidity ^0.8.0; contract Token { }' }],
          }),
        ),
      );

      const result = await checkSourceVerified('base', VALID_ADDRESS, 'apikey');

      expect(result.verified).toBe(true);
      expect(result.flags).toEqual([]);
    });

    it('returns verified=false with unverified_source flag for unverified contract', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: '0',
            result: [{ SourceCode: '' }],
          }),
        ),
      );

      const result = await checkSourceVerified('base', VALID_ADDRESS, 'apikey');

      expect(result.verified).toBe(false);
      expect(result.flags).toHaveLength(1);
      expect(result.flags[0]).toMatchObject({
        type: 'unverified_source',
        severity: 'high',
      });
    });

    it('returns unverified with flag on non-OK HTTP response', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));

      const result = await checkSourceVerified('base', VALID_ADDRESS, 'apikey');

      expect(result.verified).toBe(false);
      expect(result.flags).toHaveLength(1);
      expect(result.flags[0].type).toBe('unverified_source');
      expect(result.flags[0].detail).toContain('500');
    });

    it('returns unverified with flag on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));

      const result = await checkSourceVerified('base', VALID_ADDRESS, 'apikey');

      expect(result.verified).toBe(false);
      expect(result.flags).toHaveLength(1);
      expect(result.flags[0].type).toBe('unverified_source');
      expect(result.flags[0].detail).toContain('Could not check source verification');
    });

    it('returns unverified with flag for empty result array', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: '1',
            result: [],
          }),
        ),
      );

      const result = await checkSourceVerified('base', VALID_ADDRESS, 'apikey');

      expect(result.verified).toBe(false);
      expect(result.flags).toHaveLength(1);
      expect(result.flags[0].type).toBe('unverified_source');
    });
  });
});
