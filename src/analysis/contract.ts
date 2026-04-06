import type { ContractData, Flag } from '../types/index.js';
import type { AlchemyProvider } from '../providers/alchemy.js';
import { functionSelectors } from 'evmole';

const MINT_SELECTORS = ['40c10f19', 'a0712d68', '4e6ec247'];
const BLACKLIST_SELECTORS = ['44337ea1', '0ecb93c0', 'f9f92be4'];
const PAUSE_SELECTORS = ['8456cb59', '02329a29'];
const FEE_SELECTORS = ['69fe0e2d'];

const OWNER_SELECTOR = '0x8da5cb5b';
const PROXY_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO_SLOT = '0x0000000000000000000000000000000000000000000000000000000000000000';

function hasAny(selectors: string[], targets: string[]): boolean {
  return selectors.some(s => targets.includes(s));
}

export async function analyzeContract(
  provider: AlchemyProvider,
  tokenAddress: string,
): Promise<{ data: ContractData; flags: Flag[] }> {
  const flags: Flag[] = [];

  const bytecode = await provider.getBytecode(tokenAddress);
  if (!bytecode) {
    return {
      data: {
        verified: false,
        can_mint: false,
        can_blacklist: false,
        can_pause: false,
        is_proxy: false,
        owner_renounced: true,
        has_fee_setter: false,
      },
      flags: [{
        severity: 'critical',
        type: 'no_bytecode',
        value: true,
        detail: 'No bytecode found at address',
      }],
    };
  }

  // Extract function selectors via evmole
  const code = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  const selectors = functionSelectors(code, 0);

  const can_mint = hasAny(selectors, MINT_SELECTORS);
  const can_blacklist = hasAny(selectors, BLACKLIST_SELECTORS);
  const can_pause = hasAny(selectors, PAUSE_SELECTORS);
  const has_fee_setter = hasAny(selectors, FEE_SELECTORS);

  if (can_mint) {
    flags.push({ severity: 'high', type: 'can_mint', value: true, detail: 'Contract has mint function' });
  }
  if (can_blacklist) {
    flags.push({ severity: 'high', type: 'can_blacklist', value: true, detail: 'Contract has blacklist function' });
  }
  if (can_pause) {
    flags.push({ severity: 'medium', type: 'can_pause', value: true, detail: 'Contract has pause function' });
  }
  if (has_fee_setter) {
    flags.push({ severity: 'high', type: 'has_fee_setter', value: true, detail: 'Contract has fee/tax setter function' });
  }

  // EIP-1967 proxy detection
  let is_proxy = false;
  try {
    const implSlot = await provider.getStorageAt(tokenAddress, PROXY_SLOT);
    is_proxy = implSlot !== ZERO_SLOT && implSlot !== '0x';
  } catch {
    // storage read failed — assume not proxy
  }
  if (is_proxy) {
    flags.push({ severity: 'medium', type: 'is_proxy', value: true, detail: 'Contract is an upgradeable proxy (EIP-1967)' });
  }

  // Ownership check via owner() selector
  let owner_renounced = true;
  try {
    const result = await provider.call(tokenAddress, OWNER_SELECTOR);
    if (result && result !== '0x' && result !== ZERO_SLOT) {
      const ownerHex = '0x' + result.slice(-40);
      if (ownerHex !== '0x0000000000000000000000000000000000000000') {
        owner_renounced = false;
      }
    }
  } catch {
    // no owner() or reverted — treat as renounced
  }
  if (!owner_renounced) {
    flags.push({ severity: 'low', type: 'owner_not_renounced', value: true, detail: 'Contract owner has not renounced ownership' });
  }

  return {
    data: {
      verified: false, // set separately by explorer check
      can_mint,
      can_blacklist,
      can_pause,
      is_proxy,
      owner_renounced,
      has_fee_setter,
    },
    flags,
  };
}
