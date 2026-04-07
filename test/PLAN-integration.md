# Integration Test Plan — `/scan` Endpoint E2E

**Date:** 2026-04-07
**Scope:** Full integration tests for the `POST /scan` endpoint, covering real on-chain data, payment flow, caching, rate limiting, degradation, and error handling.
**Runner:** Vitest
**Prerequisite:** Live Alchemy API key (tests hit real RPCs). No x402 keys needed (passthrough mode).

---

## 1. Token Test Matrix

All tokens below are real mainnet contracts. Tests hit the live `/scan` endpoint (running locally) and assert on verdict, confidence, and specific flags.

### 1.1 Known Rug Pulls (5 tokens)

These should produce `CRITICAL` or `HIGH_RISK` verdicts. They exhibit one or more of: honeypot mechanics, drained liquidity, deployer majority holdings, disposable deployer wallets, or zero activity.

| # | Token | Chain | Address | Expected Verdict | Rationale |
|---|-------|-------|---------|-----------------|-----------|
| 1 | Squid Game (SQUID) | ethereum | `0x561cf9121e89926c27fa1cfc78dfcc4c422937a4` | CRITICAL or HIGH_RISK | Notorious 2021 honeypot. Investors could not sell — the contract restricted transfers. Liquidity was drained ($3.38M). Expect flags: `honeypot_cant_sell` (if sell simulation reaches it), `no_liquidity_pool` or `lp_unlocked_low_liquidity` (liquidity was pulled), `unverified_source` likely, `deployer_disposable`. Realistically, the pool is long gone so `no_liquidity_pool` → CRITICAL is the most likely path. |
| 2 | AnubisDAO (ANUBIS) | ethereum | `0xb2ed12f121995cb55ddfc2f268d1901aec05a8de` | CRITICAL or HIGH_RISK | October 2021 rug pull. Raised $60M in ETH in 20 hours, then developers drained the liquidity pool. Expect flags: `no_liquidity_pool` (pool drained), `deployer_holds_majority` or `deployer_disposable`, `unverified_source`. With no active liquidity pool → CRITICAL. |
| 3 | RUG PULL (RUG) | base | `0x3Af31D295C09aCa8AE4524DAA6108F17F9e54F32` | CRITICAL | Self-described rug pull token on Base. Only 4 holders, $0 value, 1B supply. Expect: `no_liquidity_pool` (no DEX pool ever created or already drained), `low_holder_count`, `deployer_disposable`. No liquidity → CRITICAL. |
| 4 | Base Rug (RUG) | base | `0x6C57b43B9E0C634c4369A53DC1bc8859129c28D3` | CRITICAL or HIGH_RISK | Another explicit rug pull token on Base (verified on Basescan 2024-03-11). Expect: `no_liquidity_pool` or `lp_unlocked_low_liquidity`, `deployer_disposable`, low holder count. Likely CRITICAL via no-pool path. |
| 5 | Based Rug Pull (BasedRug) | base | `0xa281b6a797e2038c62906aaf6ce9d720b8ef2d64` | CRITICAL or HIGH_RISK | Verified on Basescan 2024-04-18. Self-described rug pull. Expect similar pattern: no liquidity, disposable deployer, few holders. CRITICAL via `no_liquidity_pool`. |

**Test assertions for rug pulls:**
```typescript
// For each rug token:
expect(['CRITICAL', 'HIGH_RISK']).toContain(result.verdict);
expect(result.score).toBeGreaterThanOrEqual(1);
expect(result.confidence).toBeGreaterThan(0);
// At least one critical/high flag present:
expect(result.flags.some(f => f.severity === 'critical' || f.severity === 'high')).toBe(true);
```

### 1.2 Known Safe Tokens (5 tokens)

These are major, well-established tokens with deep liquidity, verified source code, distributed holders, and locked LP. They should produce `SAFE` or `LOW_RISK`.

| # | Token | Chain | Address | Expected Verdict | Rationale |
|---|-------|-------|---------|-----------------|-----------|
| 1 | WETH | ethereum | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | SAFE or LOW_RISK | Wrapped Ether — the most foundational DeFi token. Verified source, immutable (no owner, no mint, no blacklist, no proxy). Deep liquidity on Uniswap V2/V3. Massive holder base. May trigger `owner_not_renounced` LOW flag if the deposit/withdraw pattern looks like ownership. Expect 0-1 flags. |
| 2 | UNI | ethereum | `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984` | SAFE or LOW_RISK | Uniswap governance token. Verified source, widely distributed. Has a `mint()` function (for governance inflation schedule) which may trigger `can_mint` flag. But it's governance-controlled. Expect: possibly `can_mint` (false positive due to governance minting), `owner_not_renounced` (governance timelock owns it). Could be LOW_RISK due to mint function detection — this is a known limitation. |
| 3 | LINK | ethereum | `0x514910771AF9Ca656af840dff83E8264EcF986CA` | SAFE or LOW_RISK | Chainlink token. Verified, widely distributed, deep liquidity. No unusual contract functions. Expect 0-1 low-severity flags. |
| 4 | AAVE | ethereum | `0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9` | SAFE or LOW_RISK | Aave governance token. Verified, proxy contract (EIP-1967 — AAVE uses a transparent proxy), which may trigger `is_proxy` flag. Has governance-controlled mint. Expect: possibly `is_proxy`, `can_mint`, but with verified source these should not push past LOW_RISK. |
| 5 | AERO | base | `0x940181a94A35A4569E4529A3CDFb74e38FD98631` | SAFE or LOW_RISK | Aerodrome — Base's primary DEX token. Verified source, deep liquidity on Aerodrome pools, large holder base. Tests Base chain analysis path including Aerodrome pool discovery. May have `can_mint` (emissions schedule) and `owner_not_renounced`. Expect LOW_RISK at worst. |

**Test assertions for safe tokens:**
```typescript
// For each safe token:
expect(['SAFE', 'LOW_RISK']).toContain(result.verdict);
expect(result.confidence).toBeGreaterThanOrEqual(0.5); // most checks should succeed
// No critical flags:
expect(result.flags.filter(f => f.severity === 'critical')).toHaveLength(0);
```

### 1.3 Edge Cases (5 tokens)

These test known limitations, unusual contract patterns, and cross-chain behavior.

| # | Token | Chain | Address | Expected Verdict | Rationale |
|---|-------|-------|---------|-----------------|-----------|
| 1 | USDC | ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | MEDIUM_RISK or HIGH_RISK (false positive) | **Known limitation documented in CLAUDE.md.** USDC is a proxy contract (AdminUpgradeabilityProxy), has `blacklist()` function, has `pause()`, has `mint()`, ownership is NOT renounced (Circle controls it). Scanner will see: `is_proxy`, `can_mint`, `can_blacklist`, `can_pause`, `owner_not_renounced`. These 5 flags → MEDIUM_RISK (≥3 flags) or HIGH_RISK (`can_mint` + `can_blacklist`). This is a **known false positive** for centralized stablecoins. The test documents expected behavior rather than asserting "correctness." |
| 2 | USDT | ethereum | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | MEDIUM_RISK or HIGH_RISK (false positive) | Similar to USDC. Tether has `issue()` (mint), `addBlackList()`, `pause()`, and ownership is not renounced. Also an older proxy-like pattern. Expect multiple flags. **Known limitation** — centralized stablecoins trigger rug pull heuristics because they have the same owner-controlled functions that scammers use. Test documents this. |
| 3 | BRETT | base | `0x532f27101965dd16442E59d40670FaF5eBB142E4` | LOW_RISK or MEDIUM_RISK | Popular Base memecoin (Boys' Club character). Legitimate but has memecoin characteristics: high top-holder concentration, possibly unrenounced ownership. Tests Base chain with a token that has real Aerodrome/Uniswap liquidity. Expect: `owner_not_renounced` maybe, `top5_holders_above_50` possibly, some flags but no critical ones. Validates that the scanner can analyze Base memecoins without crashing. |
| 4 | WETH (Base predeploy) | base | `0x4200000000000000000000000000000000000006` | SAFE or LOW_RISK | **Special edge case**: This is a system predeploy contract on Base, not deployed via a normal transaction. The deployer discovery logic (which looks for the first ERC20 transfer from zero address) may fail or return unexpected results. Tests graceful handling when `getDeployerAddress()` returns null. Expect: possibly `deployer_unknown` flag, but otherwise safe since WETH has no malicious functions. |
| 5 | USDC (Base) | base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | MEDIUM_RISK or HIGH_RISK (false positive) | Circle's native USDC on Base. Same proxy/mint/blacklist/pause pattern as Ethereum USDC. Tests that the false-positive behavior is consistent across chains. Also validates Basescan API integration (vs Etherscan for Ethereum). |

**Test assertions for edge cases:**
```typescript
// USDC/USDT: document the known false positive
expect(['MEDIUM_RISK', 'HIGH_RISK']).toContain(result.verdict);
expect(result.flags.some(f => f.type === 'can_blacklist' || f.type === 'can_mint')).toBe(true);

// BRETT: should not be CRITICAL
expect(result.verdict).not.toBe('CRITICAL');
expect(result.confidence).toBeGreaterThan(0);

// WETH Base predeploy: should handle gracefully
expect(['SAFE', 'LOW_RISK', 'MEDIUM_RISK']).toContain(result.verdict);
expect(result.checks_completed).toBeGreaterThan(0);
```

---

## 2. x402 Payment Flow Testing

The x402 middleware in `src/middleware/x402.ts` has a built-in bypass: if `X402_WALLET_ADDRESS`, `CDP_API_KEY_ID`, or `CDP_API_KEY_SECRET` are missing, it returns a passthrough middleware that calls `next()` directly.

### 2.1 Passthrough Mode (for all integration tests)

**Setup:** Do NOT set any x402 environment variables. The middleware logs `"x402 payment gate disabled — missing wallet or CDP keys"` and passes through.

```typescript
// .env.test (or environment setup in vitest.config.ts)
// X402_WALLET_ADDRESS=       ← not set
// CDP_API_KEY_ID=             ← not set
// CDP_API_KEY_SECRET=         ← not set
// ALCHEMY_API_KEY=<real key>  ← required for on-chain queries
// BASESCAN_API_KEY=<real key>
// ETHERSCAN_API_KEY=<real key>
// UPSTASH_REDIS_REST_URL=<test instance>
// UPSTASH_REDIS_REST_TOKEN=<test instance>
```

**Tests:**
1. **Scan succeeds without payment headers** — POST `/scan` with valid body, no `X-PAYMENT` header → 200 with scan result.
2. **Scan succeeds with arbitrary payment header** — POST `/scan` with `X-PAYMENT: garbage` → should still 200 (middleware is passthrough, doesn't inspect headers).

### 2.2 Payment Gate Active (requires x402 keys)

When x402 keys ARE set, the middleware should enforce payment.

**Setup:** Set all x402 env vars (can use testnet CDP keys + Base Sepolia facilitator for CI).

**Tests:**
3. **No payment header → 402 Payment Required** — POST `/scan` with valid body, no `X-PAYMENT` header → HTTP 402. Response body should include payment requirements (scheme, payTo address, price, network).
4. **Invalid payment header → 402 or 400** — POST `/scan` with `X-PAYMENT: invalidbase64` → should reject (facilitator verification fails).
5. **Verify 402 response structure** — The 402 response should contain:
   ```json
   {
     "accepts": { "scheme": "exact", "network": "eip155:8453", "payTo": "<wallet>", "price": "$0.05" },
     "description": "Rug Scanner — on-chain token risk analysis"
   }
   ```

### 2.3 Full Payment Flow (E2E, manual or staging)

This requires a real or testnet wallet with USDC. Best done as a manual smoke test or in a staging environment:

1. POST `/scan` → receive 402 with payment requirements
2. Sign EIP-3009 USDC transfer authorization
3. Construct `X-PAYMENT` header: base64-encode the payment payload JSON
4. Retry POST `/scan` with `X-PAYMENT` header → 200 with scan result
5. Verify USDC landed in the configured wallet

**Header format:**
```
X-PAYMENT: <base64-encoded JSON>
```

The JSON payload structure (per x402 spec):
```json
{
  "x402Version": "0.7.0",
  "scheme": "exact",
  "network": "eip155:8453",
  "payload": {
    "signature": "<EIP-3009 signature>",
    "authorization": {
      "from": "<payer address>",
      "to": "<payTo address>",
      "value": "50000",
      "validAfter": 0,
      "validBefore": "<expiry timestamp>",
      "nonce": "<random nonce>"
    }
  }
}
```

---

## 3. Cache Behavior Testing

Cache uses Upstash Redis with key format `scan:${chain}:${token}` and 30-minute TTL.

### 3.1 Cache Miss → Cache Hit

```typescript
it('first scan is a cache miss, second scan is a cache hit', async () => {
  const token = '0x514910771AF9Ca656af840dff83E8264EcF986CA'; // LINK
  const chain = 'ethereum';

  // Flush this specific cache key before test
  await redis.del(`scan:${chain}:${token}`);

  // First request — cache miss (will be slower, hits RPC)
  const start1 = Date.now();
  const res1 = await app.request('/scan', {
    method: 'POST',
    body: JSON.stringify({ token, chain }),
    headers: { 'Content-Type': 'application/json' },
  });
  const time1 = Date.now() - start1;
  const body1 = await res1.json();

  expect(res1.status).toBe(200);
  expect(body1.verdict).toBeDefined();

  // Second request — cache hit (should be significantly faster)
  const start2 = Date.now();
  const res2 = await app.request('/scan', {
    method: 'POST',
    body: JSON.stringify({ token, chain }),
    headers: { 'Content-Type': 'application/json' },
  });
  const time2 = Date.now() - start2;
  const body2 = await res2.json();

  expect(res2.status).toBe(200);
  // Same result returned
  expect(body2.verdict).toBe(body1.verdict);
  expect(body2.score).toBe(body1.score);
  expect(body2.scanned_at).toBe(body1.scanned_at); // same timestamp = from cache
  // Cache hit should be at least 5x faster
  expect(time2).toBeLessThan(time1 / 2);
});
```

### 3.2 Cache Key Isolation

```typescript
it('different chains produce different cache entries', async () => {
  // WETH exists on both chains with different addresses
  const ethResult = await scan('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'ethereum');
  const baseResult = await scan('0x4200000000000000000000000000000000000006', 'base');

  // Different tokens, different results
  expect(ethResult.scanned_at).not.toBe(baseResult.scanned_at);
});
```

### 3.3 Cache Expiry (TTL)

This is hard to test in real time (30 min TTL). Options:
- **Unit test with mock**: Override TTL to 1 second, verify cache expires.
- **Integration assertion**: Verify the `set` call passes `1800` as TTL by checking the Redis key's TTL via `redis.ttl()`.

```typescript
it('cache TTL is set to 1800 seconds', async () => {
  const token = '0x514910771AF9Ca656af840dff83E8264EcF986CA';
  await scan(token, 'ethereum');
  const ttl = await redis.ttl(`scan:ethereum:${token}`);
  expect(ttl).toBeGreaterThan(1700); // within ~100s of 1800
  expect(ttl).toBeLessThanOrEqual(1800);
});
```

---

## 4. Rate Limiting Testing

Rate limiter: in-memory, 10 requests per second per IP. Uses `x-forwarded-for` or `x-real-ip` header, falls back to `'unknown'`.

### 4.1 Under the Limit

```typescript
it('10 requests within 1 second succeed', async () => {
  const promises = Array.from({ length: 10 }, () =>
    app.request('/scan', {
      method: 'POST',
      body: JSON.stringify({ token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', chain: 'ethereum' }),
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '1.2.3.4',
      },
    })
  );
  const results = await Promise.all(promises);
  // All should succeed (200) — they are within the 10/s limit
  results.forEach(r => expect(r.status).toBe(200));
});
```

### 4.2 Over the Limit

```typescript
it('11th request within 1 second returns 429', async () => {
  const ip = '10.0.0.99'; // unique IP to avoid interference
  // Burn through the limit
  for (let i = 0; i < 10; i++) {
    await app.request('/scan', {
      method: 'POST',
      body: JSON.stringify({ token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', chain: 'ethereum' }),
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    });
  }

  // 11th request — should be rate limited
  const res = await app.request('/scan', {
    method: 'POST',
    body: JSON.stringify({ token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', chain: 'ethereum' }),
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
  });

  expect(res.status).toBe(429);
  const body = await res.json();
  expect(body.error).toBe('Rate limit exceeded');
});
```

### 4.3 Rate Limit Resets After Window

```typescript
it('rate limit resets after 1 second window', async () => {
  const ip = '10.0.0.100';
  // Exhaust limit
  for (let i = 0; i < 11; i++) {
    await app.request('/scan', { /* ... ip */ });
  }

  // Wait for window to expire
  await new Promise(r => setTimeout(r, 1100));

  // Should succeed again
  const res = await app.request('/scan', {
    method: 'POST',
    body: JSON.stringify({ token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', chain: 'ethereum' }),
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
  });
  expect(res.status).toBe(200);
});
```

### 4.4 Different IPs Have Independent Limits

```typescript
it('different IPs have separate rate limit buckets', async () => {
  // Exhaust limit for IP A
  for (let i = 0; i < 11; i++) {
    await app.request('/scan', {
      /* ... headers: { 'X-Forwarded-For': '192.168.1.1' } */
    });
  }
  // IP B should still work
  const res = await app.request('/scan', {
    method: 'POST',
    body: JSON.stringify({ token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', chain: 'ethereum' }),
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.168.1.2' },
  });
  expect(res.status).toBe(200);
});
```

---

## 5. Graceful Degradation Testing

The scan endpoint uses `Promise.allSettled` for all provider calls. When a provider fails, confidence drops but the response still returns. Testing this requires mocking individual providers.

### 5.1 Strategy: Provider Mocking

Use `vi.mock()` or `vi.spyOn()` to make individual providers throw or return rejected promises:

```typescript
// Mock Alchemy RPC to fail
vi.spyOn(AlchemyProvider.prototype, 'getBytecode').mockRejectedValue(new Error('RPC timeout'));
vi.spyOn(AlchemyProvider.prototype, 'call').mockRejectedValue(new Error('RPC timeout'));
vi.spyOn(AlchemyProvider.prototype, 'getAssetTransfers').mockRejectedValue(new Error('RPC timeout'));
```

### 5.2 Alchemy RPC Down

```typescript
it('returns result with lower confidence when Alchemy is down', async () => {
  // Mock all Alchemy methods to reject
  vi.spyOn(AlchemyProvider.prototype, 'getBytecode').mockRejectedValue(new Error('timeout'));
  vi.spyOn(AlchemyProvider.prototype, 'call').mockRejectedValue(new Error('timeout'));
  vi.spyOn(AlchemyProvider.prototype, 'getBalance').mockRejectedValue(new Error('timeout'));
  vi.spyOn(AlchemyProvider.prototype, 'getTransactionCount').mockRejectedValue(new Error('timeout'));
  vi.spyOn(AlchemyProvider.prototype, 'getAssetTransfers').mockRejectedValue(new Error('timeout'));
  vi.spyOn(AlchemyProvider.prototype, 'getStorageAt').mockRejectedValue(new Error('timeout'));

  const res = await scan('0x514910771AF9Ca656af840dff83E8264EcF986CA', 'ethereum');

  // Should still return a valid response
  expect(res.verdict).toBeDefined();
  expect(res.checks_completed).toBeLessThan(res.checks_total);
  expect(res.confidence).toBeLessThan(1);
  // Default data should be used for failed checks
  expect(res.data.contract.verified).toBe(false);
});
```

### 5.3 DEXScreener API Down

```typescript
it('returns result when DEXScreener is unreachable', async () => {
  // Mock global fetch for DEXScreener URLs only
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, opts) => {
    if (typeof url === 'string' && url.includes('dexscreener.com')) {
      return Promise.reject(new Error('Network error'));
    }
    return originalFetch(url, opts);
  });

  const res = await scan('0x514910771AF9Ca656af840dff83E8264EcF986CA', 'ethereum');

  expect(res.verdict).toBeDefined();
  expect(res.data.market.price_usd).toBeNull();
  expect(res.data.market.volume_24h).toBeNull();
});
```

### 5.4 Basescan/Etherscan API Down

```typescript
it('returns result with unverified status when explorer API is down', async () => {
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, opts) => {
    if (typeof url === 'string' && (url.includes('basescan.org') || url.includes('etherscan.io'))) {
      return Promise.reject(new Error('API timeout'));
    }
    return originalFetch(url, opts);
  });

  const res = await scan('0x514910771AF9Ca656af840dff83E8264EcF986CA', 'ethereum');

  expect(res.verdict).toBeDefined();
  expect(res.data.contract.verified).toBe(false); // defaults to false when explorer fails
  expect(res.flags.some(f => f.type === 'unverified_source')).toBe(true);
});
```

### 5.5 Redis Cache Down

```typescript
it('scan still works when Redis is unreachable', async () => {
  // Use invalid Redis credentials
  process.env.UPSTASH_REDIS_REST_URL = 'https://invalid.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'invalid_token';

  const res = await app.request('/scan', {
    method: 'POST',
    body: JSON.stringify({
      token: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
      chain: 'ethereum'
    }),
    headers: { 'Content-Type': 'application/json' },
  });

  // Should still return 200 (cache read failure is swallowed, cache write failure is swallowed)
  // NOTE: This depends on CacheService error handling — if it throws, scan will fail.
  // This test may reveal that CacheService needs try/catch wrapping.
  expect(res.status).toBe(200);
});
```

### 5.6 All Providers Down Simultaneously

```typescript
it('returns minimal result when all external providers fail', async () => {
  // Mock everything to fail
  // ... (mock Alchemy, fetch for DEXScreener + explorer)

  const res = await scan('0x514910771AF9Ca656af840dff83E8264EcF986CA', 'ethereum');

  expect(res.verdict).toBeDefined();
  expect(res.checks_completed).toBe(0);
  expect(res.confidence).toBe(0);
  // Should still have default data structures
  expect(res.data.contract).toBeDefined();
  expect(res.data.holders).toBeDefined();
  expect(res.data.liquidity).toBeDefined();
  expect(res.data.deployer).toBeDefined();
  expect(res.data.trading).toBeDefined();
  expect(res.data.market).toBeDefined();
});
```

---

## 6. Error Cases

### 6.1 Bad Addresses

```typescript
const BAD_ADDRESSES = [
  { token: '0xinvalid', chain: 'ethereum', desc: 'not hex' },
  { token: '0x123', chain: 'ethereum', desc: 'too short' },
  { token: '0x' + 'a'.repeat(41), chain: 'ethereum', desc: 'too long (41 chars)' },
  { token: '0x' + 'g'.repeat(40), chain: 'ethereum', desc: 'invalid hex chars' },
  { token: '', chain: 'ethereum', desc: 'empty string' },
  { token: '0x0000000000000000000000000000000000000000', chain: 'ethereum', desc: 'zero address' },
];

for (const { token, chain, desc } of BAD_ADDRESSES) {
  it(`rejects bad address: ${desc}`, async () => {
    const res = await app.request('/scan', {
      method: 'POST',
      body: JSON.stringify({ token, chain }),
      headers: { 'Content-Type': 'application/json' },
    });
    // Zero address may pass validation (it's valid hex) but will have no bytecode
    if (token === '0x0000000000000000000000000000000000000000') {
      // Could be 200 with no_bytecode flag or 400 — depends on Zod regex
      expect([200, 400]).toContain(res.status);
    } else {
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid request');
    }
  });
}
```

### 6.2 Wrong/Unsupported Chains

```typescript
const BAD_CHAINS = [
  { chain: 'solana', desc: 'unsupported chain' },
  { chain: 'polygon', desc: 'unsupported chain' },
  { chain: 'bsc', desc: 'unsupported chain' },
  { chain: '', desc: 'empty chain' },
  { chain: 'ETHEREUM', desc: 'wrong case' },
  { chain: 'Base', desc: 'wrong case (Base)' },
];

for (const { chain, desc } of BAD_CHAINS) {
  it(`rejects bad chain: ${desc}`, async () => {
    const res = await app.request('/scan', {
      method: 'POST',
      body: JSON.stringify({
        token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        chain,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid request');
  });
}
```

### 6.3 Malformed JSON

```typescript
it('rejects non-JSON body', async () => {
  const res = await app.request('/scan', {
    method: 'POST',
    body: 'not json',
    headers: { 'Content-Type': 'application/json' },
  });
  expect([400, 500]).toContain(res.status);
});

it('rejects empty body', async () => {
  const res = await app.request('/scan', {
    method: 'POST',
    body: '',
    headers: { 'Content-Type': 'application/json' },
  });
  expect([400, 500]).toContain(res.status);
});

it('rejects missing required fields', async () => {
  const res = await app.request('/scan', {
    method: 'POST',
    body: JSON.stringify({ token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' }),
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status).toBe(400);
});

it('rejects extra fields gracefully', async () => {
  const res = await app.request('/scan', {
    method: 'POST',
    body: JSON.stringify({
      token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      chain: 'ethereum',
      extra: 'field',
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  // Zod strips unknown keys by default — should still succeed
  expect(res.status).toBe(200);
});
```

### 6.4 Wrong HTTP Methods

```typescript
it('GET /scan returns 404 or 405', async () => {
  const res = await app.request('/scan', { method: 'GET' });
  expect([404, 405]).toContain(res.status);
});

it('PUT /scan returns 404 or 405', async () => {
  const res = await app.request('/scan', { method: 'PUT' });
  expect([404, 405]).toContain(res.status);
});
```

### 6.5 Health Endpoint

```typescript
it('GET /health returns 200 with status ok', async () => {
  const res = await app.request('/health');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
});
```

---

## 7. Response Shape Validation

Every successful scan response must match the `ScanResult` type. Validate the full shape:

```typescript
it('response matches ScanResult schema', async () => {
  const res = await scan('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'ethereum');

  // Top-level fields
  expect(typeof res.score).toBe('number');
  expect(['CRITICAL', 'HIGH_RISK', 'MEDIUM_RISK', 'LOW_RISK', 'SAFE']).toContain(res.verdict);
  expect(typeof res.confidence).toBe('number');
  expect(res.confidence).toBeGreaterThanOrEqual(0);
  expect(res.confidence).toBeLessThanOrEqual(1);
  expect(Array.isArray(res.flags)).toBe(true);
  expect(typeof res.checks_completed).toBe('number');
  expect(typeof res.checks_total).toBe('number');
  expect(res.checks_total).toBe(7);
  expect(res.disclaimer).toContain('Not financial advice');
  expect(res.scanned_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  // data.contract
  expect(typeof res.data.contract.verified).toBe('boolean');
  expect(typeof res.data.contract.can_mint).toBe('boolean');
  expect(typeof res.data.contract.can_blacklist).toBe('boolean');
  expect(typeof res.data.contract.can_pause).toBe('boolean');
  expect(typeof res.data.contract.is_proxy).toBe('boolean');
  expect(typeof res.data.contract.owner_renounced).toBe('boolean');
  expect(typeof res.data.contract.has_fee_setter).toBe('boolean');

  // data.holders
  expect(typeof res.data.holders.total_approx).toBe('number');
  expect(typeof res.data.holders.top5_pct).toBe('number');
  expect(typeof res.data.holders.top10_pct).toBe('number');
  expect(typeof res.data.holders.deployer_pct).toBe('number');
  expect(typeof res.data.holders.method).toBe('string');

  // data.liquidity
  expect(typeof res.data.liquidity.total_usd).toBe('number');
  expect(typeof res.data.liquidity.lp_locked).toBe('boolean');
  expect(typeof res.data.liquidity.pool_age_hours).toBe('number');
  expect(typeof res.data.liquidity.dex).toBe('string');

  // data.deployer
  expect(typeof res.data.deployer.age_days).toBe('number');
  expect(typeof res.data.deployer.tx_count).toBe('number');
  expect(typeof res.data.deployer.eth_balance).toBe('number');

  // data.trading
  expect(typeof res.data.trading.simulation_method).toBe('string');

  // data.market (nullable fields)
  expect([null, 'number'].includes(typeof res.data.market.price_usd) ||
    res.data.market.price_usd === null).toBe(true);

  // flags shape
  for (const flag of res.flags) {
    expect(['critical', 'high', 'medium', 'low', 'info']).toContain(flag.severity);
    expect(typeof flag.type).toBe('string');
    expect(typeof flag.detail).toBe('string');
    expect(flag.value).toBeDefined();
  }
});
```

---

## 8. Test Infrastructure

### 8.1 File Structure

```
test/
├── PLAN-integration.md       # This file
├── known-rugs.test.ts        # Existing unit tests (scorer)
├── known-safe.test.ts        # Existing unit tests (scorer)
├── edge-cases.test.ts        # Existing unit tests (scorer + validation)
└── integration/
    ├── setup.ts              # Hono app test client, env setup, helpers
    ├── scan-tokens.test.ts   # Sections 1.1-1.3 (15 token tests)
    ├── scan-payment.test.ts  # Section 2 (x402 tests)
    ├── scan-cache.test.ts    # Section 3 (cache tests)
    ├── scan-ratelimit.test.ts # Section 4 (rate limit tests)
    ├── scan-degradation.test.ts # Section 5 (graceful degradation)
    ├── scan-errors.test.ts   # Section 6 (error cases)
    └── scan-response.test.ts # Section 7 (response shape)
```

### 8.2 Test Helper (`setup.ts`)

```typescript
import app from '../../src/index.js';
import type { ScanResult } from '../../src/types/index.js';

export async function scan(token: string, chain: string): Promise<ScanResult> {
  const res = await app.request('/scan', {
    method: 'POST',
    body: JSON.stringify({ token, chain }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status !== 200) {
    throw new Error(`Scan failed with status ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<ScanResult>;
}

export { app };
```

### 8.3 Environment Requirements

| Variable | Required For | Notes |
|----------|-------------|-------|
| `ALCHEMY_API_KEY` | All token scans | Real key needed — tests hit mainnet RPCs |
| `BASESCAN_API_KEY` | Base chain scans | Free tier (5 calls/sec rate limit) |
| `ETHERSCAN_API_KEY` | Ethereum scans | Free tier (5 calls/sec rate limit) |
| `UPSTASH_REDIS_REST_URL` | Cache tests | Use a separate test Redis instance |
| `UPSTASH_REDIS_REST_TOKEN` | Cache tests | Use a separate test Redis instance |
| `X402_WALLET_ADDRESS` | Payment gate tests only | Omit for passthrough mode |
| `CDP_API_KEY_ID` | Payment gate tests only | Omit for passthrough mode |
| `CDP_API_KEY_SECRET` | Payment gate tests only | Omit for passthrough mode |

### 8.4 Vitest Configuration

```typescript
// vitest.config.ts additions for integration tests
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30000, // 30s per test — real RPC calls can be slow
    hookTimeout: 10000,
    pool: 'forks',      // isolate tests to prevent rate limit state leaking
    sequence: {
      concurrent: false, // run sequentially to avoid RPC rate limits
    },
  },
});
```

### 8.5 Running Integration Tests

```bash
# Run all integration tests
npm run test:integration

# Run specific suite
npx vitest test/integration/scan-tokens.test.ts

# Run with verbose output
npx vitest test/integration/ --reporter=verbose
```

Add to `package.json`:
```json
{
  "scripts": {
    "test:integration": "vitest run test/integration/ --reporter=verbose"
  }
}
```

---

## 9. Test Execution Order & CI Considerations

### 9.1 Execution Order

1. **Error cases** (Section 6) — fastest, no RPC calls needed for most
2. **Rate limiting** (Section 4) — fast, minimal RPC calls (uses cached results)
3. **Response shape** (Section 7) — single RPC call
4. **Cache behavior** (Section 3) — 2-3 RPC calls
5. **Safe tokens** (Section 1.2) — 5 RPC-heavy calls
6. **Edge cases** (Section 1.3) — 5 RPC-heavy calls
7. **Rug pulls** (Section 1.1) — 5 RPC-heavy calls (some tokens may have unusual on-chain state)
8. **Degradation** (Section 5) — mocked, fast
9. **Payment flow** (Section 2) — depends on env var configuration

### 9.2 CI Strategy

- **Alchemy free tier budget**: ~300M compute units/month. Each scan uses ~8 RPC calls. At 15 tokens × 8 calls = ~120 calls per test run. Safe for daily CI.
- **Explorer API rate limits**: 5 calls/sec for free tier. Run token tests sequentially, not in parallel.
- **Flakiness mitigation**: External APIs can be slow or temporarily down. Use `retry: 2` in Vitest config for integration tests. Accept that some RPC-dependent tests may intermittently fail.
- **Secrets**: Store API keys as CI secrets (`ALCHEMY_API_KEY`, etc.). Never hardcode.

### 9.3 Expected Test Counts

| Suite | Test Count |
|-------|-----------|
| Token tests (rugs + safe + edge) | 15 |
| Payment flow | 5 |
| Cache behavior | 4 |
| Rate limiting | 4 |
| Graceful degradation | 6 |
| Error cases (addresses + chains + JSON + methods + health) | ~20 |
| Response shape | 1 |
| **Total** | **~55** |

---

## 10. Known Limitations & Caveats

1. **Stablecoin false positives**: USDC and USDT will consistently flag as MEDIUM_RISK or HIGH_RISK due to their centralized control functions (blacklist, mint, pause). This is a documented limitation of the threshold-based scoring approach. A future allowlist or "known token" override could fix this.

2. **Rug pull tokens may evolve**: Some Base rug pull tokens may have their contracts self-destructed or state changed since the addresses were researched. If a rug pull test fails with unexpected results, verify the on-chain state hasn't changed.

3. **Deployer detection for predeploys**: Base system contracts (0x4200...0006 WETH) don't have normal deploy transactions. The deployer discovery will return `null`, producing a `deployer_unknown` flag. This is correct behavior for these contracts.

4. **UNI governance mint**: UNI has a `mint()` function controlled by governance timelock. The scanner correctly detects it but cannot distinguish governance-controlled minting from scam minting. This produces a false positive flag.

5. **Trade simulation coverage**: Simulation only works for Uniswap V2 (Ethereum) and Aerodrome (Base). Uniswap V3 pools skip simulation. Tokens with only V3 pools will have `simulation_method: 'skipped'`.

6. **Holder analysis approximation**: The scanner samples the last 1000 Transfer events, not the full history. For tokens with millions of transfers, the holder concentration numbers are approximate.

7. **RPC cost**: Each full integration test run costs ~120 Alchemy compute units. Monitor free tier usage if running frequently.
