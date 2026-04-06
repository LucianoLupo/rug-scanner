import type { HolderData, Flag } from '../types/index.js';
import type { AlchemyProvider } from '../providers/alchemy.js';

const BALANCE_OF_SELECTOR = '0x70a08231';
const TOTAL_SUPPLY_SELECTOR = '0x18160ddd';

function padAddress(address: string): string {
  const clean = address.startsWith('0x') ? address.slice(2) : address;
  return clean.toLowerCase().padStart(64, '0');
}

async function getBalanceOf(
  provider: AlchemyProvider,
  tokenAddress: string,
  holder: string,
): Promise<bigint> {
  try {
    const data = BALANCE_OF_SELECTOR + padAddress(holder);
    const result = await provider.call(tokenAddress, data);
    if (!result || result === '0x') return 0n;
    return BigInt(result);
  } catch {
    return 0n;
  }
}

async function getTotalSupply(
  provider: AlchemyProvider,
  tokenAddress: string,
): Promise<bigint> {
  try {
    const result = await provider.call(tokenAddress, TOTAL_SUPPLY_SELECTOR);
    if (!result || result === '0x') return 0n;
    return BigInt(result);
  } catch {
    return 0n;
  }
}

export async function analyzeHolders(
  provider: AlchemyProvider,
  tokenAddress: string,
  deployerAddress: string,
): Promise<{ data: HolderData; flags: Flag[] }> {
  const flags: Flag[] = [];

  const totalSupply = await getTotalSupply(provider, tokenAddress);
  if (totalSupply === 0n) {
    return {
      data: { total_approx: 0, top5_pct: 0, top10_pct: 0, deployer_pct: 0, method: 'transfer_scan' },
      flags: [{ severity: 'high', type: 'zero_supply', value: true, detail: 'Token total supply is zero' }],
    };
  }

  // Collect unique addresses from transfer history
  const uniqueAddresses = new Set<string>();
  try {
    const transfers = await provider.getAssetTransfers({
      fromBlock: '0x0',
      toBlock: 'latest',
      contractAddresses: [tokenAddress],
      category: ['erc20'],
      maxCount: 1000,
    });
    for (const tx of transfers) {
      if (tx.to) uniqueAddresses.add(tx.to.toLowerCase());
      if (tx.from) uniqueAddresses.add(tx.from.toLowerCase());
    }
  } catch {
    // no transfer data available
  }

  // Remove zero address — it's not a real holder
  uniqueAddresses.delete('0x0000000000000000000000000000000000000000');

  const total_approx = uniqueAddresses.size;

  // Query balances for up to 20 addresses
  const addressList = Array.from(uniqueAddresses).slice(0, 20);
  const balanceResults = await Promise.all(
    addressList.map(async (addr) => ({
      address: addr,
      balance: await getBalanceOf(provider, tokenAddress, addr),
    })),
  );

  const holders = balanceResults
    .filter(r => r.balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  // Calculate percentages (basis points → percent for precision)
  const toPct = (amount: bigint) => Number((amount * 10000n) / totalSupply) / 100;

  const top5Sum = holders.slice(0, 5).reduce((acc, h) => acc + h.balance, 0n);
  const top10Sum = holders.slice(0, 10).reduce((acc, h) => acc + h.balance, 0n);
  const top5_pct = toPct(top5Sum);
  const top10_pct = toPct(top10Sum);

  // Deployer holdings
  let deployer_pct = 0;
  if (deployerAddress) {
    const deployerBalance = await getBalanceOf(provider, tokenAddress, deployerAddress);
    deployer_pct = toPct(deployerBalance);
  }

  // Flags
  if (top5_pct > 50) {
    flags.push({
      severity: 'critical',
      type: 'top5_holders_above_50',
      value: top5_pct,
      detail: `Top 5 holders control ${top5_pct.toFixed(1)}% of supply`,
    });
  }
  if (top10_pct > 80) {
    flags.push({
      severity: 'high',
      type: 'top10_holders_above_80',
      value: top10_pct,
      detail: `Top 10 holders control ${top10_pct.toFixed(1)}% of supply`,
    });
  }
  if (deployer_pct > 50) {
    flags.push({
      severity: 'critical',
      type: 'deployer_holds_majority',
      value: deployer_pct,
      detail: `Deployer holds ${deployer_pct.toFixed(1)}% of supply`,
    });
  } else if (deployer_pct > 10) {
    flags.push({
      severity: 'high',
      type: 'deployer_holds_majority',
      value: deployer_pct,
      detail: `Deployer holds ${deployer_pct.toFixed(1)}% of supply`,
    });
  }
  if (total_approx < 100) {
    flags.push({
      severity: 'medium',
      type: 'low_holder_count',
      value: total_approx,
      detail: `Only ${total_approx} unique addresses found in transfers`,
    });
  }

  return {
    data: { total_approx, top5_pct, top10_pct, deployer_pct, method: 'transfer_scan' },
    flags,
  };
}
