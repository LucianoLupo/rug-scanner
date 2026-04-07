# Rug Scanner

On-chain token risk analysis API with x402 micropayments. Agents pay $0.05 USDC per scan on Base.

**Live:** https://rug-scanner-production.up.railway.app
**Repo:** https://github.com/LucianoLupo/rug-scanner
**Railway:** https://railway.com/project/27db799d-abe7-4a9b-bfa8-acb9e3cea0bd

## Architecture

```
POST /scan { token, chain }
  → x402 payment gate ($0.05 USDC on Base via CDP facilitator)
  → Parallel on-chain analysis (Alchemy RPCs + DEXScreener + Basescan)
  → Threshold-based scoring (deterministic, no LLM)
  → Redis cache (30min TTL)
  → JSON response with verdict, flags, data
```

Single endpoint, single price. Hono app served via @hono/node-server on Railway.

## Tech Stack

- **Runtime:** TypeScript, Hono, @hono/node-server
- **Payments:** x402 protocol, @x402/hono, CDP facilitator with JWT auth (@coinbase/cdp-sdk)
- **RPC:** Alchemy (Base + Ethereum)
- **Cache:** Upstash Redis
- **Bytecode:** EVMole (function selector extraction)
- **Market data:** DEXScreener API (free, commercial OK)
- **Explorer:** Basescan/Etherscan APIs (source verification)
- **Deploy:** Railway
- **Tests:** Vitest (140 tests, fully mocked, ~500ms)

## Code Organization

```
src/
├── index.ts              # Hono app, /health + /scan routes, parallel analysis orchestration
├── server.ts             # Node.js entry point (@hono/node-server)
├── middleware/
│   └── x402.ts           # x402 payment gate: CDP JWT auth, ExactEvmScheme, Base mainnet
├── analysis/
│   ├── contract.ts       # EVMole bytecode selectors (mint/blacklist/pause/proxy/fee), EIP-1967
│   ├── holders.ts        # Transfer event sampling, top holder concentration, deployer %
│   ├── deployer.ts       # Wallet age, tx count, balance, deployer address discovery
│   ├── liquidity.ts      # Pool discovery (Uni V2/V3 + Aerodrome), reserves, LP lock check
│   └── scorer.ts         # Threshold-based verdicts: CRITICAL → HIGH_RISK → MEDIUM → LOW → SAFE
├── providers/
│   ├── alchemy.ts        # JSON-RPC client (eth_call, eth_getBalance, etc.), key masking
│   ├── dexscreener.ts    # Price, volume, pair data. SSRF validation on addresses
│   ├── explorer.ts       # Basescan/Etherscan source verification. SSRF validation
│   └── simulation.ts     # Buy/sell tax simulation via router getAmountsOut (Uni V2/V3 + Aerodrome)
├── cache/
│   └── redis.ts          # Upstash Redis (get/set with TTL, error handling)
└── types/
    ├── index.ts          # All types: Env, ScanResult, Flag, Verdict, Chain, etc.
    └── evmole.d.ts       # EVMole type declarations

test/
├── known-rugs.test.ts    # 10 rug pattern tests + scorer blindspots
├── known-safe.test.ts    # 5 safe token verdict tests
├── edge-cases.test.ts    # 15 boundary condition + validation tests
├── analysis/
│   ├── contract.test.ts  # 16 tests: bytecode selectors, proxy, ownership
│   ├── holders.test.ts   # 22 tests: concentration, sampling, edge cases
│   ├── deployer.test.ts  # 16 tests: wallet age, tx count, balance
│   └── liquidity.test.ts # 22 tests: pool discovery, LP locks, Aerodrome
├── providers/
│   ├── alchemy.test.ts   # 12 tests: RPC calls, errors, key masking, timeouts
│   ├── dexscreener.test.ts # 11 tests: parsing, SSRF, null handling
│   └── explorer.test.ts  # 9 tests: URL selection, verification, SSRF
├── PLAN-integration.md   # Integration test plan (real tokens, x402 flow)
├── PLAN-analysis.md      # Analysis module test plan
├── PLAN-providers.md     # Provider module test plan
├── AUDIT-coverage-gaps.md # Coverage audit findings
├── AUDIT-plan-quality.md  # Quality audit findings
└── AUDIT-practicality.md  # Practicality audit findings
```

## Key Design Decisions

- **No third-party risk APIs** — GoPlus and Honeypot.is ToS prohibit commercial resale. All analysis is our own on-chain queries via Alchemy RPCs.
- **Threshold-based verdicts, no weighted scores** — Deterministic cascade logic, no magic numbers.
- **No LLM in the scan path** — Purely deterministic analysis. Fast, cheap, predictable.
- **Aerodrome support** — Base's primary DEX. Correct factory selector (0x79bc57d5) and router ABI.
- **Graceful degradation** — Promise.allSettled for all provider calls. Failed checks lower confidence.
- **x402 passthrough if keys missing** — Local dev works without payment gate.
- **Security hardened** — SSRF validation, API key masking, rate limiting (10/sec), 5s timeouts, HTTP status checks.
- **Live ETH price** — Fetched from DEXScreener, not hardcoded. Fallback to $3000.
- **Multi-chain LP locks** — Separate lock contract addresses for Base and Ethereum.
- **Token decimal aware** — Reads decimals() from contract, doesn't assume 1e18.

## Scoring Logic (scorer.ts)

```
if (honeypot_cant_sell) → CRITICAL
if (deployer_majority + lp_unlocked) → CRITICAL
if (deployer_majority || lp_unlocked_low_liquidity) → HIGH_RISK
if (can_mint + can_blacklist) → HIGH_RISK
if (asymmetric_tax) → HIGH_RISK
if (unverified + is_proxy) → MEDIUM_RISK
if (flagCount >= 3) → MEDIUM_RISK
if (flagCount >= 1) → LOW_RISK
else → SAFE
```

Confidence = checks_completed / checks_total.

## x402 Payment Flow

1. Agent POSTs to /scan
2. x402 middleware returns 402 with payment requirements (Base USDC, $0.05)
3. Agent signs USDC payment via EIP-3009
4. CDP facilitator verifies signature + settles on-chain (~2s)
5. USDC lands in wallet, scan executes, response returned

Auth: CDP API keys → EdDSA JWT (generateJwt from @coinbase/cdp-sdk/auth) → Bearer token per facilitator request (verify, settle, supported).

## Chains Supported

- **Base** (eip155:8453) — primary, Aerodrome + Uniswap V2/V3
- **Ethereum** (eip155:1) — Uniswap V2/V3

## Environment Variables

All in `.env` (local) or Railway dashboard (production). See `.env.example`.

Required: ALCHEMY_API_KEY, BASESCAN_API_KEY, ETHERSCAN_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, X402_WALLET_ADDRESS, CDP_API_KEY_ID, CDP_API_KEY_SECRET.

## Common Tasks

### Run locally
```bash
npm run dev
```

### Deploy
```bash
railway up
```

### Run tests
```bash
npm test          # 140 tests, ~500ms
npm run typecheck # tsc --noEmit
```

### Add a new analysis check
1. Add to relevant file in `src/analysis/`
2. Return flags with severity + type + value + detail
3. Add threshold logic to `src/analysis/scorer.ts` if it's a new verdict trigger
4. Add to the parallel analysis batch in `src/index.ts`
5. Write matching tests in `test/analysis/`

### Add a new chain
1. Add chain to `Chain` type in `src/types/index.ts`
2. Add Zod enum value in `src/index.ts`
3. Add RPC URL mapping in `src/providers/alchemy.ts`
4. Add factory addresses in `src/analysis/liquidity.ts`
5. Add lock contract addresses for the chain

## Known Limitations

- Holder analysis is approximate (samples last 1000 Transfer events, not exhaustive)
- LP lock detection only checks known providers (UNCX, Team Finance on Base + Ethereum)
- Stablecoins (USDC, USDT) may flag as HIGH_RISK (non-renounced ownership, no standard LP)
- Buy/sell simulation uses getAmountsOut (doesn't catch whitelist-based honeypots or block-dependent logic)
- No Solana support yet
- x402 Bazaar listing pending (needs first paid transaction to auto-index)
