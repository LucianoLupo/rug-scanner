# Test Plan Quality Audit

**Date:** 2026-04-07
**Auditor:** rug-test-plan-quality (Claude Opus agent)
**Scope:** PLAN-providers.md, PLAN-analysis.md, PLAN-integration.md
**Method:** Read all 3 plans + every source file they reference, then traced expected outputs through actual code paths.

---

## Executive Summary

- All 3 plans are **high quality and implementable as-is** — specific mock data, exact expected outputs, clear assertions.
- **~180 total tests** across all 3 plans (51 providers + 74 analysis + ~55 integration).
- **6 correctness issues** found by tracing through source code (2 wrong expected outputs, 2 framework mismatches, 2 missing edge cases).
- **3 cases of redundancy** (low severity — acceptable for documenting distinct scenarios).
- Plans are well-structured with realistic mock data that maps directly to real code paths.

---

## 1. Mock Data Realism

### Verdict: GOOD — mocks will trigger correct code paths

**Strengths:**
- All selector values (`40c10f19`, `8456cb59`, etc.) match the actual `MINT_SELECTORS`, `BLACKLIST_SELECTORS`, `PAUSE_SELECTORS`, `FEE_SELECTORS` constants in `contract.ts`.
- ABI-encoded hex for `getAmountsOut` responses is correctly structured (offset → length → values).
- Address padding logic in mocks matches the actual `padAddress()` functions.
- BigInt/hex conversions are correct (e.g., `0xde0b6b3a7640000` = 1 ETH = `1000000000000000000`).
- Lock contract addresses in PLAN-analysis §4 match the real `LOCK_CONTRACTS` in `liquidity.ts`.
- Factory addresses (Uniswap V2, V3, Aerodrome) all match the source constants.

**Issues:**

| # | Plan | Section | Issue | Severity |
|---|------|---------|-------|----------|
| M1 | providers | §4.3 Scenario B | Tax detail string says `"Estimated sell tax is 17.5%"` but `17.46.toFixed(1)` = `"17.5"`. Happens to be correct due to rounding, but the mock hex values produce `wethBack = 8000000000000000n` which gives exactly 20% round-trip, so `sellTaxPct = 17.46` and `.toFixed(1)` = `"17.5"`. **Correct but fragile** — if someone tweaks the mock wethBack, the detail string assertion will silently break. | Low |
| M2 | analysis | §4.6 Aerodrome pool | Mock data says to use `'0xAeroPool...'` as pool address — this is a placeholder, not a valid 0x + 40-hex address. The implementer will need to use a proper mock address like `'0x' + 'aa'.repeat(20)`. | Low |

---

## 2. Expected Output Correctness

### Verdict: MOSTLY CORRECT — 2 real bugs found

I traced every expected output through the source code. Here are the issues:

| # | Plan | Section | Issue | Severity |
|---|------|---------|-------|----------|
| E1 | **analysis** | **§2.6 deployer_holds_majority 10-50%** | Plan expects flag for `deployer_pct = 25.0` (25,000/100,000). Source `holders.ts:130` checks `deployer_pct > 10` for the high-severity path. **25 > 10 is true, so this IS correct.** But plan says `value: 25.0` — the actual code uses `toPct(deployerBalance)` which is `Number((25000n * 10n**18n * 10000n) / (100000n * 10n**18n)) / 100` = `25.0`. Confirmed correct. | — |
| E2 | **analysis** | **§4.11 LP unlocked low liquidity** | Plan expects `lp_unlocked_low_liquidity` flag with `value: 7000`. Source `liquidity.ts:249` uses `value: totalUsd` where `totalUsd = Math.round(totalUsd * 100) / 100`. The plan's mock gives `1 WETH * $3500 * 2 = $7000`. `Math.round(7000 * 100) / 100 = 7000`. **Correct.** | — |
| **E3** | **analysis** | **§4.2 Uniswap V2 reserves** | Plan expects `total_usd = 10 * 3500 * 2 = $70,000`. Source `liquidity.ts:228`: when no `marketData.price_usd`, uses `wethUsd * 2`. `wethEth = Number(5n * 10n**18n) / 1e18 = 5.0` (not 10). Wait — plan says "reserve1 = 10 WETH" but the `getReserves()` mock encodes `reserve0 = 1000 * 10^18` tokens and `reserve1 = 5 * 10^18` WETH. The plan text says "10 WETH" but the mock data helper `encodeReserves(1000n * 10n**18n, 5n * 10n**18n)` encodes only 5 WETH. **BUG: Either the text should say 5 WETH or the mock should use 10 WETH. The expected USD is wrong if WETH = 5: it should be 5 * 3500 * 2 = $35,000, not $70,000.** | **HIGH** |
| **E4** | **providers** | **§4.3 Scenario B asymmetric_tax detail** | Plan expects `detail: 'Sell tax (17.5%) significantly exceeds buy tax (1.9%)'`. Source `simulation.ts:199`: `buyTaxPct.toFixed(1)` = `1.94.toFixed(1)` = `"1.9"`. **Correct.** | — |
| **E5** | **integration** | **§6.1 zero address test** | Plan says zero address `0x0000...0000` might be `[200, 400]`. The Zod regex is `/^0x[a-fA-F0-9]{40}$/` which matches the zero address. So it passes validation → 200 with `no_bytecode` flag. **The `[200, 400]` assertion is overly permissive but not wrong.** Would be better as `expect(res.status).toBe(200)` with assertion on `no_bytecode` flag. | Low |
| **E6** | **integration** | **§5.2 Alchemy down → contract.verified** | Plan expects `res.data.contract.verified === false`. But in `index.ts:177-179`, `verified` is set by the explorer result, NOT the contract analysis. If Alchemy is down but explorer API works, `verified` could be `true`. The test mocks Alchemy methods but NOT the explorer API. **BUG: The test should either also mock the explorer to fail, or not assert on `verified`.** | **MEDIUM** |

---

## 3. Redundancy Analysis

### Verdict: MINIMAL — 3 minor cases, all acceptable

| # | Plans | Tests | Overlap | Verdict |
|---|-------|-------|---------|---------|
| R1 | edge-cases.test.ts (existing) + PLAN-analysis §5.2a | `honeypot_cant_sell → CRITICAL` is tested in both existing `known-rugs.test.ts` and proposed §5.2a (with extra flags). | Acceptable — §5.2a tests **priority ordering** which is a distinct concern. |
| R2 | PLAN-providers §1.8-1.9 + PLAN-analysis §1.10 | RPC errors: providers plan tests error throwing from `AlchemyProvider.rpc()`, analysis plan tests error catching in `analyzeContract`. | No overlap — different layers being tested. |
| R3 | PLAN-integration §1.2 known-safe + existing `known-safe.test.ts` | Existing tests only test `getVerdict()` with synthetic flags. Integration tests hit real RPCs. | Complementary, not redundant. |
| R4 | PLAN-analysis §2.1 zero supply + PLAN-analysis §2.9 empty transfers | Both test early-return paths in `analyzeHolders`. §2.1 returns before transfers are fetched; §2.9 hits the transfers path but with empty result. | Distinct code paths — not redundant. |

---

## 4. Implementability Assessment

### Verdict: EXCELLENT — all plans are directly codeable

**Every test in all 3 plans specifies:**
- Exact mock data (input values, mock responses with real hex)
- Exact expected outputs (return values, flag shapes, specific assertion patterns)
- Which functions to import and how to mock dependencies

**Minor implementability gaps:**

| # | Plan | Gap | Fix |
|---|------|-----|-----|
| I1 | providers | `simulation.ts` helper functions (`padAddress`, `padUint256`, `encodeGetAmountsOut`, etc.) are **not exported**. Plan §4.1 tests them directly. | Plan acknowledges this in §4.1 and §Helper Exports. Must add `export` to these functions or test indirectly. |
| I2 | analysis | `createMockProvider()` uses `vi.fn()` but source's `AlchemyProvider` is a class, not an interface. TypeScript will complain about `as unknown as AlchemyProvider`. | The `as unknown as AlchemyProvider` cast in the plan handles this. Works but is slightly fragile. |
| I3 | analysis | §4 liquidity tests need an `encodeReserves()` helper mentioned in mock data but never defined. | Implementer must write: `(r0: bigint, r1: bigint) => '0x' + r0.toString(16).padStart(64, '0') + r1.toString(16).padStart(64, '0') + '0'.padStart(64, '0')`. |
| I4 | integration | §5.5 Redis down test changes `process.env` mid-test. This could leak state to subsequent tests if `CacheService` caches the URL at construction time vs. per-call. | Need `afterEach` to restore env vars. Plan doesn't specify this. |

---

## 5. Vitest Pattern Correctness

### Verdict: MIXED — framework mismatch in PLAN-providers

| # | Plan | Issue | Severity |
|---|------|-------|----------|
| **V1** | **providers** | **Uses `node:test` patterns** (`import { mock, test } from 'node:test'`, `assert.strictEqual`, `mock.method`, `mock.restoreAll`) in the Testing Infrastructure section. The project uses **vitest** (`import { describe, it, expect, vi } from 'vitest'`). All existing tests use vitest. | **HIGH** |
| V2 | providers | Main test examples (§1.1-3.9) use `assert.strictEqual` in some places and implicit vitest-style expectations in others. The implementer will need to normalize everything to vitest. | Medium |
| V3 | analysis | Correctly uses vitest throughout (`vi.fn()`, `vi.mock()`, `vi.mocked()`, `vi.spyOn()`). Mock provider factory is well-designed. | OK |
| V4 | integration | Correctly uses vitest (`describe/it/expect`). Uses `app.request()` (Hono test client) which is correct. | OK |

**Impact of V1:** The PLAN-providers testing infrastructure section gives `node:test` mock examples that won't work with vitest. An implementer following these literally will get import errors. However, the actual test specifications (§1-4) are framework-agnostic (they describe what to assert, not how), so this is fixable by translating `mock.method(globalThis, 'fetch', ...)` → `vi.spyOn(globalThis, 'fetch').mockImplementation(...)`.

---

## 6. Test Count Estimate

| Plan | Module | Count | Notes |
|------|--------|-------|-------|
| providers | alchemy.ts | 14 | §1.1-1.11 (URL, getBytecode, getStorageAt, getBalance, getTxCount, getAssetTransfers, call, errors, timeout) |
| providers | dexscreener.ts | 9 | §2.1-2.8 (SSRF, response parsing, chain filtering, null handling, precision, timeout) |
| providers | explorer.ts | 9 | §3.1-3.9 (SSRF, URL selection, verified/unverified, HTTP errors, timeout) |
| providers | simulation.ts | 19 | §4.1-4.3 (helpers: 8, simulateTrade scenarios A-H: 8, getRouterAddress: 6) — note: plan counts 19, I count 22 including all helper sub-tests |
| **providers total** | | **51** | Plan says 51. Close to my count. |
| analysis | contract.ts | 16 | §1.1-1.16 (no bytecode, clean, selectors, proxy, owner, bytecode prefix) |
| analysis | holders.ts | 16 | §2.1-2.16 (zero supply, distributions, concentrations, deployer %, edge cases) |
| analysis | deployer.ts | 16 | §3.1-3.16 (discovery methods, boundaries, error handling, factory deploy) |
| analysis | liquidity.ts | 22 | §4.1-4.22 (no pool, V2/V3/Aerodrome, LP lock, reserves, ETH price, token order, decimals) |
| analysis | scorer.ts | 5 | §5.1 (missing test) + §5.2a-d (4 new priority tests) |
| **analysis total** | | **75** | Plan says 74 (doesn't count §5.1 separately). I count 75. |
| integration | token tests | 15 | §1.1-1.3 (5 rugs + 5 safe + 5 edge) |
| integration | payment flow | 5 | §2.1-2.3 |
| integration | cache | 4 | §3.1-3.3 (miss→hit, isolation, TTL, + implied expiry) |
| integration | rate limiting | 4 | §4.1-4.4 |
| integration | degradation | 6 | §5.1-5.6 |
| integration | error cases | ~20 | §6.1-6.5 (6 bad addresses + 6 bad chains + 4 malformed JSON + 2 wrong methods + 1 health) |
| integration | response shape | 1 | §7 |
| **integration total** | | **~55** | Plan says ~55. Matches. |

### Grand Total: ~181 new tests

Plus 5 new scorer tests added to existing files, for **~186 tests total** when added to the existing 17 tests in edge-cases/known-rugs/known-safe.

---

## 7. Issues Summary — Prioritized

### Must Fix Before Implementing

| # | Severity | Plan | Description |
|---|----------|------|-------------|
| V1 | **HIGH** | providers | Testing infrastructure uses `node:test` (mock, assert) instead of vitest (vi, expect). All mock examples need translation. |
| E3 | **HIGH** | analysis §4.2 | Reserve mock says "10 WETH" in text but `encodeReserves` uses `5n * 10n**18n`. Expected USD ($70,000) is wrong — should be $35,000 if 5 WETH, or mock should encode 10 WETH. |

### Should Fix

| # | Severity | Plan | Description |
|---|----------|------|-------------|
| E6 | **MEDIUM** | integration §5.2 | "Alchemy down" test asserts `contract.verified === false` but doesn't mock the explorer API. Explorer may still return `verified: true`, making the assertion fail. |
| I1 | **MEDIUM** | providers §4.1 | Helper functions in `simulation.ts` need to be exported before they can be tested directly. Plan notes this but doesn't resolve it. |
| I3 | **MEDIUM** | analysis §4 | `encodeReserves()` helper used in mock data is never defined. |
| I4 | **MEDIUM** | integration §5.5 | Redis env var mutation needs `afterEach` cleanup to prevent test pollution. |

### Nice to Fix

| # | Severity | Plan | Description |
|---|----------|------|-------------|
| E5 | Low | integration §6.1 | Zero address assertion `[200, 400]` is overly permissive — should be `200` with `no_bytecode` flag check. |
| M1 | Low | providers §4.3 | Detail string assertion is fragile — depends on exact `.toFixed(1)` rounding of intermediate values. |
| M2 | Low | analysis §4.6 | Placeholder pool addresses (`'0xAeroPool...'`) need to be real 42-char hex strings. |

---

## 8. Missing Test Coverage

Tests NOT covered by any of the 3 plans:

| Gap | What's Missing | Risk |
|-----|----------------|------|
| G1 | **`analyzeHolders` called with no deployer address** — `index.ts:207-209` rejects the promise if `deployerAddr` is null. The holders test plan always passes a deployer. | Medium — this is the real integration path when deployer discovery fails. |
| G2 | **Cache `set` failure** — `index.ts:288` calls `cache.set()` but if it throws, the scan response is lost. No test validates this. Integration §5.5 tests cache *read* failure only. | Medium |
| G3 | **`simulateTrade` receives empty string for `poolAddress`** — `index.ts:243` passes `''` for pool address. The simulation function ignores it (uses router address), but this coupling is untested. | Low |
| G4 | **Concurrent requests to same token** — if two requests arrive simultaneously for the same uncached token, both will do full analysis and both will write to cache. No test for this race condition. | Low |
| G5 | **`liquidity.ts` V2 factory address is hardcoded to Ethereum** — `UNISWAP_V2_FACTORY` doesn't vary by chain. On Base, V2 factory is a different address. This may cause V2 pool discovery to fail silently on Base. Not a test plan issue but a potential source bug. | Info (for implementer awareness) |

---

## 9. Recommendations

1. **Fix E3 immediately** — the reserve/USD mismatch will cause test failures that look like a real bug but are actually a plan error.
2. **Standardize PLAN-providers to vitest** — add a "Testing Framework" section at the top specifying `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'` and replace all `node:test` examples.
3. **Export simulation helpers** — add `export` to `padAddress`, `padUint256`, `encodeGetAmountsOut`, `encodeAerodromeGetAmountsOut`, `decodeAmountsOut`, `getRouterAddress` in `simulation.ts`.
4. **Add G1/G2 tests** — these are real integration gaps that could cause production issues.
5. **Define `encodeReserves()` helper** in PLAN-analysis or in a shared test utility file.
