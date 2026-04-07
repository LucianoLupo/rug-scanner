# Provider Unit Test Plan

**Date:** 2026-04-07
**Scope:** `src/providers/alchemy.ts`, `dexscreener.ts`, `explorer.ts`, `simulation.ts`
**Strategy:** Mock `global.fetch` per test. No network calls. Each test asserts on request construction AND response handling.

---

## 1. alchemy.ts — `AlchemyProvider`

### 1.1 URL Construction

**Test: `getChainUrl()` returns Base URL for chain "base"**
```ts
const p = new AlchemyProvider('test-key-123', 'base');
assert.strictEqual(p.getChainUrl(), 'https://base-mainnet.g.alchemy.com/v2/test-key-123');
```

**Test: `getChainUrl()` returns Ethereum URL for chain "ethereum"**
```ts
const p = new AlchemyProvider('test-key-123', 'ethereum');
assert.strictEqual(p.getChainUrl(), 'https://eth-mainnet.g.alchemy.com/v2/test-key-123');
```

### 1.2 `getBytecode` (eth_getCode)

**Test: returns bytecode for a contract**

Mock fetch request (assert on):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_getCode",
  "params": ["0x1234567890abcdef1234567890abcdef12345678", "latest"]
}
```

Mock fetch response:
```json
{ "jsonrpc": "2.0", "id": 1, "result": "0x6080604052" }
```

Expected: returns `"0x6080604052"`

**Test: returns null when bytecode is "0x" (EOA, not a contract)**

Mock response:
```json
{ "jsonrpc": "2.0", "id": 1, "result": "0x" }
```

Expected: returns `null`

**Test: returns null when bytecode is empty string**

Mock response:
```json
{ "jsonrpc": "2.0", "id": 1, "result": "" }
```

Expected: returns `null`

### 1.3 `getStorageAt` (eth_getStorageAt)

**Test: returns storage value at slot**

Mock request params:
```json
["0xaabbccdd00112233aabbccdd00112233aabbccdd", "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest"]
```

Mock response:
```json
{ "jsonrpc": "2.0", "id": 1, "result": "0x000000000000000000000000deadbeef00000000000000000000000000000001" }
```

Expected: returns `"0x000000000000000000000000deadbeef00000000000000000000000000000001"`

### 1.4 `getBalance` (eth_getBalance)

**Test: returns BigInt from hex balance**

Mock request params:
```json
["0x1111111111111111111111111111111111111111", "latest"]
```

Mock response:
```json
{ "jsonrpc": "2.0", "id": 1, "result": "0xde0b6b3a7640000" }
```

Expected: returns `BigInt("1000000000000000000")` (1 ETH in wei)

**Test: returns 0n for zero balance**

Mock response:
```json
{ "jsonrpc": "2.0", "id": 1, "result": "0x0" }
```

Expected: returns `0n`

### 1.5 `getTransactionCount` (eth_getTransactionCount)

**Test: parses hex transaction count to decimal**

Mock request params:
```json
["0x2222222222222222222222222222222222222222", "latest"]
```

Mock response:
```json
{ "jsonrpc": "2.0", "id": 1, "result": "0x1a4" }
```

Expected: returns `420`

**Test: returns 0 for fresh wallet**

Mock response:
```json
{ "jsonrpc": "2.0", "id": 1, "result": "0x0" }
```

Expected: returns `0`

### 1.6 `getAssetTransfers` (alchemy_getAssetTransfers)

**Test: constructs correct params with hex-encoded maxCount and optional fields**

Input:
```ts
await provider.getAssetTransfers({
  fromBlock: '0x0',
  toBlock: 'latest',
  contractAddresses: ['0xTokenAddr0000000000000000000000000000dead'],
  category: ['erc20'],
  maxCount: 1000,
  toAddress: '0xRecipient000000000000000000000000000face',
});
```

Assert fetch was called with body containing:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "alchemy_getAssetTransfers",
  "params": [{
    "fromBlock": "0x0",
    "toBlock": "latest",
    "contractAddresses": ["0xTokenAddr0000000000000000000000000000dead"],
    "category": ["erc20"],
    "maxCount": "0x3e8",
    "toAddress": "0xRecipient000000000000000000000000000face"
  }]
}
```

Note: `fromAddress` should be absent (not included when undefined).

Mock response:
```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "transfers": [
      {
        "from": "0x0000000000000000000000000000000000000000",
        "to": "0xRecipient000000000000000000000000000face",
        "value": 1000000,
        "asset": "TOKEN",
        "category": "erc20",
        "blockNum": "0xf4240",
        "hash": "0xabc123"
      }
    ]
  }
}
```

Expected: returns array with 1 transfer matching the response.

**Test: omits contractAddresses/fromAddress/toAddress when not provided**

Input:
```ts
await provider.getAssetTransfers({
  fromBlock: '0x0',
  toBlock: 'latest',
  category: ['external'],
  maxCount: 10,
});
```

Assert request body params[0] does NOT contain keys `contractAddresses`, `fromAddress`, `toAddress`.

### 1.7 `call` (eth_call)

**Test: sends correct eth_call params**

Input:
```ts
await provider.call('0xRouterAddress0000000000000000000000000001', '0xd06ca61f...');
```

Assert request body:
```json
{
  "method": "eth_call",
  "params": [{ "to": "0xRouterAddress0000000000000000000000000001", "data": "0xd06ca61f..." }, "latest"]
}
```

Mock response:
```json
{ "jsonrpc": "2.0", "id": 1, "result": "0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000023860e2072000000000000000000000000000000000000000000000000000000008e1bc9bf04000" }
```

Expected: returns the raw hex result string.

### 1.8 Error Handling — RPC Error in Response

**Test: throws on JSON-RPC error response**

Mock response:
```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "execution reverted" } }
```

Expected: throws `Error("RPC error: execution reverted")`

### 1.9 Error Handling — HTTP Error

**Test: throws on non-ok HTTP status**

Mock fetch: returns `Response` with `status: 429`, `ok: false`.

Expected: throws `Error("RPC HTTP error: 429")`

### 1.10 Error Handling — Network Failure with API Key Masking

**Test: masks API key in network error message**

Mock fetch: `throw new Error("fetch failed: connect to https://base-mainnet.g.alchemy.com/v2/my-secret-key-abc123 timed out")`

Provider created with `apiKey = "my-secret-key-abc123"`.

Expected: throws `Error("RPC fetch failed: fetch failed: connect to https://base-mainnet.g.alchemy.com/v2/*** timed out")`

**Test: handles non-Error thrown values**

Mock fetch: `throw "string error"`

Expected: throws `Error("RPC fetch failed: string error")` (no crash on non-Error objects)

### 1.11 Timeout Behavior

**Test: fetch is called with AbortSignal.timeout(5000)**

Assert: the `signal` option passed to `fetch` is an `AbortSignal` with a 5-second timeout. This can be verified by spying on `AbortSignal.timeout` or by inspecting the `signal` property in the fetch mock.

---

## 2. dexscreener.ts — `getTokenPairs`

### 2.1 SSRF / Address Validation

**Test: rejects non-hex address (path traversal attempt)**

Input: `getTokenPairs('base', '../../../etc/passwd')`

Expected: throws `Error("Invalid token address")`

**Test: rejects address without 0x prefix**

Input: `getTokenPairs('base', 'aabbccdd00112233aabbccdd00112233aabbccdd')`

Expected: throws `Error("Invalid token address")`

**Test: rejects address with wrong length**

Input: `getTokenPairs('base', '0xaabb')`

Expected: throws `Error("Invalid token address")`

**Test: rejects address with non-hex characters**

Input: `getTokenPairs('base', '0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ')`

Expected: throws `Error("Invalid token address")`

### 2.2 Successful Response — Full Data

**Test: parses complete DEXScreener response for Base chain**

Input: `getTokenPairs('base', '0xTokenAddr0000000000000000000000000000dead')`

Assert fetch URL: `https://api.dexscreener.com/latest/dex/tokens/0xTokenAddr0000000000000000000000000000dead`

Mock response (200 OK):
```json
{
  "pairs": [
    {
      "chainId": "base",
      "dexId": "aerodrome",
      "pairAddress": "0xPairAddr",
      "baseToken": { "address": "0xTokenAddr0000000000000000000000000000dead", "name": "TestToken", "symbol": "TEST" },
      "quoteToken": { "address": "0x4200000000000000000000000000000000000006", "name": "WETH", "symbol": "WETH" },
      "priceUsd": "0.00042",
      "volume": { "h24": 125000.50 },
      "pairCreatedAt": 1712400000000,
      "priceChange": { "h24": -12.5 },
      "liquidity": { "usd": 50000 }
    },
    {
      "chainId": "ethereum",
      "dexId": "uniswap",
      "pairAddress": "0xOtherPair",
      "baseToken": { "address": "0xTokenAddr0000000000000000000000000000dead", "name": "TestToken", "symbol": "TEST" },
      "quoteToken": { "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "name": "WETH", "symbol": "WETH" },
      "priceUsd": "0.00041",
      "volume": { "h24": 80000 },
      "pairCreatedAt": 1712300000000,
      "priceChange": { "h24": -8.2 },
      "liquidity": { "usd": 30000 }
    }
  ]
}
```

Expected (only the Base pair is used, Ethereum pair filtered out):
```ts
{
  price_usd: 0.00042,
  volume_24h: 125000.50,
  pair_age_hours: /* (Date.now() - 1712400000000) / 3600000, rounded to 2 decimal places */,
  price_change_24h_pct: -12.5,
}
```

Setup: mock `Date.now()` to return `1712443200000` (12 hours after pair creation).

Expected `pair_age_hours`: `12.0`

### 2.3 Non-OK HTTP Response

**Test: returns null MarketData on HTTP error**

Mock fetch: returns `Response` with `status: 500`, `ok: false`.

Expected:
```ts
{
  price_usd: null,
  volume_24h: null,
  pair_age_hours: null,
  price_change_24h_pct: null,
}
```

### 2.4 Null Pairs in Response

**Test: handles response with `pairs: null`**

Mock response (200 OK):
```json
{ "pairs": null }
```

Expected: returns all-null `MarketData`.

### 2.5 Empty Pairs After Chain Filtering

**Test: returns null MarketData when no pairs match the requested chain**

Mock response (200 OK):
```json
{
  "pairs": [
    {
      "chainId": "solana",
      "dexId": "raydium",
      "pairAddress": "0xSolPair",
      "baseToken": { "address": "0xTokenAddr0000000000000000000000000000dead", "name": "T", "symbol": "T" },
      "quoteToken": { "address": "0xSOL", "name": "SOL", "symbol": "SOL" },
      "priceUsd": "1.00",
      "volume": { "h24": 999 },
      "pairCreatedAt": 1712000000000,
      "priceChange": { "h24": 5 },
      "liquidity": { "usd": 10000 }
    }
  ]
}
```

Input chain: `'base'`

Expected: returns all-null `MarketData`.

### 2.6 Null Fields in Pair Data

**Test: handles pair with all nullable fields as null**

Mock response (200 OK):
```json
{
  "pairs": [
    {
      "chainId": "base",
      "dexId": "aerodrome",
      "pairAddress": "0xPair",
      "baseToken": { "address": "0xTokenAddr0000000000000000000000000000dead", "name": "T", "symbol": "T" },
      "quoteToken": { "address": "0xWETH", "name": "WETH", "symbol": "WETH" },
      "priceUsd": null,
      "volume": null,
      "pairCreatedAt": null,
      "priceChange": null,
      "liquidity": null
    }
  ]
}
```

Expected:
```ts
{
  price_usd: null,
  volume_24h: null,
  pair_age_hours: null,
  price_change_24h_pct: null,
}
```

### 2.7 Pair Age Calculation Precision

**Test: pair age is rounded to 2 decimal places**

Mock pair with `pairCreatedAt: 1712400000000`. Mock `Date.now()` to return `1712407333333` (2.037 hours later).

Raw hours: `(1712407333333 - 1712400000000) / 3600000 = 2.03703703...`

Expected `pair_age_hours`: `2.04` (Math.round(2.037... * 100) / 100)

### 2.8 Timeout

**Test: fetch is called with AbortSignal.timeout(5000)**

Assert fetch options include signal with 5-second timeout.

---

## 3. explorer.ts — `checkSourceVerified`

### 3.1 SSRF / Address Validation

**Test: rejects non-hex address**

Input: `checkSourceVerified('base', 'DROP TABLE;', 'apikey')`

Expected: throws `Error("Invalid token address")`

**Test: rejects URL-encoded address**

Input: `checkSourceVerified('base', '0x%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00', 'apikey')`

Expected: throws `Error("Invalid token address")`

### 3.2 URL Selection

**Test: uses Basescan URL for "base" chain**

Input: `checkSourceVerified('base', '0xTokenAddr0000000000000000000000000000dead', 'my-api-key')`

Assert fetch URL: `https://api.basescan.org/api?module=contract&action=getsourcecode&address=0xTokenAddr0000000000000000000000000000dead&apikey=my-api-key`

**Test: uses Etherscan URL for "ethereum" chain**

Input: `checkSourceVerified('ethereum', '0xTokenAddr0000000000000000000000000000dead', 'my-api-key')`

Assert fetch URL: `https://api.etherscan.io/api?module=contract&action=getsourcecode&address=0xTokenAddr0000000000000000000000000000dead&apikey=my-api-key`

### 3.3 Verified Contract

**Test: returns verified=true with no flags for verified source**

Mock response (200 OK):
```json
{
  "status": "1",
  "result": [{ "SourceCode": "pragma solidity ^0.8.0; contract Token { ... }" }]
}
```

Expected:
```ts
{ verified: true, flags: [] }
```

### 3.4 Unverified Contract — Status Not "1"

**Test: returns verified=false with flag when status is "0"**

Mock response (200 OK):
```json
{
  "status": "0",
  "result": [{ "SourceCode": "" }]
}
```

Expected:
```ts
{
  verified: false,
  flags: [{
    severity: 'high',
    type: 'unverified_source',
    value: true,
    detail: 'Contract source code is not verified',
  }],
}
```

### 3.5 Unverified Contract — Empty SourceCode

**Test: returns verified=false when status is "1" but SourceCode is empty**

Mock response (200 OK):
```json
{
  "status": "1",
  "result": [{ "SourceCode": "" }]
}
```

Expected: `verified: false` with `unverified_source` flag.

### 3.6 Unverified Contract — Empty Result Array

**Test: returns verified=false when result array is empty**

Mock response (200 OK):
```json
{
  "status": "1",
  "result": []
}
```

Expected: `verified: false` with `unverified_source` flag.

### 3.7 HTTP Error Response

**Test: returns unverified with HTTP-status detail on non-ok response**

Mock fetch: `status: 429`, `ok: false`.

Expected:
```ts
{
  verified: false,
  flags: [{
    severity: 'high',
    type: 'unverified_source',
    value: true,
    detail: 'Source verification check failed (HTTP 429)',
  }],
}
```

### 3.8 Network / Timeout Error

**Test: returns unverified on fetch exception (e.g. timeout)**

Mock fetch: `throw new DOMException("The operation was aborted", "AbortError")`

Expected:
```ts
{
  verified: false,
  flags: [{
    severity: 'high',
    type: 'unverified_source',
    value: true,
    detail: 'Could not check source verification (API error)',
  }],
}
```

### 3.9 Timeout Configuration

**Test: fetch is called with AbortSignal.timeout(5000)**

Assert fetch options include signal with 5-second timeout.

---

## 4. simulation.ts — `simulateTrade`

### 4.1 Helper Functions (export these or test via integration)

#### `padAddress`

**Test: pads 0x-prefixed address to 64-char hex**
```
Input:  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
Output: "000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
```

**Test: pads short address**
```
Input:  "0x4200000000000000000000000000000000000006"
Output: "0000000000000000000000004200000000000000000000000000000000000006"
```

#### `padUint256`

**Test: pads BUY_AMOUNT_WEI (0.01 ETH = 10^16)**
```
Input:  10000000000000000n
Output: "000000000000000000000000000000000000000000000000002386f26fc10000"
```

**Test: pads zero**
```
Input:  0n
Output: "0000000000000000000000000000000000000000000000000000000000000000"
```

**Test: pads 1**
```
Input:  1n
Output: "0000000000000000000000000000000000000000000000000000000000000001"
```

#### `encodeGetAmountsOut` (Uniswap V2)

**Test: encodes getAmountsOut(0.01 ETH, [WETH_BASE, TOKEN])**

Input:
```
amountIn = 10000000000000000n (0.01 ETH)
path = ["0x4200000000000000000000000000000000000006", "0xTokenAddr0000000000000000000000000000dead"]
```

Expected output (concatenated, no 0x prefix spaces for readability):
```
0xd06ca61f                                                         // selector
000000000000000000000000000000000000000000000000002386f26fc10000     // amountIn
0000000000000000000000000000000000000000000000000000000000000040     // offset (64)
0000000000000000000000000000000000000000000000000000000000000002     // path length
0000000000000000000000004200000000000000000000000000000000000006     // WETH
000000000000000000000000tokenaddr0000000000000000000000000000dead     // token
```

Full hex string:
```
0xd06ca61f000000000000000000000000000000000000000000000000002386f26fc100000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000200000000000000000000000042000000000000000000000000000000000000060000000000000000000000000tokenaddr0000000000000000000000000000dead
```

Note: lowercase hex in addresses after padding.

#### `encodeAerodromeGetAmountsOut`

**Test: encodes getAmountsOut for Aerodrome router**

Input:
```
amountIn = 10000000000000000n
from = "0x4200000000000000000000000000000000000006" (WETH Base)
to = "0xTokenAddr0000000000000000000000000000dead"
stable = false
factory = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da"
```

Expected output:
```
0x5509a1ac                                                         // selector
000000000000000000000000000000000000000000000000002386f26fc10000     // amountIn
0000000000000000000000000000000000000000000000000000000000000040     // offset (64)
0000000000000000000000000000000000000000000000000000000000000001     // routes array length (1)
0000000000000000000000004200000000000000000000000000000000000006     // from (WETH)
000000000000000000000000tokenaddr0000000000000000000000000000dead     // to (token)
0000000000000000000000000000000000000000000000000000000000000000     // stable = false
000000000000000000000000420dd381b31aef6683db6b902084cb0ffece40da     // factory
```

**Test: encodes stable = true correctly**

Same as above but with `stable = true`. The stable field should be:
```
0000000000000000000000000000000000000000000000000000000000000001
```

#### `decodeAmountsOut`

**Test: decodes Uniswap V2 response (2 amounts)**

Input hex (with 0x prefix):
```
0x
0000000000000000000000000000000000000000000000000000000000000020   // offset to array
0000000000000000000000000000000000000000000000000000000000000002   // length = 2
000000000000000000000000000000000000000000000000002386f26fc10000   // amount[0] = 0.01 ETH
00000000000000000000000000000000000000000000d3c21bcecceda1000000   // amount[1] = 1000000000000000000000000
```

Expected: `[10000000000000000n, 1000000000000000000000000n]`

**Test: decodes single amount**

Input (length = 1):
```
0x
0000000000000000000000000000000000000000000000000000000000000020
0000000000000000000000000000000000000000000000000000000000000001
000000000000000000000000000000000000000000000000002386f26fc10000
```

Expected: `[10000000000000000n]`

### 4.2 `getRouterAddress`

**Test: returns Uniswap V2 router for ethereum**
```
Input:  ("uniswap_v2", "ethereum")
Output: "0x7a250d5C2e172789FaA508100449C43e80D7c5ac"
```

**Test: returns null for Uniswap V2 on base (not deployed)**
```
Input:  ("uniswap_v2", "base")
Output: null
```

**Test: returns Aerodrome router for base**
```
Input:  ("aerodrome", "base")
Output: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"
```

**Test: returns null for Aerodrome on ethereum (doesn't exist)**
```
Input:  ("aerodrome", "ethereum")
Output: null
```

**Test: returns null for Uniswap V3 (any chain, not supported)**
```
Input:  ("uniswap_v3", "ethereum")
Output: null
```

**Test: returns null for unknown dex**
```
Input:  ("sushiswap", "ethereum")
Output: null
```

### 4.3 `simulateTrade` — Full Integration Scenarios

For all simulateTrade tests, mock `provider.call()` (the AlchemyProvider instance). Use `chain = 'base'`, `dex = 'aerodrome'`, `tokenAddress = '0xTokenAddr0000000000000000000000000000dead'`, `poolAddress = '0xPoolAddr'` unless noted otherwise.

#### Scenario A: Successful round-trip, low tax (< DEX fee threshold)

**Test: clean token with ~0.6% round-trip loss (DEX fee only, no token tax)**

Mock `provider.call` responses:

Call 1 (buy simulation — `encodeAerodromeGetAmountsOut(0.01 ETH, WETH, token, false, factory)`):
Return ABI-encoded `[10000000000000000, 42000000000000000000000]` (0.01 ETH in, 42000 tokens out)

```
0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000002386f26fc10000000000000000000000000000000000000000000000000008e1bc9bf04000000000
```

Adjust the second amount: tokens out = `42000000000000000000000n`

Call 2 (sell simulation — `encodeAerodromeGetAmountsOut(42000..., token, WETH, false, factory)`):
Return ABI-encoded `[42000000000000000000000, 9940000000000000]` (tokens in, ~0.9940 ETH back)

```
0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000008e1bc9bf040000000000000000000000000000000000000000000000000000000234FCFBF8A0C00
```

`wethBack = 9940000000000000n`

Tax calculation:
- `roundTripTaxPct = (10000000000000000 - 9940000000000000) / 10000000000000000 * 100 = 0.6%`
- `tokenTaxTotal = max(0, 0.6 - 0.6) = 0.0`
- `buyTaxPct = 0.0`, `sellTaxPct = 0.0`

Expected:
```ts
{
  data: {
    buy_tax_pct: 0,
    sell_tax_pct: 0,
    can_sell: true,
    simulation_method: 'getAmountsOut_roundtrip',
  },
  flags: [],
}
```

#### Scenario B: High sell tax (>10%) triggers flags

**Test: token with ~20% round-trip loss triggers high_sell_tax AND asymmetric_tax**

Mock responses:
- Buy: 0.01 ETH in → 42000 tokens out (same as A)
- Sell: 42000 tokens in → 8000000000000000 (0.008 ETH back)

`wethBack = 8000000000000000n`

Tax calculation:
- `roundTripTaxPct = (10000000000000000 - 8000000000000000) / 10000000000000000 * 100 = 20.0%`
- `tokenTaxTotal = max(0, 20.0 - 0.6) = 19.4`
- `buyTaxPct = round(19.4 * 0.1 * 100) / 100 = 1.94`
- `sellTaxPct = round(19.4 * 0.9 * 100) / 100 = 17.46`
- `sellTaxPct > 10` → flag `high_sell_tax`
- `sellTaxPct - buyTaxPct = 15.52 > 5` → flag `asymmetric_tax`

Expected:
```ts
{
  data: {
    buy_tax_pct: 1.94,
    sell_tax_pct: 17.46,
    can_sell: true,
    simulation_method: 'getAmountsOut_roundtrip',
  },
  flags: [
    { severity: 'high', type: 'high_sell_tax', value: 17.46, detail: 'Estimated sell tax is 17.5%' },
    { severity: 'high', type: 'asymmetric_tax', value: 15.52, detail: 'Sell tax (17.5%) significantly exceeds buy tax (1.9%)' },
  ],
}
```

#### Scenario C: Honeypot — sell reverts

**Test: sell simulation throws (reverted) → honeypot_cant_sell flag**

Mock responses:
- Buy: 0.01 ETH in → 42000 tokens out (succeeds)
- Sell: `throw new Error("execution reverted")`

Expected:
```ts
{
  data: {
    buy_tax_pct: null,
    sell_tax_pct: null,
    can_sell: false,
    simulation_method: 'getAmountsOut_roundtrip',
  },
  flags: [
    { severity: 'critical', type: 'honeypot_cant_sell', value: true, detail: 'Sell simulation reverted — token may be a honeypot' },
  ],
}
```

#### Scenario D: Buy simulation reverts

**Test: buy simulation throws → returns skipped (graceful)**

Mock responses:
- Buy: `throw new Error("execution reverted")`

Expected:
```ts
{
  data: {
    buy_tax_pct: null,
    sell_tax_pct: null,
    can_sell: null,
    simulation_method: 'skipped',
  },
  flags: [],
}
```

#### Scenario E: Buy returns zero tokens

**Test: tokensOut = 0 → returns skipped**

Mock responses:
- Buy: returns ABI-encoded `[10000000000000000, 0]`

```
0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000002386f26fc100000000000000000000000000000000000000000000000000000000000000000000
```

Expected: skipped result (same as Scenario D).

#### Scenario F: Unsupported DEX

**Test: uniswap_v3 → returns skipped**

Input: `dex = 'uniswap_v3'`

Expected: skipped result. `provider.call` should NOT be called.

**Test: unknown DEX → returns skipped**

Input: `dex = 'pancakeswap'`

Expected: skipped result. `provider.call` should NOT be called.

#### Scenario G: Uniswap V2 on Ethereum

**Test: uses Uniswap V2 encoding (not Aerodrome) on ethereum**

Input: `chain = 'ethereum'`, `dex = 'uniswap_v2'`

Assert provider.call is called with:
- Router: `0x7a250d5C2e172789FaA508100449C43e80D7c5ac`
- Buy calldata uses `encodeGetAmountsOut` (selector `0xd06ca61f`) NOT `encodeAerodromeGetAmountsOut`
- WETH address: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`

Mock both buy and sell to succeed. Verify same tax calculation logic applies.

#### Scenario H: Moderate tax (sell > 5% above buy, but sell < 10%)

**Test: asymmetric_tax flag fires even when sell tax is below 10%**

Mock: round-trip loss = 7.6%
- `tokenTaxTotal = 7.6 - 0.6 = 7.0`
- `buyTaxPct = round(7.0 * 0.1 * 100) / 100 = 0.7`
- `sellTaxPct = round(7.0 * 0.9 * 100) / 100 = 6.3`
- `sellTaxPct - buyTaxPct = 5.6 > 5` → flag `asymmetric_tax`
- `sellTaxPct = 6.3 < 10` → NO `high_sell_tax` flag

Need `wethBack` such that round-trip loss = 7.6%:
- `wethBack = 10000000000000000 * (1 - 0.076) = 9240000000000000n`

Expected: exactly 1 flag (`asymmetric_tax`), NOT `high_sell_tax`.

---

## Testing Infrastructure Notes

### Mocking Strategy

All tests mock `global.fetch`. Pattern:

```ts
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

test('example', async () => {
  const fetchMock = mock.fn(async (url: string, init?: RequestInit) => {
    // Assert on url and init.body
    const body = JSON.parse(init?.body as string);
    assert.strictEqual(body.method, 'eth_getCode');

    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: '0x6080604052',
    }), { status: 200 });
  });

  mock.method(globalThis, 'fetch', fetchMock);

  // ... test code ...

  mock.restoreAll();
});
```

### For `simulation.ts` tests

Mock `AlchemyProvider.prototype.call` rather than global fetch, since `simulateTrade` receives a provider instance:

```ts
const provider = new AlchemyProvider('test-key', 'base');
let callCount = 0;
mock.method(provider, 'call', async (to: string, data: string) => {
  callCount++;
  if (callCount === 1) {
    // buy simulation response
    return '0x...';
  }
  // sell simulation response
  return '0x...';
});
```

### For `dexscreener.ts` pair age tests

Mock `Date.now()` to control time:

```ts
mock.method(Date, 'now', () => 1712443200000);
```

### Test File Structure

```
test/
├── providers/
│   ├── alchemy.test.ts
│   ├── dexscreener.test.ts
│   ├── explorer.test.ts
│   └── simulation.test.ts
```

### Helper Exports

The helper functions in `simulation.ts` (`padAddress`, `padUint256`, `encodeGetAmountsOut`, `encodeAerodromeGetAmountsOut`, `decodeAmountsOut`, `getRouterAddress`) are not currently exported. Two options:
1. **Preferred:** Export them and test directly
2. **Alternative:** Test indirectly via `simulateTrade` by asserting the calldata passed to `provider.call`

### Total Test Count

| Module | Tests |
|--------|-------|
| alchemy.ts | 14 |
| dexscreener.ts | 9 |
| explorer.ts | 9 |
| simulation.ts | 19 |
| **Total** | **51** |
