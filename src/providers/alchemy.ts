import type { Chain } from '../types/index.js';

type JsonRpcResponse<T = unknown> = {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

type AssetTransfer = {
  from: string;
  to: string | null;
  value: number | null;
  asset: string | null;
  category: string;
  blockNum: string;
  hash: string;
};

type AssetTransfersResult = {
  transfers: AssetTransfer[];
};

type AssetTransfersParams = {
  fromBlock: string;
  toBlock: string;
  fromAddress?: string;
  toAddress?: string;
  contractAddresses?: string[];
  category: string[];
  maxCount: number;
};

export class AlchemyProvider {
  private apiKey: string;
  private chain: Chain;

  constructor(apiKey: string, chain: Chain) {
    this.apiKey = apiKey;
    this.chain = chain;
  }

  getChainUrl(): string {
    const base = this.chain === 'base'
      ? 'https://base-mainnet.g.alchemy.com/v2'
      : 'https://eth-mainnet.g.alchemy.com/v2';
    return `${base}/${this.apiKey}`;
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.getChainUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      // Mask API key from network error messages
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`RPC fetch failed: ${msg.replace(this.apiKey, '***')}`);
    }

    if (!response.ok) {
      throw new Error(`RPC HTTP error: ${response.status}`);
    }

    const json = (await response.json()) as JsonRpcResponse<T>;
    if (json.error) {
      throw new Error(`RPC error: ${json.error.message}`);
    }
    return json.result as T;
  }

  async getBytecode(address: string): Promise<string | null> {
    const result = await this.rpc<string>('eth_getCode', [address, 'latest']);
    if (!result || result === '0x') return null;
    return result;
  }

  async getStorageAt(address: string, slot: string): Promise<string> {
    return this.rpc<string>('eth_getStorageAt', [address, slot, 'latest']);
  }

  async getBalance(address: string): Promise<bigint> {
    const result = await this.rpc<string>('eth_getBalance', [address, 'latest']);
    return BigInt(result);
  }

  async getTransactionCount(address: string): Promise<number> {
    const result = await this.rpc<string>('eth_getTransactionCount', [address, 'latest']);
    return parseInt(result, 16);
  }

  async getAssetTransfers(params: AssetTransfersParams): Promise<AssetTransfer[]> {
    const rpcParams: Record<string, unknown> = {
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      category: params.category,
      maxCount: `0x${params.maxCount.toString(16)}`,
    };
    if (params.contractAddresses) rpcParams.contractAddresses = params.contractAddresses;
    if (params.fromAddress) rpcParams.fromAddress = params.fromAddress;
    if (params.toAddress) rpcParams.toAddress = params.toAddress;

    const result = await this.rpc<AssetTransfersResult>('alchemy_getAssetTransfers', [rpcParams]);
    return result.transfers;
  }

  async call(to: string, data: string): Promise<string> {
    return this.rpc<string>('eth_call', [{ to, data }, 'latest']);
  }
}
