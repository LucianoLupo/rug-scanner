import type { Chain, Flag } from '../types/index.js';

type EtherscanResponse = {
  status: string;
  result: Array<{ SourceCode: string }>;
};

export async function checkSourceVerified(
  chain: Chain,
  tokenAddress: string,
  apiKey: string,
): Promise<{ verified: boolean; flags: Flag[] }> {
  const baseUrl = chain === 'base'
    ? 'https://api.basescan.org/api'
    : 'https://api.etherscan.io/api';

  const url = `${baseUrl}?module=contract&action=getsourcecode&address=${tokenAddress}&apikey=${apiKey}`;

  try {
    const response = await fetch(url);
    const json = (await response.json()) as EtherscanResponse;

    const verified =
      json.status === '1' &&
      Array.isArray(json.result) &&
      json.result.length > 0 &&
      json.result[0].SourceCode !== '';

    const flags: Flag[] = [];
    if (!verified) {
      flags.push({
        severity: 'high',
        type: 'unverified_source',
        value: true,
        detail: 'Contract source code is not verified',
      });
    }

    return { verified, flags };
  } catch {
    return {
      verified: false,
      flags: [{
        severity: 'high',
        type: 'unverified_source',
        value: true,
        detail: 'Could not check source verification (API error)',
      }],
    };
  }
}
