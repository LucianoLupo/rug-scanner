# Test Plan Practicality Audit

**Date:** 2026-04-07
**Auditor:** rug-test-plan-practical (autonomous research agent)
**Scope:** PLAN-providers.md, PLAN-analysis.md, PLAN-integration.md
**Verdict:** Providers and Analysis plans are ready to implement. Integration plan needs significant rework before it's CI-safe.

---

## Executive Summary

- **PLAN-providers** (~40 tests): **READY.** Fully mocked via `vi.spyOn(globalThis, 'fetch')`. Zero network calls. One blocker: `simulation.ts` helper functions are not exported.
- **PLAN-analysis** (~74 tests): **READY.** Fully mocked via `vi.fn()` on provider methods. Zero network calls. Well-designed mock strategy that matches actual code structure.
- **PLAN-integration** (~55 tests): **NOT READY FOR CI.** Requires live Alchemy RPCs, Basescan/Etherscan APIs, and Upstash Redis. Rate limit tests fire 80-100 real RPC calls. Will be slow (~5-10 min), flaky, and expensive. Needs rearchitecting into mocked integration + a small smoke-test suite.

---

## 1. Can These Tests Actually Run?

### PLAN-providers: YES (fully mocked)

Every test mocks `globalThis.fetch` via `vi.spyOn`. No real network calls.

**Verified against source code:**
- `AlchemyProvider` is a class exported from `src/providers/alchemy.ts` — tests instantiate it directly with a fake API key, then mock `fetch`. This works.
- `getTokenPairs` is exported from `src/providers/dexscreener.ts` — tests mock `fetch`, call the function. This works.
- `checkSourceVerified` is exported from `src/providers/explorer.ts` — same pattern. This works.
- `simulateTrade` is exported from `src/providers/simulation.ts` — can be tested via fetch mocking.

**One blocker:** Section 4 (simulation.ts) wants to test `padAddress`, `padUint256`, `encodeGetAmountsOut`, `encodeAerodromeGetAmountsOut`, and `decodeAmountsOut` as standalone functions. But **all five are private** (not exported). Either:
  1. Export them (recommended — they're pure utility functions, safe to expose).
  2. Test them indirectly through `simulateTrade` (harder, less precise).
  3. Use vitest `vi.importActual` tricks (fragile, not recommended).

### PLAN-analysis: YES (fully mocked)

Mock strategy: `createMockProvider()` returns an object with all `AlchemyProvider` methods stubbed via `vi.fn()`. Analysis functions accept `provider` as a parameter (dependency injection), so mocking is clean.

**Verified against source code:**
- `analyzeContract(provider, tokenAddress)` — takes provider as first arg. Mock works.
- `analyzeHolders(provider, tokenAddress, deployerAddress)` — same pattern. Mock works.
- `getDeployerAddress(provider, tokenAddress)` + `analyzeDeployer(provider, tokenAddress)` — same pattern. Mock works.
- `analyzeLiquidity(provider, tokenAddress, chain, marketData)` — takes provider + additional params. Mock works.
- `evmole.functionSelectors` — external dependency, correctly identified for `vi.mock('evmole')`.
- `liquidity.ts` calls `globalThis.fetch` for ETH price — correctly identified, mocked via `vi.spyOn(globalThis, 'fetch')`.
- Scorer tests (`getVerdict`, `calculateConfidence`) — pure functions, no mocking needed.

**Type safety note:** `createMockProvider()` uses `as unknown as AlchemyProvider`. Since `AlchemyProvider` is a class (not an interface), this typecast is necessary. If the class gains new methods in the future, mock will silently lack them. Consider extracting an interface — but this is minor.

### PLAN-integration: PARTIALLY (needs live APIs)

**Hard requirements for token scans (Sections 1.1-1.3):**
- `ALCHEMY_API_KEY` — real key hitting mainnet RPCs
- `BASESCAN_API_KEY` / `ETHERSCAN_API_KEY` — real keys for source verification
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — real Redis instance

**What goes wrong:**
- 15 real token scans, each making ~8 RPC calls = ~120 Alchemy calls per run
- Alchemy free tier: 300M compute units/month — safe for daily runs but tight for frequent CI
- Basescan/Etherscan free tier: 5 calls/sec — sequential tests required, adds latency
- On-chain state for rug pull tokens can change (self-destruct, state migration) — tests may become stale
- Network latency: 30s timeout per test, 15 tests = up to 7.5 min just for timeouts on slow days

**Rate limit tests (Section 4) are the worst offender:** Each test fires 10-11 real scan requests. With 4 rate limit tests, that's ~44 full scans = ~352 RPC calls JUST for rate limit testing. Rate limiting is an in-memory map — it should be tested with mocked scan handlers, not real RPCs.

**Cache tests (Section 3)** require a real Upstash Redis. This adds infrastructure dependency to CI. Consider mocking the `CacheService` class or using a local Redis for testing.

**Degradation tests (Section 5)** are actually well-designed — they mock individual providers using `vi.spyOn`. These could run without real APIs as long as the Hono app boots without crashing on missing env vars.

---

## 2. Test Infrastructure: Do We Need New Dependencies?

**No new dependencies needed.** Everything uses vitest built-ins:

| Tool | Provided By | Used For |
|------|------------|----------|
| `vi.fn()` | vitest | Mock provider methods |
| `vi.mock()` | vitest | Mock `evmole` module |
| `vi.spyOn(globalThis, 'fetch')` | vitest | Mock HTTP calls |
| `vi.mocked()` | vitest | Type-safe mock access |
| `app.request()` | hono | Built-in test client (no server needed) |
| `AbortSignal.timeout()` | Node.js 20+ | Native, already required by runtime |

**msw, nock, supertest** — NONE needed. The plans correctly use `vi.spyOn(globalThis, 'fetch')` for HTTP mocking and Hono's built-in `app.request()` for integration testing. This is simpler and has zero dependency overhead.

**One vitest config issue:** The current `vitest.config.ts` has:
```ts
{ test: { globals: true, environment: 'node' } }
```
The integration plan proposes adding `testTimeout: 30000`, `pool: 'forks'`, and `sequence: { concurrent: false }`. These settings conflict with running fast unit tests. **Solution:** Use vitest workspace or separate config files:
- `vitest.config.ts` (default) — unit tests, fast, no special config
- `vitest.config.integration.ts` — integration tests, 30s timeout, sequential

---

## 3. Time Estimates

| Plan | Tests | Complexity | Estimate |
|------|-------|-----------|----------|
| PLAN-analysis: scorer additions (5.1-5.2) | 5 | Low — add to existing test files | 30 min |
| PLAN-analysis: contract.ts (1.1-1.16) | 16 | Medium — mock provider + evmole | 2-3 hrs |
| PLAN-analysis: holders.ts (2.1-2.16) | 16 | Medium — complex mock routing | 2-3 hrs |
| PLAN-analysis: deployer.ts (3.1-3.16) | 16 | Medium — two-phase discovery mock | 2-3 hrs |
| PLAN-analysis: liquidity.ts (4.1-4.22) | 22 | High — multi-contract call routing | 3-4 hrs |
| PLAN-providers: alchemy.ts (1.1-1.11) | 15 | Low — straightforward fetch mock | 2-3 hrs |
| PLAN-providers: dexscreener.ts (2.1-2.8) | 10 | Low — simple response mocking | 1-2 hrs |
| PLAN-providers: explorer.ts (3.1-3.9) | 9 | Low — simple response mocking | 1-2 hrs |
| PLAN-providers: simulation.ts (4.1+) | ~12 | Medium — needs export changes first | 2-3 hrs |
| PLAN-integration: error cases (Section 6) | 20 | Low — no RPCs for most | 2-3 hrs |
| PLAN-integration: degradation (Section 5) | 6 | Medium — provider-level mocking | 2-3 hrs |
| PLAN-integration: token scans (Section 1) | 15 | High — env setup, flakiness | 3-4 hrs |
| PLAN-integration: cache/rate/payment (2-4) | 13 | High — infra dependencies | 3-4 hrs |
| **TOTAL** | **~175** | | **~24-37 hrs** |

**Realistic total with setup, debugging, and iteration: ~30-40 hours** (3-5 days of focused work).

---

## 4. Priority Order (Maximum Confidence, Minimum Effort)

### Tier 1: Implement First (high value, zero infra)

1. **PLAN-analysis: scorer tests (5.1-5.2)** — 5 tests, 30 min. Adds coverage to the most critical logic (verdict determination). Existing test files, just add new test cases.

2. **PLAN-analysis: contract.ts tests (1.1-1.16)** — 16 tests, 2-3 hrs. Tests the bytecode analysis engine — the core of what makes a token "risky." Pure mock, no network.

3. **PLAN-providers: alchemy.ts tests (1.1-1.11)** — 15 tests, 2-3 hrs. Tests the foundational data layer that everything else depends on. Validates request construction and error handling.

### Tier 2: Implement Second (high value, moderate effort)

4. **PLAN-analysis: deployer.ts tests (3.1-3.16)** — 16 tests, 2-3 hrs. Tests deployer discovery and wallet age analysis. Two-phase discovery mock is slightly more complex.

5. **PLAN-analysis: holders.ts tests (2.1-2.16)** — 16 tests, 2-3 hrs. Tests holder concentration analysis with balanceOf routing.

6. **PLAN-providers: dexscreener.ts + explorer.ts (2.1-3.9)** — 19 tests, 2-3 hrs. SSRF validation tests are security-critical. Simple response mocking.

### Tier 3: Implement Third (medium value, higher effort)

7. **PLAN-analysis: liquidity.ts tests (4.1-4.22)** — 22 tests, 3-4 hrs. Most complex mock setup (multi-contract call routing, ETH price fetch). Highest effort per test.

8. **PLAN-providers: simulation.ts (4.1+)** — ~12 tests, 2-3 hrs. **BLOCKED** until helper functions are exported. After export, the encoding/decoding tests are pure functions and easy.

### Tier 4: Implement Last (requires rearchitecting)

9. **PLAN-integration: error cases + response shape (Sections 6-7)** — 21 tests, 2-3 hrs. Can mostly run without real APIs (input validation rejects before any RPC call). High value for documenting the API contract.

10. **PLAN-integration: degradation tests (Section 5)** — 6 tests, 2-3 hrs. Well-designed mocking approach. Needs care with env var handling at app boot.

11. **PLAN-integration: token scans + cache + rate limit (Sections 1-4)** — 32 tests, 6-8 hrs. **Needs rearchitecting.** Rate limit and cache tests should mock the scan handler. Token scans should be a separate `test:smoke` script, not default CI.

---

## 5. Harmful or Dangerous Tests

### CRITICAL: Rate limit tests will drain Alchemy compute units

Section 4 fires 10-11 REAL scan requests per test case across 4 tests = ~44 full scans = ~350 RPC calls. This exists solely to test an in-memory `Map` counter. **Fix: mock the scan handler response for rate limit tests.**

### HIGH: API key leakage risk in CI

The integration plan requires `ALCHEMY_API_KEY`, `BASESCAN_API_KEY`, `ETHERSCAN_API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` as environment variables. If CI secrets aren't configured correctly, tests will:
- Fail silently (empty string defaults)
- Or worse, log the keys in error messages (Alchemy provider masks keys in errors — good — but Basescan/Etherscan URLs embed the key as a query param and may leak in stack traces)

**Fix:** Add a pre-check that validates required env vars exist before running integration tests, with clear error messages.

### MEDIUM: Rug pull tokens may become stale

The 5 rug pull tokens in Section 1.1 were researched as of 2026-04-07. On-chain state can change:
- Contracts can self-destruct
- Tokens can be migrated
- Liquidity can be added back (making a "known rug" appear less risky)

**Fix:** Add a comment with the date each token was verified. Include a script or manual checklist to re-verify token state quarterly.

### LOW: Redis cache test (Section 3.3) uses timing assertions

The cache test asserts `time2 < time1 / 2` (cached response is 2x faster). This is a timing-based assertion that will be flaky under CI load. **Fix:** Assert on `scanned_at` timestamp equality (same timestamp = from cache) instead of timing.

### SAFE: No mainnet state mutations

None of the tests write to the blockchain, send transactions, or modify on-chain state. All API calls are read-only (eth_getCode, eth_getBalance, etc.). The x402 payment tests are either passthrough (no payment) or marked as manual/staging-only.

### SAFE: No API key hardcoding in test fixtures

All test plans use fake addresses and reference env vars. No real API keys appear in test code.

---

## 6. Specific Issues Found in Each Plan

### PLAN-providers.md

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| P1 | `padAddress`, `padUint256`, `encodeGetAmountsOut`, `encodeAerodromeGetAmountsOut`, `decodeAmountsOut` are private in `simulation.ts` | **Blocker** | Add `export` to these 5 functions |
| P2 | Section 1.2 test expects `null` for empty string `""` bytecode | Minor | Works correctly — empty string is falsy in JS, caught by `!result` check in `getBytecode()` |
| P3 | Mock data uses `"0xTokenAddr0000000000000000000000000000dead"` — not a valid checksum address | None | Checksum doesn't matter for these tests (no checksum validation in provider code) |

### PLAN-analysis.md

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| A1 | `createMockProvider()` uses `as unknown as AlchemyProvider` typecast | Low | Works but won't catch interface drift. Consider extracting `IAlchemyProvider` interface (optional). |
| A2 | Liquidity test 4.4 says V3 `total_usd = 0` because code says "skip reserve estimation for now" | None | Verified — liquidity.ts does skip V3 reserve estimation. Correctly documented. |
| A3 | Missing test for `analyzeLiquidity` when `marketData` parameter is the default all-null object | Low | Add one test with `marketData = DEFAULT_MARKET` to exercise the `!marketData.price_usd` path in all calculations |
| A4 | 74 tests total claimed — math checks out (16 + 16 + 16 + 22 + 4) | None | Correct |

### PLAN-integration.md

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| I1 | Rate limit tests fire real RPC calls (~350 total) | **Critical** | Mock the scan response for rate limit tests |
| I2 | Cache tests require real Upstash Redis | **High** | Either mock `CacheService` or provide a test Redis instance |
| I3 | Token scan tests are non-deterministic (on-chain state changes) | **High** | Add staleness dates, use loose assertions (allow MEDIUM_RISK to HIGH_RISK range), add re-verification script |
| I4 | Vitest config changes conflict with unit test runner | **Medium** | Use vitest workspace or separate config: `vitest.config.integration.ts` |
| I5 | `Section 3.1` timing assertion (`time2 < time1 / 2`) is flaky | **Medium** | Assert on `scanned_at` equality instead |
| I6 | Section 5.5 (Redis down) may crash app if `CacheService` constructor throws on invalid URL | **Medium** | Test first, then fix `CacheService` if needed |
| I7 | Section 2.2 (Payment gate active) says "can use testnet CDP keys" but no guidance on setup | **Low** | Document Base Sepolia facilitator setup or mark as manual-only |
| I8 | `checks_total` is hardcoded to 7 in assertion (Section 7) | **Low** | Import `CHECKS_TOTAL` constant instead of hardcoding |

---

## 7. Recommended Architecture for Integration Tests

Split PLAN-integration into two tiers:

### Tier A: Mocked Integration (runs in CI, no secrets needed)
- Error cases (Section 6) — input validation, no RPCs
- Response shape (Section 7) — mock all providers, verify shape
- Degradation (Section 5) — mock individual providers
- Rate limiting (Section 4) — mock scan handler
- Payment passthrough (Section 2.1-2.2) — no x402 keys
- Cache behavior (Section 3) — mock `CacheService`

### Tier B: Smoke Tests (runs manually or in nightly CI, needs secrets)
- 15 real token scans (Sections 1.1-1.3) — needs `ALCHEMY_API_KEY` etc.
- Cache with real Redis (Section 3) — needs Upstash creds
- Payment gate with real keys (Section 2.3) — manual only

**Script setup:**
```json
{
  "scripts": {
    "test": "vitest run",
    "test:integration": "vitest run -c vitest.config.integration.ts",
    "test:smoke": "SMOKE=1 vitest run -c vitest.config.smoke.ts"
  }
}
```

---

## 8. Summary Scorecard

| Plan | Implementable? | Infra Needed | Estimated Hours | Priority |
|------|---------------|-------------|-----------------|----------|
| PLAN-providers | YES (1 blocker: export helpers) | None | 6-10 hrs | HIGH |
| PLAN-analysis | YES | None | 10-13 hrs | HIGHEST |
| PLAN-integration (mocked parts) | YES (after rearchitecting) | None | 6-9 hrs | MEDIUM |
| PLAN-integration (smoke tests) | YES (with API keys) | Alchemy + Basescan + Etherscan + Redis | 6-8 hrs | LOW |

**Total implementable without rework: ~130 tests in ~16-23 hours**
**Total including integration rework: ~175 tests in ~30-40 hours**

---

## 9. Recommended Implementation Sequence

```
Week 1 (Day 1-2): Analysis tests
  1. scorer additions (30 min)
  2. contract.ts (2-3 hrs)
  3. deployer.ts (2-3 hrs)
  4. holders.ts (2-3 hrs)
  → Run: npm test → all pass → commit

Week 1 (Day 3): Provider tests
  5. Export simulation.ts helpers (5 min)
  6. alchemy.ts (2-3 hrs)
  7. dexscreener.ts + explorer.ts (2-3 hrs)
  8. simulation.ts (2-3 hrs)
  → Run: npm test → all pass → commit

Week 1 (Day 4): Analysis liquidity + integration setup
  9. liquidity.ts (3-4 hrs)
  10. Set up vitest workspace for integration tests
  11. Integration error cases (2-3 hrs)
  → Run: npm test → all pass → commit

Week 2 (Day 1-2): Mocked integration + smoke tests
  12. Integration degradation (2-3 hrs)
  13. Integration rate limit (mocked) (1-2 hrs)
  14. Integration response shape (1 hr)
  15. Smoke test setup + token scans (3-4 hrs)
  → Run: npm test && npm run test:integration → commit
```
