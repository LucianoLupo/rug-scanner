# Analysis Modules — Unit Test Plan

**Date:** 2026-04-07
**Agent:** rug-test-analysis
**Scope:** `src/analysis/contract.ts`, `holders.ts`, `deployer.ts`, `liquidity.ts`, `scorer.ts`

## General Strategy

All analysis modules depend on `AlchemyProvider`. Unit tests mock the provider at the method level — never hit the network.

### Mock Provider Factory

Create a shared `createMockProvider()` that returns an object satisfying the `AlchemyProvider` interface with all methods stubbed via `vi.fn()`:

```ts
import { vi } from 'vitest';
import type { AlchemyProvider } from '../src/providers/alchemy.js';

export function createMockProvider(overrides: Partial<Record<keyof AlchemyProvider, any>> = {}): AlchemyProvider {
  return {
    getBytecode: vi.fn().mockResolvedValue(null),
    getStorageAt: vi.fn().mockResolvedValue('0x' + '0'.repeat(64)),
    getBalance: vi.fn().mockResolvedValue(0n),
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getAssetTransfers: vi.fn().mockResolvedValue([]),
    call: vi.fn().mockResolvedValue('0x' + '0'.repeat(64)),
    getChainUrl: vi.fn().mockReturnValue('https://mock.alchemy.com'),
    ...overrides,
  } as unknown as AlchemyProvider;
}
```

### evmole Mock

`contract.ts` imports `functionSelectors` from `evmole`. Mock the module:

```ts
vi.mock('evmole', () => ({
  functionSelectors: vi.fn().mockReturnValue([]),
}));
```

Then control return values per test with `vi.mocked(functionSelectors).mockReturnValue(...)`.

---

## 1. contract.ts — `analyzeContract`

**File:** `test/contract.test.ts`
**Import:** `analyzeContract` from `../src/analysis/contract.js`
**Mock:** `AlchemyProvider` (getBytecode, getStorageAt, call), `evmole.functionSelectors`

### 1.1 No Bytecode

**Scenario:** Contract address has no deployed code (EOA or self-destructed).
**Mock data:**
- `provider.getBytecode('0xTOKEN')` → `null`

**Expected output:**
```ts
{
  data: {
    verified: false,
    can_mint: false,
    can_blacklist: false,
    can_pause: false,
    is_proxy: false,
    owner_renounced: true,
    has_fee_setter: false,
  },
  flags: [{ severity: 'critical', type: 'no_bytecode', value: true, detail: 'No bytecode found at address' }],
}
```

**Assertions:**
- `getStorageAt` and `call` are never called (early return before proxy/owner checks)
- `evmole.functionSelectors` is never called

### 1.2 Clean Contract (No Dangerous Selectors)

**Scenario:** Contract with bytecode but no mint, blacklist, pause, or fee selectors. Owner renounced, not a proxy.
**Mock data:**
- `provider.getBytecode('0xTOKEN')` → `'0x6080604052...'` (any non-null hex)
- `functionSelectors(...)` → `['18160ddd', '70a08231', 'dd62ed3e', 'a9059cbb']` (totalSupply, balanceOf, allowance, transfer — standard ERC20 only)
- `provider.getStorageAt(tokenAddress, PROXY_SLOT)` → `'0x' + '0'.repeat(64)` (ZERO_SLOT)
- `provider.call(tokenAddress, '0x8da5cb5b')` → `'0x' + '0'.repeat(64)` (owner is zero address)

**Expected output:**
```ts
{
  data: { verified: false, can_mint: false, can_blacklist: false, can_pause: false, is_proxy: false, owner_renounced: true, has_fee_setter: false },
  flags: [], // no flags
}
```

### 1.3 Mint Selector Detected

**Scenario:** Bytecode contains `mint(address,uint256)` selector.
**Mock data:**
- `functionSelectors(...)` → `['40c10f19', '18160ddd', '70a08231']`
  - `40c10f19` = `mint(address,uint256)`
- Proxy slot → ZERO_SLOT, owner → zero address

**Expected output:**
- `data.can_mint === true`
- Flags include `{ severity: 'high', type: 'can_mint', value: true }`
- No other dangerous flags

### 1.4 All Selectors Present (Mint + Blacklist + Pause + Fee)

**Scenario:** Contract has every dangerous selector. Tests that each one produces its own flag independently.
**Mock data:**
- `functionSelectors(...)` → `['40c10f19', '44337ea1', '8456cb59', '69fe0e2d']`
  - `40c10f19` = mint
  - `44337ea1` = blacklist
  - `8456cb59` = pause
  - `69fe0e2d` = setFee

**Expected output:**
- `data.can_mint === true`, `data.can_blacklist === true`, `data.can_pause === true`, `data.has_fee_setter === true`
- 4 flags: `can_mint` (high), `can_blacklist` (high), `can_pause` (medium), `has_fee_setter` (high)

### 1.5 Alternative Selectors (Second Variant)

**Scenario:** Tests alternative selector variants (e.g., `a0712d68` for mint, `0ecb93c0` for blacklist).
**Mock data:**
- `functionSelectors(...)` → `['a0712d68', '0ecb93c0', '02329a29']`
  - `a0712d68` = `mint(uint256)` (alternative mint)
  - `0ecb93c0` = alternative blacklist
  - `02329a29` = alternative pause

**Expected output:**
- `data.can_mint === true`, `data.can_blacklist === true`, `data.can_pause === true`

### 1.6 Third Mint Variant

**Scenario:** Tests `4e6ec247` (third mint variant).
**Mock data:**
- `functionSelectors(...)` → `['4e6ec247']`

**Expected:** `data.can_mint === true`, flag `can_mint` present.

### 1.7 Third Blacklist Variant

**Scenario:** Tests `f9f92be4`.
**Mock data:**
- `functionSelectors(...)` → `['f9f92be4']`

**Expected:** `data.can_blacklist === true`, flag `can_blacklist` present.

### 1.8 EIP-1967 Proxy Detected

**Scenario:** Storage slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` contains a non-zero implementation address.
**Mock data:**
- `provider.getStorageAt(tokenAddress, PROXY_SLOT)` → `'0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12'`

**Expected output:**
- `data.is_proxy === true`
- Flag: `{ severity: 'medium', type: 'is_proxy', value: true, detail: 'Contract is an upgradeable proxy (EIP-1967)' }`

### 1.9 Proxy Slot Returns `0x` (Not Zero Slot, But Empty)

**Scenario:** Some providers return `'0x'` instead of the full zero slot.
**Mock data:**
- `provider.getStorageAt(...)` → `'0x'`

**Expected:** `data.is_proxy === false` (the code checks `implSlot !== ZERO_SLOT && implSlot !== '0x'`)

### 1.10 Proxy Storage Read Throws

**Scenario:** `getStorageAt` throws an error (RPC failure).
**Mock data:**
- `provider.getStorageAt(...)` → throws `Error('RPC timeout')`

**Expected:** `data.is_proxy === false` (caught, assumed not proxy), no `is_proxy` flag.

### 1.11 Owner Not Renounced

**Scenario:** `owner()` returns a non-zero address.
**Mock data:**
- `provider.call(tokenAddress, '0x8da5cb5b')` → `'0x000000000000000000000000d8dA6BF26964aF9D7eEd9e03E53415D37aA96045'`

**Expected output:**
- `data.owner_renounced === false`
- Flag: `{ severity: 'low', type: 'owner_not_renounced', value: true }`

### 1.12 Owner Returns Zero Address (Renounced)

**Mock data:**
- `provider.call(tokenAddress, '0x8da5cb5b')` → `'0x' + '0'.repeat(64)`

**Expected:** `data.owner_renounced === true`, no `owner_not_renounced` flag.

### 1.13 Owner Call Reverts

**Scenario:** Contract has no `owner()` function; call reverts.
**Mock data:**
- `provider.call(tokenAddress, '0x8da5cb5b')` → throws `Error('execution reverted')`

**Expected:** `data.owner_renounced === true` (catch treats revert as renounced).

### 1.14 Owner Returns `0x` (Empty Response)

**Mock data:**
- `provider.call(...)` → `'0x'`

**Expected:** `data.owner_renounced === true` (handled by `result !== '0x'` guard).

### 1.15 Bytecode With `0x` Prefix Stripping

**Scenario:** Tests that bytecode `0x` prefix is correctly stripped before passing to `functionSelectors`.
**Mock data:**
- `provider.getBytecode(...)` → `'0x6080604052'`

**Assertions:**
- `functionSelectors` is called with `'6080604052'` (no `0x` prefix) and `0`

### 1.16 Bytecode Without `0x` Prefix

**Mock data:**
- `provider.getBytecode(...)` → `'6080604052'` (already no prefix)

**Assertions:**
- `functionSelectors` is called with `'6080604052'` and `0`

---

## 2. holders.ts — `analyzeHolders`

**File:** `test/holders.test.ts`
**Import:** `analyzeHolders` from `../src/analysis/holders.js`
**Mock:** `AlchemyProvider` (call for balanceOf/totalSupply, getAssetTransfers)

### Helper: Mock balanceOf and totalSupply

The module uses `provider.call(tokenAddress, data)` where:
- `data = '0x18160ddd'` → totalSupply
- `data = '0x70a08231' + padAddress(holder)` → balanceOf(holder)

Build a mock that switches on the `data` argument:

```ts
const balances: Record<string, bigint> = {
  '0xholder1': 5000n * 10n**18n,
  '0xholder2': 3000n * 10n**18n,
  // ...
};
const totalSupply = 10000n * 10n**18n;

provider.call = vi.fn().mockImplementation(async (to: string, data: string) => {
  if (data === '0x18160ddd') {
    return '0x' + totalSupply.toString(16).padStart(64, '0');
  }
  if (data.startsWith('0x70a08231')) {
    const addr = '0x' + data.slice(-40);
    const bal = balances[addr.toLowerCase()] ?? 0n;
    return '0x' + bal.toString(16).padStart(64, '0');
  }
  return '0x' + '0'.repeat(64);
});
```

### 2.1 Zero Total Supply

**Scenario:** Token has 0 totalSupply (brand-new or broken token).
**Mock data:**
- `provider.call(tokenAddress, '0x18160ddd')` → `'0x' + '0'.repeat(64)` (0)

**Expected output:**
```ts
{
  data: { total_approx: 0, top5_pct: 0, top10_pct: 0, deployer_pct: 0, method: 'transfer_scan' },
  flags: [{ severity: 'high', type: 'zero_supply', value: true, detail: 'Token total supply is zero' }],
}
```

**Assertions:**
- `getAssetTransfers` is never called (early return)
- No `balanceOf` calls

### 2.2 Normal Distribution (No Flags)

**Scenario:** 200 unique holders, top 5 hold 30%, top 10 hold 45%, deployer holds 2%.
**Mock data:**
- `totalSupply` = `1_000_000n * 10n**18n` (1M tokens)
- `getAssetTransfers` returns 200 unique `to` addresses (+ some `from`)
- Balances for first 20 queried addresses: distributed so top 5 sum = 300,000 tokens, top 10 sum = 450,000
- `deployerAddress` holds 20,000 tokens

**Expected output:**
- `data.total_approx` ≥ 200 (unique addresses minus zero address)
- `data.top5_pct` ≈ 30.0
- `data.top10_pct` ≈ 45.0
- `data.deployer_pct` ≈ 2.0
- `flags` = [] (no concentration flags, holder count > 100)

### 2.3 Top 5 Hold >50% (Critical)

**Scenario:** Highly concentrated token.
**Mock data:**
- `totalSupply` = `100_000n * 10n**18n`
- 5 holders with balance summing to 60,000 tokens
- Remaining 15 holders: small balances

**Expected flags:**
- `{ severity: 'critical', type: 'top5_holders_above_50', value: 60.0 }`

### 2.4 Top 10 Hold >80% (High)

**Scenario:** Moderate top-5 (40%) but top-10 at 85%.
**Mock data:**
- `totalSupply` = `100_000n * 10n**18n`
- Top 5 sum = 40,000 tokens
- Top 10 sum = 85,000 tokens

**Expected flags:**
- `{ severity: 'high', type: 'top10_holders_above_80', value: 85.0 }`
- No `top5_holders_above_50` flag

### 2.5 Deployer Holds >50% (Critical)

**Mock data:**
- `totalSupply` = `100_000n * 10n**18n`
- `deployerAddress` balance = 60,000 tokens

**Expected flags:**
- `{ severity: 'critical', type: 'deployer_holds_majority', value: 60.0 }`

### 2.6 Deployer Holds 10-50% (High)

**Mock data:**
- `totalSupply` = `100_000n * 10n**18n`
- `deployerAddress` balance = 25,000 tokens

**Expected flags:**
- `{ severity: 'high', type: 'deployer_holds_majority', value: 25.0 }`

### 2.7 Deployer Holds <10% (No Deployer Flag)

**Mock data:**
- `deployerAddress` balance = 5,000 out of 100,000 total

**Expected:** No `deployer_holds_majority` flag.

### 2.8 Low Holder Count (<100)

**Scenario:** Only 50 unique addresses in transfer history.
**Mock data:**
- `getAssetTransfers` returns 50 unique addresses

**Expected flags:**
- `{ severity: 'medium', type: 'low_holder_count', value: 50 }`

### 2.9 Empty Transfer History

**Scenario:** `getAssetTransfers` returns empty array.
**Mock data:**
- `getAssetTransfers(...)` → `[]`
- `totalSupply` > 0

**Expected:**
- `data.total_approx` = 0
- Flag: `low_holder_count` with value 0
- `top5_pct` = 0, `top10_pct` = 0 (no balances to query)

### 2.10 Transfer History Throws

**Scenario:** `getAssetTransfers` rejects (API error).
**Mock data:**
- `getAssetTransfers(...)` → throws `Error('rate limited')`
- `totalSupply` > 0

**Expected:** Same as 2.9 — caught gracefully, `total_approx` = 0, `low_holder_count` flag.

### 2.11 Zero Address Filtered Out

**Scenario:** Transfer events include the zero address (burn/mint). Verify it's removed from holder set.
**Mock data:**
- `getAssetTransfers` returns transfers with `from: '0x0000...0000'` and `to: '0xHolder1'`

**Expected:**
- Zero address is NOT in the queried set
- `total_approx` counts only non-zero addresses

### 2.12 Deployer Address Empty String

**Scenario:** `deployerAddress` passed as `''` (empty string).
**Mock data:**
- `deployerAddress = ''`

**Expected:** `deployer_pct` = 0 (the `if (deployerAddress)` guard prevents the balanceOf call).

### 2.13 All Balances Zero

**Scenario:** 20 addresses from transfers, but all `balanceOf` calls return 0 (tokens were transferred away).
**Mock data:**
- All balanceOf → `'0x' + '0'.repeat(64)`

**Expected:**
- `top5_pct` = 0, `top10_pct` = 0
- No concentration flags

### 2.14 BalanceOf Call Fails for Some Holders

**Scenario:** Some `provider.call` calls throw (e.g., revert for specific address). Tests the try/catch inside `getBalanceOf`.
**Mock data:**
- First 10 addresses: return valid balances
- Next 10 addresses: throw Error

**Expected:** Only the successful balances are included; no crash.

### 2.15 More Than 20 Unique Addresses

**Scenario:** 500 unique addresses in transfer history. Only first 20 are queried for balances.
**Mock data:**
- `getAssetTransfers` returns 500 unique addresses

**Assertions:**
- `provider.call` is called exactly 20 times for balanceOf (plus 1 for totalSupply, plus 1 for deployer)
- `data.total_approx` = 500 (or close, minus zero address)

### 2.16 Percentage Calculation Precision

**Scenario:** Tests that basis-point math is correct.
**Mock data:**
- `totalSupply` = `3n` (3 wei)
- One holder has balance `1n`

**Expected:**
- `top5_pct` ≈ 33.33 (verifies `Number((1n * 10000n) / 3n) / 100` = 33.33)

---

## 3. deployer.ts — `getDeployerAddress` + `analyzeDeployer`

**File:** `test/deployer.test.ts`
**Import:** `getDeployerAddress`, `analyzeDeployer` from `../src/analysis/deployer.js`
**Mock:** `AlchemyProvider` (getAssetTransfers, getTransactionCount, getBalance)

### 3.1 Deployer Found via ERC20 Mint (Primary Method)

**Scenario:** First transfer from zero address found.
**Mock data:**
- `getAssetTransfers({ fromAddress: ZERO_ADDRESS, contractAddresses: [token], category: ['erc20'], maxCount: 1 })` → `[{ from: '0x0000...0000', to: '0xDeployer123...', ... }]`

**Expected:** Returns `'0xDeployer123...'`.

### 3.2 Deployer Found via External TX Fallback

**Scenario:** No ERC20 mint from zero address. Falls back to first external tx to the contract.
**Mock data:**
- First `getAssetTransfers` (erc20 from zero) → `[]`
- Second `getAssetTransfers` (external to contract) → `[{ from: '0xFunder456...', to: tokenAddress, ... }]`

**Expected:** Returns `'0xFunder456...'`.

### 3.3 Deployer Not Found (Both Methods Fail)

**Mock data:**
- Both `getAssetTransfers` calls → `[]`

**Expected:** Returns `null`.

### 3.4 Primary Method Throws, Fallback Succeeds

**Mock data:**
- First `getAssetTransfers` → throws `Error('rate limited')`
- Second `getAssetTransfers` → `[{ from: '0xFallback...', ... }]`

**Expected:** Returns `'0xFallback...'`.

### 3.5 Both Methods Throw

**Mock data:**
- Both `getAssetTransfers` → throw

**Expected:** Returns `null`.

### 3.6 analyzeDeployer — Deployer Unknown

**Scenario:** `getDeployerAddress` returns null.
**Mock data:**
- Both `getAssetTransfers` calls return `[]`

**Expected:**
```ts
{
  data: { age_days: -1, tx_count: 0, eth_balance: 0 },
  flags: [{ severity: 'medium', type: 'deployer_unknown', value: true }],
}
```

**Assertions:**
- `getTransactionCount` and `getBalance` are never called.

### 3.7 Disposable Wallet (tx_count < 5)

**Mock data:**
- Deployer found: `'0xDeployer...'`
- `getTransactionCount('0xDeployer...')` → `3`
- `getBalance('0xDeployer...')` → `500000000000000000n` (0.5 ETH)

**Expected:**
- `data.tx_count` = 3
- `data.eth_balance` ≈ 0.5
- `data.age_days` = -1 (sentinel)
- Flag: `{ severity: 'high', type: 'deployer_disposable', value: 3 }`

### 3.8 Fresh Wallet (5 ≤ tx_count < 20)

**Mock data:**
- `getTransactionCount(...)` → `12`
- `getBalance(...)` → `1000000000000000000n` (1 ETH)

**Expected:**
- Flag: `{ severity: 'medium', type: 'deployer_fresh_wallet', value: 12 }`
- No `deployer_disposable` flag

### 3.9 Established Wallet (tx_count ≥ 20)

**Mock data:**
- `getTransactionCount(...)` → `150`
- `getBalance(...)` → `5000000000000000000n` (5 ETH)

**Expected:**
- No `deployer_disposable` or `deployer_fresh_wallet` flag

### 3.10 Low ETH Balance (< 0.1 ETH)

**Mock data:**
- `getTransactionCount(...)` → `50` (established)
- `getBalance(...)` → `50000000000000000n` (0.05 ETH)

**Expected:**
- Flag: `{ severity: 'low', type: 'deployer_low_balance', value: 0.05 }`

### 3.11 Exact Boundary: tx_count = 5

**Mock data:**
- `getTransactionCount(...)` → `5`

**Expected:** Flag is `deployer_fresh_wallet` (medium), NOT `deployer_disposable` (high). Tests the `< 5` boundary.

### 3.12 Exact Boundary: tx_count = 20

**Mock data:**
- `getTransactionCount(...)` → `20`

**Expected:** No tx-count-related flag. Tests the `< 20` boundary.

### 3.13 Exact Boundary: eth_balance = 0.1

**Mock data:**
- `getBalance(...)` → `100000000000000000n` (exactly 0.1 ETH)

**Expected:** No `deployer_low_balance` flag. Tests the `< 0.1` boundary.

### 3.14 getTransactionCount Throws

**Mock data:**
- `getTransactionCount(...)` → throws

**Expected:** `data.tx_count` = 0, flag `deployer_disposable` triggered (since 0 < 5).

### 3.15 getBalance Throws

**Mock data:**
- `getBalance(...)` → throws

**Expected:** `data.eth_balance` = 0, flag `deployer_low_balance` triggered (since 0 < 0.1).

### 3.16 Contract Deployed by Another Contract

**Scenario:** The "deployer" is itself a contract (factory deployment). The first ERC20 mint from zero goes to a contract address, not an EOA.
**Mock data:**
- First transfer from zero address → `to: '0xFactoryContract...'`

**Expected:** Returns the factory contract address. `analyzeDeployer` will then check its tx count and balance normally. The tx count may be very high (factory), and balance may be 0 (contract doesn't hold ETH).

---

## 4. liquidity.ts — `analyzeLiquidity`

**File:** `test/liquidity.test.ts`
**Import:** `analyzeLiquidity` from `../src/analysis/liquidity.js`
**Mock:** `AlchemyProvider` (call), `global.fetch` (for ETH price)

### Mock Strategy

`analyzeLiquidity` calls `provider.call(address, data)` for multiple contracts (factories, pools, lock contracts). The mock must route based on the `address` argument:

```ts
const callRoutes: Record<string, Record<string, string>> = {
  [UNISWAP_V2_FACTORY]: {
    // getPair(token, WETH) → pool address
    ['0xe6a43905' + padAddress(token) + padAddress(WETH_BASE)]: 
      '0x000000000000000000000000' + 'aabb'.repeat(5),
  },
  [poolAddress]: {
    // token0()
    '0x0dfe1681': '0x000000000000000000000000' + token.slice(2).padStart(40, '0'),
    // getReserves() → reserve0, reserve1, blockTimestampLast
    '0x0902f1ac': encodeReserves(1000n * 10n**18n, 5n * 10n**18n),
  },
  // ...lock contracts
};

provider.call = vi.fn().mockImplementation(async (to: string, data: string) => {
  const route = callRoutes[to.toLowerCase()]?.[data.toLowerCase()];
  if (route) return route;
  return '0x' + '0'.repeat(64); // zero = not found
});
```

### Mock ETH Price

```ts
vi.spyOn(globalThis, 'fetch').mockResolvedValue(
  new Response(JSON.stringify({
    pairs: [{ priceUsd: '3500.00' }],
  }), { status: 200 }),
);
```

### 4.1 No Liquidity Pool Found

**Scenario:** All factory calls return zero address.
**Mock data:**
- All `provider.call(factory, getPair/getPool data)` → zero-padded zero address

**Expected:**
```ts
{
  data: { total_usd: 0, lp_locked: false, lock_provider: null, pool_age_hours: 0, dex: 'none' },
  flags: [{ severity: 'critical', type: 'no_liquidity_pool', value: true }],
}
```

### 4.2 Uniswap V2 Pool Found (Ethereum)

**Scenario:** getPair returns a valid pool address.
**Mock data:**
- `chain: 'ethereum'`
- `getPair(token, WETH_ETH)` → `'0xPoolV2...'`
- `token0()` → token address (so token is token0)
- `getReserves()` → reserve0 = 500,000 tokens (18 decimals), reserve1 = 10 WETH (18 decimals)
- ETH price = $3,500
- `balanceOf(UNCX)` on pool = 0, `balanceOf(Team Finance)` on pool = 0

**Expected:**
- `data.dex` = `'uniswap_v2'`
- `data.total_usd` = 10 * 3500 * 2 = $70,000 (WETH side doubled, no market data)
- `data.lp_locked` = false
- Flags: `lp_unlocked` (high, since $70k > $10k)

### 4.3 Uniswap V2 Pool With Market Data

**Scenario:** Same as 4.2 but `marketData.price_usd` is provided.
**Mock data:**
- Same pool setup
- `marketData = { price_usd: 0.05 }`
- Token decimals: `provider.call(tokenAddress, '0x313ce567')` → `18`
- reserve0 = 500,000 tokens, reserve1 = 10 WETH

**Expected:**
- Token side USD = 500,000 * 0.05 = $25,000
- WETH side USD = 10 * 3500 = $35,000
- `data.total_usd` = $60,000

### 4.4 Uniswap V3 Pool Found (First Fee Tier)

**Scenario:** V2 factory returns zero, V3 factory returns a pool at 500 fee tier.
**Mock data:**
- V2 getPair → zero address
- V3 getPool(token, WETH, fee=500) → `'0xPoolV3...'`

**Expected:**
- `data.dex` = `'uniswap_v3'`
- `data.total_usd` = 0 (V3 reserves not estimated — code says "skip reserve estimation for now")
- Pool is found → no `no_liquidity_pool` flag

### 4.5 Uniswap V3 Pool Found at 3000 Fee Tier (Not 500)

**Mock data:**
- V3 getPool(fee=500) → zero
- V3 getPool(fee=3000) → valid pool
- V3 getPool(fee=10000) → should NOT be called (breaks after first found)

**Assertions:**
- `provider.call` is NOT called for fee=10000

### 4.6 Aerodrome Pool Found (Base Only)

**Scenario:** Base chain, V2 and V3 return nothing, Aerodrome factory returns pool.
**Mock data:**
- `chain: 'base'`
- V2 getPair → zero
- V3 getPool (all fees) → zero
- Aerodrome getPool(token, WETH, stable=false) → `'0xAeroPool...'`
- Pool has reserves

**Expected:**
- `data.dex` = `'aerodrome'`
- Pool type is 'v2', so reserves are queried via getReserves()

### 4.7 Aerodrome NOT Queried on Ethereum

**Scenario:** Chain is Ethereum. Aerodrome factory should not be called.
**Mock data:**
- `chain: 'ethereum'`

**Assertions:**
- No call to Aerodrome factory address `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`

### 4.8 LP Locked via UNCX

**Mock data:**
- Pool found (any DEX)
- `balanceOf(UNCX_address)` on pool → `1000000n` (non-zero)

**Expected:**
- `data.lp_locked` = true
- `data.lock_provider` = `'UNCX'`
- No `lp_unlocked` flag

### 4.9 LP Locked via Team Finance

**Mock data:**
- `balanceOf(UNCX)` → 0
- `balanceOf(Team Finance)` → non-zero

**Expected:**
- `data.lp_locked` = true
- `data.lock_provider` = `'Team Finance'`

### 4.10 LP Unlocked, High Liquidity (>$10k)

**Mock data:**
- Both lock contract balances → 0
- `total_usd` = $50,000

**Expected flags:**
- `{ severity: 'high', type: 'lp_unlocked', value: true }`
- NO `lp_unlocked_low_liquidity` flag

### 4.11 LP Unlocked, Low Liquidity (<$10k)

**Mock data:**
- Both lock contract balances → 0
- WETH reserve = 1 WETH, ETH price = $3500 → total_usd = $7,000

**Expected flags:**
- `{ severity: 'critical', type: 'lp_unlocked_low_liquidity', value: 7000 }`
- `{ severity: 'medium', type: 'low_liquidity', value: 7000 }`

### 4.12 LP Locked BUT Low Liquidity

**Mock data:**
- UNCX balance > 0 (locked)
- WETH reserve = 0.5 WETH → total_usd ≈ $1,750

**Expected flags:**
- `{ severity: 'medium', type: 'low_liquidity', value: 1750 }`
- No `lp_unlocked` flags (LP is locked)

### 4.13 ETH Price Fetch Fails

**Scenario:** DexScreener API returns error. Tests fallback to $3,000.
**Mock data:**
- `globalThis.fetch` for DexScreener → `new Response('', { status: 500 })`

**Expected:**
- ETH price fallback = $3,000 (used in WETH→USD conversion)

### 4.14 ETH Price Fetch Throws (Network Error)

**Mock data:**
- `globalThis.fetch` → throws `Error('network error')`

**Expected:** Fallback $3,000 used.

### 4.15 ETH Price Response Missing `pairs`

**Mock data:**
- `globalThis.fetch` → `Response(JSON.stringify({ pairs: null }))`

**Expected:** Fallback $3,000 used.

### 4.16 ETH Price Response Missing `priceUsd`

**Mock data:**
- `globalThis.fetch` → `Response(JSON.stringify({ pairs: [{ priceUsd: null }] }))`

**Expected:** Fallback $3,000 used.

### 4.17 Token is token1 (Not token0)

**Scenario:** In the V2 pool, the token is token1 (WETH is token0). Tests reserve order logic.
**Mock data:**
- `token0()` returns WETH address (not the token)
- `getReserves()` → reserve0 = 10 WETH, reserve1 = 500,000 tokens

**Expected:**
- `tokenReserve` = reserve1, `wethReserve` = reserve0 (swapped)
- USD calculation uses correct reserves

### 4.18 V2 getReserves Throws

**Mock data:**
- Pool found, but `getReserves()` call throws

**Expected:**
- `total_usd` = 0 (caught, left at default)
- LP lock still checked

### 4.19 Lock Contract balanceOf Throws

**Mock data:**
- `balanceOf(UNCX)` → throws, `balanceOf(Team Finance)` → throws

**Expected:** `lp_locked` = false (each caught individually).

### 4.20 Multiple Pools Found (Priority)

**Scenario:** Both V2 and V3 pools exist. Tests that the first found (V2) is used as `primary`.
**Mock data:**
- V2 getPair → valid pool
- V3 getPool → valid pool

**Expected:**
- `data.dex` = `'uniswap_v2'` (first in the `pools` array)
- Reserves are queried for V2 pool

### 4.21 Token Decimals != 18

**Scenario:** Token has 6 decimals (like USDC). Tests that `getTokenDecimals` is called and used.
**Mock data:**
- `provider.call(tokenAddress, '0x313ce567')` → `'0x' + (6).toString(16).padStart(64, '0')`
- `marketData.price_usd` = 1.0 (stablecoin)
- `tokenReserve` = 500_000n * 10n**6n

**Expected:**
- Token value = 500_000 * 1.0 = $500,000 (correctly divides by 10^6, not 10^18)

### 4.22 Token Decimals Call Fails

**Mock data:**
- `provider.call(tokenAddress, '0x313ce567')` → throws

**Expected:** Falls back to 18 decimals.

---

## 5. scorer.ts — `getVerdict` + `calculateConfidence`

**File:** Already in `test/edge-cases.test.ts`, `test/known-rugs.test.ts`, `test/known-safe.test.ts`

### Existing Coverage (Verified Complete)

| Verdict Path | Covered In | Test Name |
|---|---|---|
| `honeypot_cant_sell` → CRITICAL | known-rugs | "honeypot (cant sell) → CRITICAL" |
| `deployer_holds_majority + lp_unlocked` → CRITICAL | known-rugs | "deployer holds majority + LP unlocked → CRITICAL" |
| `no_liquidity_pool` → CRITICAL | known-rugs | "no liquidity pool → CRITICAL" |
| `lp_unlocked_low_liquidity` → CRITICAL | known-rugs | "LP unlocked + low liquidity (combined flag) → CRITICAL" |
| `deployer_holds_majority` (alone) → HIGH_RISK | known-rugs | "deployer holds majority (no LP flag) → HIGH_RISK" |
| `lp_unlocked + low_liquidity` → HIGH_RISK | known-rugs | "LP unlocked + low liquidity (separate flags) → HIGH_RISK" |
| `can_mint + can_blacklist` → HIGH_RISK | known-rugs | "can mint + can blacklist → HIGH_RISK" |
| `asymmetric_tax` → HIGH_RISK | known-rugs | "asymmetric tax → HIGH_RISK" |
| `high_sell_tax` → HIGH_RISK | known-rugs | "high sell tax → HIGH_RISK" |
| `unverified_source + is_proxy` → MEDIUM_RISK | edge-cases | "proxy + unverified → MEDIUM_RISK" |
| `top5_holders_above_50` → MEDIUM_RISK | **MISSING** | — |
| 2+ high/critical flags → MEDIUM_RISK | known-rugs | "multiple high severity flags → MEDIUM_RISK" |
| ≥3 flags → MEDIUM_RISK | edge-cases | "exactly 3 flags → MEDIUM_RISK" |
| ≥1 flag → LOW_RISK | edge-cases | "2 flags, none high → LOW_RISK" |
| 0 flags → SAFE | edge-cases, known-safe | multiple tests |
| `calculateConfidence` 0/0 | edge-cases | ✓ |
| `calculateConfidence` n/n | edge-cases | ✓ |
| `calculateConfidence` partial | edge-cases | ✓ |
| `calculateConfidence` clamp above 1 | edge-cases | ✓ |
| `calculateConfidence` clamp below 0 | edge-cases | ✓ |
| `calculateConfidence` negative total | edge-cases | ✓ |

### 5.1 Missing Test: `top5_holders_above_50` → MEDIUM_RISK

**Add to `edge-cases.test.ts`:**

```ts
it('top5_holders_above_50 → MEDIUM_RISK', () => {
  const flags: Flag[] = [flag('top5_holders_above_50', 'critical')];
  const result = getVerdict(flags);
  expect(result.verdict).toBe('MEDIUM_RISK');
  expect(result.score).toBe(1);
});
```

### 5.2 Recommended Additional Scorer Tests

These test priority ordering (earlier rules should take precedence):

**a) honeypot_cant_sell overrides everything:**
```ts
it('honeypot + other flags → still CRITICAL (priority)', () => {
  const flags: Flag[] = [
    flag('honeypot_cant_sell', 'critical'),
    flag('can_mint', 'high'),
    flag('can_blacklist', 'high'),
    flag('lp_unlocked', 'high'),
  ];
  expect(getVerdict(flags).verdict).toBe('CRITICAL');
});
```

**b) deployer_holds_majority + lp_unlocked beats standalone deployer_holds_majority:**
```ts
it('deployer_majority + lp_unlocked → CRITICAL, not just HIGH_RISK', () => {
  const flags: Flag[] = [
    flag('deployer_holds_majority', 'critical'),
    flag('lp_unlocked', 'high'),
    flag('can_mint', 'high'), // extra noise
  ];
  expect(getVerdict(flags).verdict).toBe('CRITICAL');
});
```

**c) can_mint alone (without can_blacklist) → not HIGH_RISK from that rule:**
```ts
it('can_mint alone → not HIGH_RISK via mint+blacklist rule', () => {
  const flags: Flag[] = [flag('can_mint', 'high')];
  const result = getVerdict(flags);
  // 1 flag, not matching any CRITICAL/HIGH_RISK combo → LOW_RISK
  expect(result.verdict).toBe('LOW_RISK');
});
```

**d) Score equals flag count:**
```ts
it('score equals number of flags', () => {
  const flags: Flag[] = [
    flag('deployer_low_balance', 'low'),
    flag('owner_not_renounced', 'low'),
    flag('can_pause', 'medium'),
    flag('deployer_fresh_wallet', 'medium'),
  ];
  expect(getVerdict(flags).score).toBe(4);
});
```

---

## Test File Structure

```
test/
├── helpers/
│   └── mock-provider.ts     # createMockProvider() + helper utilities
├── contract.test.ts          # 16 tests (§1.1–1.16)
├── holders.test.ts           # 16 tests (§2.1–2.16)
├── deployer.test.ts          # 16 tests (§3.1–3.16)
├── liquidity.test.ts         # 22 tests (§4.1–4.22)
├── edge-cases.test.ts        # existing + 1 new (§5.1)
├── known-rugs.test.ts        # existing + 4 new (§5.2a–d)
├── known-safe.test.ts        # existing (no changes)
└── PLAN-analysis.md          # this file
```

**Total new tests: 74** (16 + 16 + 16 + 22 + 4 new scorer tests)

---

## Selector Reference

For mock bytecode construction:

| Function | Selector | Used In |
|---|---|---|
| `mint(address,uint256)` | `40c10f19` | contract.ts MINT_SELECTORS |
| `mint(uint256)` | `a0712d68` | contract.ts MINT_SELECTORS |
| (third mint variant) | `4e6ec247` | contract.ts MINT_SELECTORS |
| `addToBlacklist(address)` | `44337ea1` | contract.ts BLACKLIST_SELECTORS |
| (blacklist variant 2) | `0ecb93c0` | contract.ts BLACKLIST_SELECTORS |
| (blacklist variant 3) | `f9f92be4` | contract.ts BLACKLIST_SELECTORS |
| `pause()` | `8456cb59` | contract.ts PAUSE_SELECTORS |
| `pause(bool)` | `02329a29` | contract.ts PAUSE_SELECTORS |
| `setFee(uint256)` | `69fe0e2d` | contract.ts FEE_SELECTORS |
| `owner()` | `8da5cb5b` | contract.ts (call) |
| `balanceOf(address)` | `70a08231` | holders.ts, liquidity.ts |
| `totalSupply()` | `18160ddd` | holders.ts |
| `decimals()` | `313ce567` | liquidity.ts |
| `getPair(address,address)` | `e6a43905` | liquidity.ts (V2 factory) |
| `getPool(address,address,uint24)` | `1698ee82` | liquidity.ts (V3 factory) |
| `getPool(address,address,bool)` | `79bc57d5` | liquidity.ts (Aerodrome) |
| `token0()` | `0dfe1681` | liquidity.ts |
| `getReserves()` | `0902f1ac` | liquidity.ts |

## Key Constants

```ts
const PROXY_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO_SLOT  = '0x0000000000000000000000000000000000000000000000000000000000000000';
const ZERO_ADDR  = '0x0000000000000000000000000000000000000000';

const WETH_ETH  = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const WETH_BASE = '0x4200000000000000000000000000000000000006';

// Lock contracts (Base)
const UNCX_BASE          = '0xFD235968e65B0990584585763f837A5b5330e6DE';
const TEAM_FINANCE_BASE  = '0xe2eCEBcfc12F231e9468F8c1C3FC1aB45AC9268C';
// Lock contracts (Ethereum)
const UNCX_ETH           = '0x663A5C229c09b049E36dCc11a9B0d4a8Eb9db214';
const TEAM_FINANCE_ETH   = '0xE2fE530C047f2d85298b07D9333C05737f1435fB';
```

## Implementation Notes

1. **evmole is the only external dependency** beyond the provider. Mock it at the module level, not per-call.
2. **`provider.call` routing** — liquidity.ts calls many different contracts via `provider.call`. Use a routing map keyed by `(to, data)` tuple.
3. **`global.fetch` mock** — Only liquidity.ts calls `fetch` directly (for ETH price). Use `vi.spyOn(globalThis, 'fetch')` and restore in `afterEach`.
4. **BigInt in mock data** — All balance/supply values should be `bigint`. Return hex-encoded values from mocked `provider.call` (e.g., `'0x' + value.toString(16).padStart(64, '0')`).
5. **Address casing** — The code uses `.toLowerCase()` in several places. Mock data should use lowercase addresses to match, or tests should verify case-insensitive behavior.
6. **Parallel test isolation** — Each test must create its own mock provider instance to avoid cross-test pollution.
