# Rug Scanner

On-chain token risk analysis API with x402 micropayments. Agents pay $0.05 USDC per scan.

**Live:** https://rug-scanner-production.up.railway.app
**Repo:** https://github.com/LucianoLupo/rug-scanner

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
│   ├── alchemy.ts        # JSON-RPC client (eth_call, eth_getBalance, etc.)
│   ├── dexscreener.ts    # Price, volume, pair data
│   ├── explorer.ts       # Basescan/Etherscan source verification
│   └── simulation.ts     # Buy/sell tax simulation via router getAmountsOut
├── cache/
│   └── redis.ts          # Upstash Redis (get/set with TTL)
└── types/
    ├── index.ts          # All types: Env, ScanResult, Flag, Verdict, Chain, etc.
    └── evmole.d.ts       # EVMole type declarations
```

## Key Design Decisions

- **No third-party risk APIs** — GoPlus and Honeypot.is ToS prohibit commercial resale. All analysis is our own on-chain queries via Alchemy RPCs.
- **Threshold-based verdicts, no weighted scores** — Deterministic cascade logic, no magic numbers. Easy to debug and calibrate.
- **No LLM in the scan path** — Purely deterministic analysis. Fast, cheap, predictable.
- **Aerodrome support** — Base's primary DEX. Most Base tokens use Aerodrome, not Uniswap.
- **Graceful degradation** — Promise.allSettled for all provider calls. Failed checks lower confidence but don't block response.
- **x402 passthrough if keys missing** — Local dev works without payment gate.

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
5. USDC lands in our wallet, scan executes, response returned

Auth: CDP API keys → EdDSA JWT → Bearer token per facilitator request.

## Chains Supported

- **Base** (eip155:8453) — primary, Aerodrome + Uniswap V2/V3
- **Ethereum** (eip155:1) — Uniswap V2/V3

## Environment Variables

All in `.env` (local) or Railway dashboard (production). See `.env.example`.

## Common Tasks

### Run locally
```bash
npm run dev
```

### Deploy
```bash
railway up
```

### Type check
```bash
npm run typecheck
```

### Run tests
```bash
npm test
```

### Add a new analysis check
1. Add to relevant file in `src/analysis/`
2. Return flags with severity + type + value + detail
3. Add threshold logic to `src/analysis/scorer.ts` if it's a new verdict trigger
4. Add to the parallel analysis batch in `src/index.ts`

### Add a new chain
1. Add chain to `Chain` type in `src/types/index.ts`
2. Add Zod enum value in `src/index.ts`
3. Add RPC URL mapping in `src/providers/alchemy.ts`
4. Add factory addresses in `src/analysis/liquidity.ts`
5. Add lock contract addresses for the chain

## Known Limitations

- Holder analysis is approximate (samples last 1000 Transfer events, not exhaustive)
- LP lock detection only checks known providers (UNCX, Team Finance)
- Stablecoins (USDC, USDT) may flag as HIGH_RISK (non-renounced ownership, no standard LP)
- Buy/sell simulation uses getAmountsOut (doesn't catch whitelist-based honeypots)
- No Solana support yet
