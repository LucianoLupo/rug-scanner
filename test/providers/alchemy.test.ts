import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlchemyProvider } from '../../src/providers/alchemy.js';

function mockRpcResponse(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
}

function mockRpcError(code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }));
}

describe('AlchemyProvider', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function parseFetchBody(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
    const call = spy.mock.calls[0];
    const init = call[1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  describe('getChainUrl', () => {
    it('returns Base URL', () => {
      const p = new AlchemyProvider('test-key-123', 'base');
      expect(p.getChainUrl()).toBe('https://base-mainnet.g.alchemy.com/v2/test-key-123');
    });

    it('returns Ethereum URL', () => {
      const p = new AlchemyProvider('test-key-123', 'ethereum');
      expect(p.getChainUrl()).toBe('https://eth-mainnet.g.alchemy.com/v2/test-key-123');
    });
  });

  describe('getBytecode', () => {
    it('returns bytecode for contract address', async () => {
      fetchSpy.mockResolvedValueOnce(mockRpcResponse('0x6080604052'));
      const p = new AlchemyProvider('test-key', 'base');

      const result = await p.getBytecode('0xABCDEF1234567890abcdef1234567890ABCDEF12');

      expect(result).toBe('0x6080604052');
      const body = parseFetchBody(fetchSpy);
      expect(body.method).toBe('eth_getCode');
      expect(body.params).toEqual(['0xABCDEF1234567890abcdef1234567890ABCDEF12', 'latest']);
    });

    it('returns null for "0x" (EOA)', async () => {
      fetchSpy.mockResolvedValueOnce(mockRpcResponse('0x'));
      const p = new AlchemyProvider('test-key', 'base');

      const result = await p.getBytecode('0xABCDEF1234567890abcdef1234567890ABCDEF12');
      expect(result).toBeNull();
    });

    it('returns null for empty string', async () => {
      fetchSpy.mockResolvedValueOnce(mockRpcResponse(''));
      const p = new AlchemyProvider('test-key', 'base');

      const result = await p.getBytecode('0xABCDEF1234567890abcdef1234567890ABCDEF12');
      expect(result).toBeNull();
    });
  });

  describe('getStorageAt', () => {
    it('returns storage value', async () => {
      const expected = '0x0000000000000000000000000000000000000000000000000000000000000001';
      fetchSpy.mockResolvedValueOnce(mockRpcResponse(expected));
      const p = new AlchemyProvider('test-key', 'base');

      const result = await p.getStorageAt('0xAddr', '0x0');

      expect(result).toBe(expected);
      const body = parseFetchBody(fetchSpy);
      expect(body.params).toEqual(['0xAddr', '0x0', 'latest']);
    });
  });

  describe('getBalance', () => {
    it('returns BigInt from hex (1 ETH)', async () => {
      fetchSpy.mockResolvedValueOnce(mockRpcResponse('0xde0b6b3a7640000'));
      const p = new AlchemyProvider('test-key', 'base');

      const result = await p.getBalance('0xAddr');
      expect(result).toBe(1000000000000000000n);
    });

    it('returns 0n for zero balance', async () => {
      fetchSpy.mockResolvedValueOnce(mockRpcResponse('0x0'));
      const p = new AlchemyProvider('test-key', 'base');

      const result = await p.getBalance('0xAddr');
      expect(result).toBe(0n);
    });
  });

  describe('getTransactionCount', () => {
    it('parses hex to decimal', async () => {
      fetchSpy.mockResolvedValueOnce(mockRpcResponse('0x1a4'));
      const p = new AlchemyProvider('test-key', 'base');

      const result = await p.getTransactionCount('0xAddr');
      expect(result).toBe(420);
    });
  });

  describe('getAssetTransfers', () => {
    it('constructs correct params with all fields', async () => {
      const transfers = [
        { from: '0xSender', to: '0xReceiver', value: 1.5, asset: 'ETH', category: 'external', blockNum: '0x1', hash: '0xabc' },
      ];
      fetchSpy.mockResolvedValueOnce(mockRpcResponse({ transfers }));
      const p = new AlchemyProvider('test-key', 'base');

      const result = await p.getAssetTransfers({
        fromBlock: '0x0',
        toBlock: 'latest',
        category: ['external', 'erc20'],
        maxCount: 100,
        contractAddresses: ['0xToken'],
        fromAddress: '0xSender',
        toAddress: '0xReceiver',
      });

      expect(result).toEqual(transfers);

      const body = parseFetchBody(fetchSpy);
      expect(body.method).toBe('alchemy_getAssetTransfers');
      const rpcParams = (body.params as Record<string, unknown>[])[0];
      expect(rpcParams.maxCount).toBe('0x64');
      expect(rpcParams.contractAddresses).toEqual(['0xToken']);
      expect(rpcParams.fromAddress).toBe('0xSender');
      expect(rpcParams.toAddress).toBe('0xReceiver');
    });

    it('omits optional fields when not provided', async () => {
      fetchSpy.mockResolvedValueOnce(mockRpcResponse({ transfers: [] }));
      const p = new AlchemyProvider('test-key', 'base');

      await p.getAssetTransfers({
        fromBlock: '0x0',
        toBlock: 'latest',
        category: ['external'],
        maxCount: 10,
      });

      const body = parseFetchBody(fetchSpy);
      const rpcParams = (body.params as Record<string, unknown>[])[0];
      expect(rpcParams).not.toHaveProperty('contractAddresses');
      expect(rpcParams).not.toHaveProperty('fromAddress');
      expect(rpcParams).not.toHaveProperty('toAddress');
    });
  });

  describe('call', () => {
    it('sends correct eth_call params', async () => {
      fetchSpy.mockResolvedValueOnce(mockRpcResponse('0xresultdata'));
      const p = new AlchemyProvider('test-key', 'base');

      const result = await p.call('0xRouter', '0xd06ca61f');

      expect(result).toBe('0xresultdata');
      const body = parseFetchBody(fetchSpy);
      expect(body.method).toBe('eth_call');
      expect(body.params).toEqual([{ to: '0xRouter', data: '0xd06ca61f' }, 'latest']);
    });
  });

  describe('error handling', () => {
    it('throws on JSON-RPC error response', async () => {
      fetchSpy.mockResolvedValueOnce(mockRpcError(-32000, 'execution reverted'));
      const p = new AlchemyProvider('test-key', 'base');

      await expect(p.getBytecode('0xAddr')).rejects.toThrow('RPC error: execution reverted');
    });

    it('throws on non-OK HTTP status', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 429 }));
      const p = new AlchemyProvider('test-key', 'base');

      await expect(p.getBytecode('0xAddr')).rejects.toThrow('RPC HTTP error: 429');
    });

    it('masks API key in network error', async () => {
      fetchSpy.mockRejectedValueOnce(
        new Error('connect to https://base-mainnet.g.alchemy.com/v2/my-secret-key-abc123 timed out'),
      );
      const p = new AlchemyProvider('my-secret-key-abc123', 'base');

      await expect(p.getBytecode('0xAddr')).rejects.toThrow(
        'RPC fetch failed: connect to https://base-mainnet.g.alchemy.com/v2/*** timed out',
      );
    });

    it('handles non-Error thrown values', async () => {
      fetchSpy.mockRejectedValueOnce('string error');
      const p = new AlchemyProvider('test-key', 'base');

      await expect(p.getBytecode('0xAddr')).rejects.toThrow('RPC fetch failed: string error');
    });
  });
});
