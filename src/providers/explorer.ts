import type { Chain, Flag } from '../types/index.js';

type EtherscanResponse = {
  status: string;
  result: Array<{ SourceCode: string }>;
};

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export async function checkSourceVerified(
  chain: Chain,
  tokenAddress: string,
  apiKey: string,
): Promise<{ verified: boolean; flags: Flag[] }> {
  if (!ADDRESS_REGEX.test(tokenAddress)) {
    throw new Error('Invalid token address');
  }

  const baseUrl = chain === 'base'
    ? 'https://api.basescan.org/api'
    : 'https://api.etherscan.io/api';

  const url = `${baseUrl}?module=contract&action=getsourcecode&address=${tokenAddress}&apikey=${apiKey}`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      return {
        verified: false,
        flags: [{
          severity: 'high' as const,
          type: 'unverified_source',
          value: true,
          detail: `Source verification check failed (HTTP ${response.status})`,
        }],
      };
    }
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
