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
  contractAddresses: string[];
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
    const response = await fetch(this.getChainUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
    });

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
    const result = await this.rpc<AssetTransfersResult>('alchemy_getAssetTransfers', [{
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      contractAddresses: params.contractAddresses,
      category: params.category,
      maxCount: `0x${params.maxCount.toString(16)}`,
    }]);
    return result.transfers;
  }

  async call(to: string, data: string): Promise<string> {
    return this.rpc<string>('eth_call', [{ to, data }, 'latest']);
  }
}
