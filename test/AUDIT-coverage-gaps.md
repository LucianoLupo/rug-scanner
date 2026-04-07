# Test Coverage Gap Audit

**Date:** 2026-04-07
**Auditor:** rug-test-plan-coverage (autonomous agent)
**Scope:** All source files in `src/` cross-referenced against PLAN-analysis.md, PLAN-providers.md, PLAN-integration.md

---

## Executive Summary

- **Total exported functions across all source files:** 12
- **Functions with planned test coverage:** 10/12 (83%)
- **Functions with ZERO planned tests:** 2 (CacheService.get, CacheService.set — unit level)
- **Critical bug found:** CacheService has no error handling — Redis failures crash scan requests
- **Missing edge cases identified:** 23
- **Untested error branches:** 11
- **Total planned tests across 3 plans:** ~180 (74 analysis + 51 providers + 55 integration)

The three test plans are thorough for the analysis and provider layers. The biggest gaps are:
1. **No unit tests for `src/cache/redis.ts`** — and a latent bug in error handling
2. **No unit tests for `src/middleware/x402.ts`** — only integration-level passthrough testing
3. **No unit tests for orchestration logic in `src/index.ts`** — batch sequencing, default assignments, checksCompleted counting
4. **Scorer blindspots** — `no_bytecode` and `zero_supply` flags have no scorer rules
5. **Rate limiter edge cases** — `x-real-ip` fallback, `'unknown'` shared bucket, memory leak potential
6. **Wrong AnubisDAO address** — integration plan §1.1 token #2 uses a copycat/test token (1 holder), not the real 2021 $60M rug pull contract

---

## 1. Functions With Zero Unit Test Coverage Planned

### 1.1 `CacheService` — `src/cache/redis.ts` (CRITICAL)

**Exported:** `CacheService` class with `get<T>(key)` and `set(key, value, ttlSeconds)`

**Current coverage:** Only tested indirectly via integration tests (PLAN-integration §3.1-3.3, §5.5). No unit test file planned.

**Missing unit tests:**
| # | Test Case | Why It Matters |
|---|-----------|----------------|
| 1 | `get()` returns `null` for missing key | Verifies nullish coalescing behavior |
| 2 | `get()` returns deserialized object for existing key | Verifies generic type flow |
| 3 | `set()` passes correct TTL to Redis | Verifies default 1800s and custom TTL |
| 4 | `get()` throws when Redis is unreachable | **See bug below** |
| 5 | `set()` throws when Redis is unreachable | **See bug below** |
| 6 | Constructor with empty URL/token | Edge case |

**BUG: No error handling in CacheService or its callers.**

```typescript
// src/cache/redis.ts — no try/catch
async get<T>(key: string): Promise<T | null> {
  const value = await this.redis.get<T>(key);  // ← throws if Redis is down
  return value ?? null;
}
```

```typescript
// src/index.ts lines 145-148 — no try/catch around cache calls
const cached = await cache.get<ScanResult>(cacheKey);  // ← unhandled throw → 500
if (cached) { return c.json(cached); }
// ...
await cache.set(cacheKey, result, 1800);  // ← unhandled throw → scan result lost
```

**Impact:** If Redis is unreachable (network blip, credentials rotated, Upstash outage), every scan request returns HTTP 500. The integration plan §5.5 explicitly notes this: _"This test may reveal that CacheService needs try/catch wrapping."_

**Recommendation:** Add try/catch in `src/index.ts` around both `cache.get()` and `cache.set()` calls. Cache failures should degrade gracefully (skip cache), not crash the request.

---

### 1.2 `createX402Middleware` — `src/middleware/x402.ts`

**Exported:** `createX402Middleware(env)` returning `MiddlewareHandler`

**Current coverage:** Integration plan §2.1 tests passthrough mode. §2.2-2.3 test active payment gate at integration level. No unit tests planned.

**Missing unit tests:**
| # | Test Case | Why It Matters |
|---|-----------|----------------|
| 1 | Returns passthrough middleware when `X402_WALLET_ADDRESS` is empty | Verify bypass logic |
| 2 | Returns passthrough middleware when `CDP_API_KEY_ID` is empty | Verify bypass logic |
| 3 | Returns passthrough middleware when `CDP_API_KEY_SECRET` is empty | Verify bypass logic |
| 4 | Passthrough middleware calls `next()` | Verify request passes through |
| 5 | `createCdpAuthHeaders` generates correct JWT paths | Internal function, verify `/platform/v2/x402/verify`, `/settle`, `/supported` |
| 6 | `createCdpAuthHeaders` sets 120s expiry | Verify JWT config |
| 7 | What if `generateJwt` throws? | Error propagation during middleware initialization |
| 8 | What if `HTTPFacilitatorClient` or `x402ResourceServer` throw during init? | Constructor failures |

**Note:** The passthrough logic has 3 conditions OR'd together. Each should be tested independently to verify any single missing key triggers bypass.

---

### 1.3 `src/server.ts` — Entry Point

**No tests planned.** This is just a `serve()` call with PORT parsing. Low priority, but:
- PORT defaults to 3000 when `process.env.PORT` is unset — untested
- PORT parsing uses `Number()` which returns `NaN` for non-numeric strings — `Number('abc') || 3000` → 3000, safe but untested

---

## 2. Untested Error Branches

### 2.1 `src/index.ts` — `c.req.json()` Failure (Line 127)

```typescript
const body = await c.req.json();  // ← can throw on malformed body
```

The integration plan §6.3 tests malformed JSON, but the behavior depends on Hono's error handling. If Hono doesn't catch `json()` parse errors, this returns HTTP 500 instead of 400. **No assertion verifies whether the error is caught by Hono or if a custom error handler is needed.**

### 2.2 `src/index.ts` — Holder Analysis When Deployer is Null (Line 207-209)

```typescript
deployerAddr
  ? analyzeHolders(provider, token, deployerAddr)
  : Promise.reject(new Error('No deployer address'))
```

When `getDeployerAddress` returns null, `analyzeHolders` is skipped entirely via `Promise.reject`. This means `DEFAULT_HOLDERS` is used (0 holders, 0% everything, method: 'failed'). **No unit test verifies this orchestration branch.** It's only tested indirectly via the Base WETH edge case in integration §1.3.4.

### 2.3 `src/index.ts` — Simulation Conditional (Lines 234-251)

```typescript
const hasPool = liquidityData.dex !== 'none' && liquidityData.dex !== 'unknown';
if (hasPool) {
  try {
    const simResult = await simulateTrade(...);
    // ...
    checksCompleted++;
  } catch {
    // simulation failed, use defaults
  }
}
```

**Missing tests:**
- What if `dex` is `'none'`? Simulation is skipped. Only tested indirectly.
- What if `dex` is `'unknown'`? Same. Only tested indirectly.
- What if `simulateTrade` throws after `hasPool` is true? The outer catch swallows it — `tradingData` stays at defaults, `checksCompleted` is NOT incremented. Never explicitly tested.
- What if `dex` is `'uniswap_v3'`? `hasPool` is true, simulation runs, but `simulateTrade` returns `skipped` (no router). `checksCompleted` IS incremented (the function succeeded, just returned skipped). **This inflates confidence for V3-only pools.**

### 2.4 `src/providers/alchemy.ts` — Malformed JSON Response

```typescript
const json = (await response.json()) as JsonRpcResponse<T>;
```

If Alchemy returns HTML (e.g., 502 Bad Gateway page) or malformed JSON, `response.json()` throws. This is NOT caught separately from the `response.ok` check. The error would propagate as an unhandled JSON parse error, not the clean "RPC HTTP error" message.

**Provider plan §1.8-1.10 cover RPC errors and HTTP errors, but not malformed response bodies.**

### 2.5 `src/analysis/liquidity.ts` — `fetchEthPriceUsd` Timeout

The function uses `AbortSignal.timeout(5000)`, matching other providers. **Unlike alchemy.ts (§1.11) and dexscreener.ts (§2.8), the analysis plan never verifies this timeout is set.** The fallback behavior IS tested (§4.13-4.16), but the 5000ms signal itself is not asserted.

### 2.6 `src/analysis/liquidity.ts` — `getV2Reserves` Malformed Response

```typescript
const hex = reservesResult.slice(2);
const reserve0 = decodeUint112(hex.slice(0, 64));
const reserve1 = decodeUint112(hex.slice(64, 128));
```

If `reservesResult` is shorter than expected (e.g., `'0x'` or truncated), `decodeUint112` would receive an empty string or garbage. `BigInt('0x')` throws. **No test verifies behavior with short/malformed reserves response.**

The outer try/catch in `analyzeLiquidity` would catch this, leaving `totalUsd = 0`. But this is never explicitly tested.

### 2.7 `src/providers/simulation.ts` — `decodeAmountsOut` Short Response

```typescript
const length = Number(BigInt('0x' + hex.slice(64, 128)));
for (let i = 0; i < length; i++) {
  const start = 128 + i * 64;
  amounts.push(BigInt('0x' + hex.slice(start, start + 64)));
}
```

If the response is truncated (length field says 2 but only 1 amount is present), the loop reads beyond the available data. `hex.slice(start, start + 64)` returns a shorter string, `BigInt('0x' + '')` throws. This would be caught by the outer try/catch in `simulateTrade`, returning `skipped`. **Never explicitly tested.**

### 2.8 `src/index.ts` — Rate Limiter `x-real-ip` Fallback

```typescript
const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown';
```

**Missing tests:**
- `x-real-ip` header is used when `x-forwarded-for` is absent — never tested
- Fallback to `'unknown'` when no IP headers present — never tested
- All headerless clients share the `'unknown'` bucket, meaning 10 requests total per second across ALL unidentified clients — never tested
- Multiple IPs in `x-forwarded-for` (e.g., `'1.2.3.4, 5.6.7.8'`) — the full string is used as the key, not just the first IP. Could be exploited to bypass rate limiting. Never tested.

### 2.9 `src/index.ts` — Rate Limiter Memory Leak

`rateLimitMap` is a `Map<string, ...>` that grows without bounds. Old entries are overwritten when the same IP returns, but unique IPs accumulate forever. Under sustained load from many unique IPs (e.g., behind a CDN with unique `x-forwarded-for` per request), this map grows indefinitely.

**No test verifies cleanup behavior because there IS no cleanup.**

### 2.10 `src/analysis/liquidity.ts` — V3 Pool False Critical

When only a V3 pool exists, `total_usd = 0` (V3 reserves aren't estimated). If LP is also unlocked:
- `lp_unlocked_low_liquidity` fires (critical) because `totalUsd < 10000`
- `low_liquidity` fires (medium) because `totalUsd < 10000`

This produces a **CRITICAL verdict for tokens that may have deep V3 liquidity.** The analysis plan §4.4 notes `total_usd = 0` for V3 but doesn't flag this as a false-positive risk. The integration plan doesn't include a token that ONLY has V3 pools to catch this.

### 2.11 `src/index.ts` — `checksCompleted` Inflation for V3

When simulation runs for a V3-pool token, `getRouterAddress` returns `null`, `simulateTrade` returns `skipped` (not a throw), and `checksCompleted++` executes. Confidence is inflated because the simulation "succeeded" (returned cleanly) but provided no data. **No test verifies confidence accuracy for V3-only tokens.**

---

## 3. Missing Edge Cases

### 3.1 Scorer Blindspots

The scorer (`src/analysis/scorer.ts`) has explicit rules for specific flag types. Several flags produced by analysis modules have **no corresponding scorer rule**:

| Flag Type | Severity | Produced By | Has Scorer Rule? |
|-----------|----------|-------------|-----------------|
| `no_bytecode` | critical | contract.ts | **NO** — only counts toward generic flag rules |
| `zero_supply` | high | holders.ts | **NO** — only counts toward generic flag rules |
| `deployer_disposable` | high | deployer.ts | **NO** |
| `deployer_fresh_wallet` | medium | deployer.ts | **NO** |
| `deployer_low_balance` | low | deployer.ts | **NO** |
| `deployer_unknown` | medium | deployer.ts | **NO** |
| `low_holder_count` | medium | holders.ts | **NO** |
| `can_pause` | medium | contract.ts | **NO** |
| `has_fee_setter` | high | contract.ts | **NO** |
| `owner_not_renounced` | low | contract.ts | **NO** |

**Impact examples:**
- A contract with `no_bytecode` but somehow with a pool → only 1 critical flag → scored as **LOW_RISK** (1 flag, no specific rule). Should arguably be CRITICAL.
- A token with `zero_supply` → only 1 high flag → scored as **LOW_RISK**. Should arguably be HIGH_RISK or CRITICAL.
- A contract with `has_fee_setter` alone → 1 high flag → LOW_RISK. Arguably should be at least MEDIUM_RISK.

**No test plan covers these scenarios.** The analysis plan §5 (scorer) lists existing coverage and the missing `top5_holders_above_50` test, but doesn't identify these flag-type blindspots.

### 3.2 Deployer Holds Majority Flag — Ambiguous Severity

`holders.ts` produces `deployer_holds_majority` with TWO different severities:
- `> 50%` → severity `critical`
- `10-50%` → severity `high`

But `scorer.ts` checks `has('deployer_holds_majority')` without considering severity. Both trigger the same verdict rules. **This means a deployer holding 11% triggers the same CRITICAL path (when combined with `lp_unlocked`) as a deployer holding 90%.** This may be intentional, but no test explicitly validates this behavior.

### 3.3 Score = Flag Count, Not Severity-Weighted

`scorer.ts` sets `score = flags.length`. A token with 3 low-severity info flags gets the same score as a token with 3 critical flags. Both would be MEDIUM_RISK via the `score >= 3` rule. **No test explicitly verifies this behavior or documents it as intentional.**

### 3.4 `analyzeContract` — `functionSelectors` Throws

If `evmole.functionSelectors()` throws (corrupted bytecode, out of memory), the error propagates up unhandled. The `Promise.allSettled` in `index.ts` would catch it, but the contract analysis returns nothing (DEFAULT_CONTRACT used). **No test in the analysis plan covers `functionSelectors` throwing.**

### 3.5 `analyzeHolders` — Integer Overflow in Percentage Calculation

```typescript
const toPct = (amount: bigint) => Number((amount * 10000n) / totalSupply) / 100;
```

If `totalSupply` is 1 wei and a holder has `2^128` tokens (mathematically impossible for a well-formed ERC20, but a malicious contract could return this), `amount * 10000n` could be an astronomically large BigInt. `Number()` on a BigInt > `Number.MAX_SAFE_INTEGER` loses precision. **No test covers extreme values.**

### 3.6 `getTokenPairs` — Multiple Pairs for Same Chain

DEXScreener can return multiple pairs for the same chain (e.g., WETH pair + USDC pair). The code takes `pairs[0]` without sorting by liquidity or volume. **No test verifies pair selection order or its implications.**

### 3.7 `analyzeLiquidity` — `marketData` Parameter Usage

`analyzeLiquidity` accepts an optional `marketData` parameter, but **`src/index.ts` never passes it**:

```typescript
// src/index.ts line 163
analyzeLiquidity(provider, token, chain),  // ← no marketData argument
```

This means the `marketData?.price_usd` branch in liquidity.ts (lines 223-226) is dead code in production. The analysis plan §4.3 tests this branch, but it can never be reached in the real app. **The total_usd calculation always uses the `wethUsd * 2` estimate, never the more accurate market-data-based calculation.**

### 3.8 `checkSourceVerified` — API Key Exposure in URL

```typescript
const url = `${baseUrl}?module=contract&action=getsourcecode&address=${tokenAddress}&apikey=${apiKey}`;
```

The API key is embedded in the URL. If an error message includes the URL (e.g., in a stack trace), the key could leak. The Alchemy provider has API key masking (tested in provider plan §1.10), but explorer.ts does not. **No test verifies API key protection in explorer error paths.**

### 3.9 Rate Limiter — Exact Boundary at `RATE_LIMIT`

```typescript
return entry.count > RATE_LIMIT;  // > 10, not >= 10
```

This means the 10th request succeeds and the 11th is blocked. The integration plan §4.2 tests this correctly (11th request returns 429). But **no test verifies the 10th request succeeds** — §4.1 fires 10 requests in parallel with `Promise.all`, which doesn't guarantee sequential counting. If requests are processed concurrently, the count could be 10 after all complete, which is exactly at the boundary.

### 3.10 `analyzeContract` — Owner Check with Short Result

```typescript
const ownerHex = '0x' + result.slice(-40);
```

If `result` is shorter than 40 characters (e.g., `'0x01'`), `slice(-40)` returns the entire string. `ownerHex` would be `'0x0x01'`, which is not the zero address, so `owner_renounced` would be false. **This is a minor edge case — an on-chain `owner()` call should always return a 32-byte value — but no test covers short/malformed owner responses.**

---

## 4. Integration Test Token Address Verification

### Well-Known Tokens (High Confidence)

| Token | Chain | Address | Verified? |
|-------|-------|---------|-----------|
| WETH | ethereum | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | ✅ Canonical |
| UNI | ethereum | `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984` | ✅ Canonical |
| LINK | ethereum | `0x514910771AF9Ca656af840dff83E8264EcF986CA` | ✅ Canonical |
| AAVE | ethereum | `0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9` | ✅ Canonical |
| AERO | base | `0x940181a94A35A4569E4529A3CDFb74e38FD98631` | ✅ Canonical |
| USDC | ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | ✅ Canonical |
| USDT | ethereum | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | ✅ Canonical |
| BRETT | base | `0x532f27101965dd16442E59d40670FaF5eBB142E4` | ✅ Canonical |
| WETH | base | `0x4200000000000000000000000000000000000006` | ✅ System predeploy |
| USDC | base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | ✅ Canonical |

### Rug Pull Tokens (Verified on 2026-04-07)

| Token | Chain | Address | Status |
|-------|-------|---------|--------|
| SQUID | ethereum | `0x561cf9121e89926c27fa1cfc78dfcc4c422937a4` | ✅ Well-documented 2021 honeypot, address matches public records |
| AnubisDAO | ethereum | `0xb2ed12f121995cb55ddfc2f268d1901aec05a8de` | ❌ **WRONG ADDRESS.** Verified on Etherscan: this is a copycat/test token (ERC-20, 10,000 supply, 1 holder, generated via free token factory). This is NOT the original AnubisDAO from the 2021 $60M rug pull. The test plan's rationale references the real AnubisDAO — the address needs to be corrected. |
| RUG PULL | base | `0x3Af31D295C09aCa8AE4524DAA6108F17F9e54F32` | ✅ Valid. ERC-20, 9 decimals, 1B supply, 4 holders, $0 value, verified source (Solidity 0.8.25). Usable as rug test fixture. |
| Base Rug | base | `0x6C57b43B9E0C634c4369A53DC1bc8859129c28D3` | ✅ Valid. ERC-20, 9 decimals, 10M supply, 68 holders, $0 value, verified source (Solidity 0.8.0). Has Uniswap V2 router integration and tax features (set to 0%). Most "active" of the rug tokens with 68 holders. |
| Based Rug Pull | base | `0xa281b6a797e2038c62906aaf6ce9d720b8ef2d64` | ✅ Valid. ERC-20, 18 decimals, 1B supply, 14 holders, $0 value, unknown reputation. Usable as rug test fixture. |

**Critical: AnubisDAO address is incorrect.** The integration plan §1.1 token #2 references "October 2021 rug pull. Raised $60M in ETH" but the address `0xb2ed12f121995cb55ddfc2f268d1901aec05a8de` is a copycat with 1 holder and zero trading history. The real AnubisDAO rug pull used a different contract address. This test case needs the correct address or should be replaced with a verified rug pull token.

**Note on Base rug tokens:** All 3 Base tokens are valid and usable, but they are extremely low activity. Since they have $0 value and no liquidity pools, the primary verdict path will be `no_liquidity_pool` → CRITICAL. This is correct behavior but means the tests mostly exercise the same verdict path rather than diverse rug patterns.

### Chain Assignment

All addresses are on the correct chains:
- Ethereum addresses: standard 0x format, well-known tokens
- Base addresses: WETH predeploy (0x4200...), USDC/BRETT/AERO all on Base mainnet
- Base rug tokens: all confirmed on Basescan

---

## 5. Structural Coverage Gaps

### 5.1 No Test File for `src/cache/redis.ts`

**Current state:** No `test/cache.test.ts` or `test/providers/redis.test.ts` planned.

**Recommended tests:**
```
test/cache.test.ts
├── get() returns null for missing key
├── get() returns parsed object for existing key
├── set() calls redis.set with correct TTL
├── set() defaults TTL to 1800
├── get() propagates Redis errors (until bug is fixed)
└── set() propagates Redis errors (until bug is fixed)
```

### 5.2 No Test File for `src/middleware/x402.ts`

**Current state:** No `test/middleware/x402.test.ts` planned.

**Recommended tests:**
```
test/middleware/x402.test.ts
├── returns passthrough when WALLET_ADDRESS missing
├── returns passthrough when CDP_API_KEY_ID missing
├── returns passthrough when CDP_API_KEY_SECRET missing
├── passthrough calls next() without modifying request
├── createCdpAuthHeaders generates 3 JWT sets (verify/settle/supported)
└── handles generateJwt failure gracefully
```

### 5.3 No Orchestration Unit Tests for `src/index.ts`

The integration plan tests the `/scan` endpoint end-to-end but never unit-tests the orchestration logic (batching strategy, default assignment, checksCompleted counting).

**Recommended tests:**
```
test/orchestration.test.ts
├── Batch 1 runs all 5 calls in parallel (allSettled)
├── Batch 2 waits for deployer address from Batch 1
├── Batch 2 skips holders when deployer is null
├── Batch 3 skips simulation when dex is 'none'
├── Batch 3 skips simulation when dex is 'unknown'
├── Batch 3 runs simulation when dex is 'uniswap_v2'
├── checksCompleted counts only fulfilled results
├── checksCompleted NOT incremented for simulation catch
├── Default data used for each failed check
├── Cache get error does not crash request
├── Cache set error does not prevent response
└── All flags from all checks are aggregated correctly
```

### 5.4 Missing Scorer Tests Beyond §5.1-5.2

The analysis plan identifies `top5_holders_above_50` as missing (§5.1) and adds 4 priority-ordering tests (§5.2). But several verdict paths remain untested:

| Scenario | Expected Verdict | Status |
|----------|-----------------|--------|
| `no_bytecode` only (1 critical flag) | LOW_RISK | Not tested — arguably should be higher |
| `zero_supply` only (1 high flag) | LOW_RISK | Not tested — arguably should be higher |
| `has_fee_setter` only (1 high flag) | LOW_RISK | Not tested |
| `deployer_unknown` + `low_holder_count` (2 medium flags) | LOW_RISK | Not tested |
| 2 high flags (not matching any named combo) | MEDIUM_RISK | Tested (§5.2 existing) |
| `can_blacklist` alone (no `can_mint`) | LOW_RISK | Not tested |
| `lp_unlocked` alone (high liquidity, no `low_liquidity`) | LOW_RISK | Not tested |
| Empty flags array | SAFE | Tested ✅ |

---

## 6. Summary of Recommendations

### Priority 1 — Fix Before Testing

1. **Add try/catch around cache calls in `src/index.ts`** (lines 145-148, 288). Cache failures must not crash scan requests.

### Priority 2 — Add to Test Plans

2. **Fix AnubisDAO address in PLAN-integration.md §1.1 token #2** — Current address `0xb2ed12...` is a copycat (1 holder, zero activity). Find the real AnubisDAO rug pull contract or replace with a verified rug pull.
3. **Add `test/cache.test.ts`** — Unit tests for CacheService (6 tests)
4. **Add `test/middleware/x402.test.ts`** — Unit tests for payment middleware (6 tests)
5. **Add `test/orchestration.test.ts`** — Unit tests for scan endpoint orchestration (12 tests)
6. **Add scorer tests for unhandled flag types** — `no_bytecode`, `zero_supply`, `has_fee_setter` solo (3 tests)

### Priority 3 — Consider Adding
7. **Add `x-real-ip` and `'unknown'` fallback tests** to rate limiter suite (3 tests)
8. **Add malformed response body test** to Alchemy provider suite (1 test)
9. **Add `marketData` passthrough test** to verify liquidity.ts receives market data from index.ts (or document the dead code)
10. **Test `functionSelectors` throwing** in contract analysis (1 test)

### Priority 4 — Design Questions (Not Bugs, But Worth Discussing)

11. Should `no_bytecode` and `zero_supply` have explicit scorer rules?
12. Should `checksCompleted` distinguish between "succeeded with data" and "succeeded with skipped"?
13. Should the rate limiter have a cleanup mechanism for old entries?
14. Should V3-only pools skip the LP-lock check (since `total_usd = 0` causes false CRITICAL)?
15. Should `analyzeLiquidity` receive `marketData` from the scan endpoint for more accurate USD estimates?

---

## Appendix: Complete Function ↔ Test Matrix

| File | Export | PLAN-analysis | PLAN-providers | PLAN-integration |
|------|--------|--------------|----------------|-----------------|
| `analysis/contract.ts` | `analyzeContract` | §1 (16 tests) | — | Indirect |
| `analysis/holders.ts` | `analyzeHolders` | §2 (16 tests) | — | Indirect |
| `analysis/deployer.ts` | `getDeployerAddress` | §3 (5 tests) | — | Indirect |
| `analysis/deployer.ts` | `analyzeDeployer` | §3 (11 tests) | — | Indirect |
| `analysis/liquidity.ts` | `analyzeLiquidity` | §4 (22 tests) | — | Indirect |
| `analysis/scorer.ts` | `getVerdict` | §5 (existing + 5) | — | Indirect |
| `analysis/scorer.ts` | `calculateConfidence` | §5 (existing) | — | Indirect |
| `providers/alchemy.ts` | `AlchemyProvider` | — | §1 (14 tests) | Indirect |
| `providers/dexscreener.ts` | `getTokenPairs` | — | §2 (9 tests) | Indirect |
| `providers/explorer.ts` | `checkSourceVerified` | — | §3 (9 tests) | Indirect |
| `providers/simulation.ts` | `simulateTrade` | — | §4 (19 tests) | Indirect |
| `cache/redis.ts` | `CacheService` | — | **NONE** | §3, §5.5 only |
| `middleware/x402.ts` | `createX402Middleware` | — | **NONE** | §2 only |
| `index.ts` | `app` (default) | — | — | §1-§7 (55 tests) |
| `server.ts` | (entry point) | — | — | **NONE** |
