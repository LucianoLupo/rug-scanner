import type { DeployerData, Flag } from '../types/index.js';
import type { AlchemyProvider } from '../providers/alchemy.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export async function getDeployerAddress(
  provider: AlchemyProvider,
  tokenAddress: string,
): Promise<string | null> {
  // Primary: find first ERC20 transfer from zero address (initial mint)
  try {
    const transfers = await provider.getAssetTransfers({
      fromBlock: '0x0',
      toBlock: 'latest',
      fromAddress: ZERO_ADDRESS,
      contractAddresses: [tokenAddress],
      category: ['erc20'],
      maxCount: 1,
    });
    if (transfers.length > 0 && transfers[0].to) {
      return transfers[0].to;
    }
  } catch {
    // fall through to fallback
  }

  // Fallback: first external tx TO the contract address (contract creation funding)
  try {
    const transfers = await provider.getAssetTransfers({
      fromBlock: '0x0',
      toBlock: 'latest',
      toAddress: tokenAddress,
      category: ['external'],
      maxCount: 1,
    });
    if (transfers.length > 0) {
      return transfers[0].from;
    }
  } catch {
    // could not determine deployer
  }

  return null;
}

export async function analyzeDeployer(
  provider: AlchemyProvider,
  tokenAddress: string,
): Promise<{ data: DeployerData; flags: Flag[] }> {
  const flags: Flag[] = [];

  const deployerAddress = await getDeployerAddress(provider, tokenAddress);
  if (!deployerAddress) {
    return {
      data: { age_days: -1, tx_count: 0, eth_balance: 0 },
      flags: [{
        severity: 'medium',
        type: 'deployer_unknown',
        value: true,
        detail: 'Could not determine deployer address',
      }],
    };
  }

  let tx_count = 0;
  let eth_balance = 0;

  try {
    tx_count = await provider.getTransactionCount(deployerAddress);
  } catch {
    // default 0
  }

  try {
    const balanceWei = await provider.getBalance(deployerAddress);
    eth_balance = Number(balanceWei) / 1e18;
  } catch {
    // default 0
  }

  // Cannot determine exact age without block timestamps; use -1 as sentinel
  const age_days = -1;

  if (tx_count < 5) {
    flags.push({
      severity: 'high',
      type: 'deployer_disposable',
      value: tx_count,
      detail: `Deployer has only ${tx_count} transactions — likely disposable wallet`,
    });
  } else if (tx_count < 20) {
    flags.push({
      severity: 'medium',
      type: 'deployer_fresh_wallet',
      value: tx_count,
      detail: `Deployer has only ${tx_count} transactions — relatively fresh wallet`,
    });
  }

  if (eth_balance < 0.1) {
    flags.push({
      severity: 'low',
      type: 'deployer_low_balance',
      value: eth_balance,
      detail: `Deployer balance is ${eth_balance.toFixed(4)} ETH`,
    });
  }

  return {
    data: { age_days, tx_count, eth_balance },
    flags,
  };
}
