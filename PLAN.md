# Rug Scanner — Build Plan (v3 — Final, Post Double Audit)

**Goal:** x402-gated token risk analysis API. Agents pay per-call to check if a token is a scam.

**Monetization:** Per-call via x402 ($0.05/scan). Stripe deferred to V2.

**Timeline:** 12-14 days realistic. Go/no-go on Day 5 for buy/sell simulation.

**Key decisions:**
- All analysis is our own on-chain queries (no GoPlus, no Honeypot.is — ToS prohibits resale)
- One endpoint, one price, threshold-based verdicts (no weighted scores)
- No LLM summary in MVP (adds latency + liability, agents don't read prose)
- Base + Ethereum only (Solana deferred)
- Must support Aerodrome (Base's main DEX, not just Uniswap)

---

## Architecture

```
Agent: POST /scan { token: "0x1234", chain: "base" }
    ↓
x402 middleware: 402 Payment Required ($0.05)
    ↓ agent pays → USDC lands in our wallet (~2s)
Parallel on-chain queries via Alchemy RPCs:
    ├── Contract bytecode → function selectors (EVMole) → mint/blacklist/pause/proxy
    ├── Storage reads → owner, admin, proxy implementation slot
    ├── Top holders → sample from recent Transfer events (last 1000)
    ├── Liquidity pools → Uniswap V2/V3 + Aerodrome factory queries
    └── Deployer → wallet age, tx count, ETH balance
Plus:
    ├── DEXScreener API (free, commercial OK) → price, volume, pair age
    ├── Basescan/Etherscan API (free) → source verification
    └── Buy/sell simulation → eth_call through router (if working by Day 5)
    ↓
Threshold-based scoring (deterministic, no LLM, no magic weights):
    if (cant_sell) → CRITICAL
    if (deployer_majority || lp_unlocked_low_liq) → HIGH_RISK
    if (mint + blacklist) → HIGH_RISK
    ...
    ↓
Response: { score, verdict, confidence, flags[], data, disclaimer }
```

---

## Scoring: Threshold-Based Verdicts (No Weights)

```typescript
function getVerdict(flags: Flag[]): Verdict {
  // CRITICAL — definite scam signals
  if (flags.has("honeypot_cant_sell")) return "CRITICAL";
  if (flags.has("deployer_holds_majority") && flags.has("lp_unlocked")) return "CRITICAL";

  // HIGH_RISK — strong rug indicators
  if (flags.has("deployer_holds_majority") || flags.has("lp_unlocked_low_liquidity")) return "HIGH_RISK";
  if (flags.has("can_mint") && flags.has("can_blacklist")) return "HIGH_RISK";
  if (flags.has("asymmetric_tax")) return "HIGH_RISK";

  // MEDIUM_RISK — concerning but not definitive
  if (flags.has("unverified_source") && flags.has("is_proxy")) return "MEDIUM_RISK";
  if (flags.count >= 3) return "MEDIUM_RISK";

  // LOW_RISK — minor flags
  if (flags.count >= 1) return "LOW_RISK";

  // SAFE — no flags triggered
  return "SAFE";
}

// Confidence = checks_completed / total_possible_checks
// If a provider is down or RPC fails, confidence drops but we still return a result
```

Why this over weighted scores:
- Clear logic, no magic numbers
- Easy to debug ("it's HIGH_RISK because deployer holds 60% and LP is unlocked")
- Agents understand the verdict immediately
- Can be calibrated after Day 8 testing without restructuring

---

## What We Check (All Our Own Analysis)

### Contract Analysis (via bytecode + storage reads)
| Check | Method | Red Flag | Difficulty |
|-------|--------|----------|-----------|
| Mint function | EVMole selector extraction → match against 4byte.directory | Owner can inflate supply | Medium |
| Blacklist function | Same | Owner can freeze wallets | Medium |
| Pause function | Same | Owner can halt trading | Medium |
| Proxy pattern | Read EIP-1967 storage slots (`0x3608...bbc`) | Contract upgradeable | Easy |
| Ownership | Read `owner()` or Ownable storage | Not renounced = centralized | Easy |
| Hidden fee setter | Check for `setFee()`, `setTax()` selectors | Owner can change tax | Medium |
| Source verified | Basescan/Etherscan API | Can't audit unverified code | Easy |

**Known limitations:**
- Obfuscated function names (different selector hashes) → false negatives
- Internal functions not in ABI → invisible to selector extraction
- Assembly/low-level calls → bypass standard detection
- **Mitigation:** Weight "unverified_source" heavily. If we can't read the code, score higher risk.

### Holder Analysis (via Transfer events + balanceOf)
| Check | Method | Red Flag |
|-------|--------|----------|
| Top 5 holder % | Sample last 1000 Transfer events → balanceOf top addresses | >50% = extreme concentration |
| Top 10 holder % | Same | >80% = insider-controlled |
| Deployer holdings | balanceOf(deployer) | >10% = still in control |
| Holder count | Approximate from Transfer event unique addresses | <100 = very early |

**Strategy:** Sample last 1000 Transfer events (Alchemy `getAssetTransfers`), extract unique addresses, query balanceOf for top ones. This is approximate but handles most tokens. Document limitation in response: "Top holders estimated from recent transfers."

**Alternative for V2:** Use The Graph for accurate holder data (free, commercial OK).

### Liquidity Analysis
| Check | Method | Red Flag |
|-------|--------|----------|
| Pool discovery | Query Uniswap V2/V3 Factory + **Aerodrome Factory** on Base | — |
| Total liquidity (USD) | Pool reserves × DEXScreener price | <$10K = easy to rug |
| LP locked? | Check balanceOf on known lock contracts (UNCX, Team Finance, Unilocker) | Unlocked = can pull |
| Lock duration | Read lock contract expiry | <30 days = short |
| Pool age | First swap event or DEXScreener pair creation | <24h = brand new |

**Known lock contract addresses (whitelist):**
- UNCX: `0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214`
- Team Finance, Unilocker, Unvest — research exact addresses during build
- **Limitation:** Custom lock contracts not detected. Document in response.

**Aerodrome (Base):** Most Base tokens use Aerodrome, not Uniswap. Must query Aerodrome factory for pool discovery. Different router address for simulation.

### Deployer Analysis
| Check | Method | Red Flag |
|-------|--------|----------|
| Wallet age | First tx timestamp | <7 days = fresh |
| Tx count | getTransactionCount | Low count = disposable wallet |
| ETH balance | getBalance | Near-zero after deploy = dumped |
| Previous tokens | Scan for contract creation txs (CREATE opcode events) | Multiple = serial deployer |

### Buy/Sell Simulation (Go/No-Go Day 5)
| Check | Method | Red Flag |
|-------|--------|----------|
| Can sell? | eth_call simulate sell via router | Reverts = honeypot |
| Buy tax | Simulate buy, compare input vs output | High tax |
| Sell tax | Simulate sell, compare input vs output | Higher than buy = honeypot pattern |
| Tax asymmetry | Compare buy vs sell tax | >5% difference = red flag |

**Implementation:**
1. Detect which DEX has the pool (Uniswap V2, V3, or Aerodrome)
2. Construct swap calldata for that router
3. `eth_call` with a simulated address (not msg.sender — catches whitelist honeypots)
4. If reverts → honeypot. If succeeds → calculate tax from output amounts.

**Known limitations:**
- Whitelist-based honeypots that only allow specific addresses → partially caught (we simulate as random address)
- Block-dependent logic (time-locked sells) → not caught
- Custom DEX routers → not caught in MVP
- **If this isn't working by Day 5, ship without it.** Set `confidence` lower and add it in V2.

### Market Data (DEXScreener — free, commercial OK)
| Check | What | Red Flag |
|-------|------|----------|
| Price | Current USD price | Context |
| 24h volume | Trading volume | <$1K = dead |
| Pair age | When pool was created | <24h = very new |
| Price change | 24h % change | >500% = pump phase |

---

## Single Endpoint

### `POST /scan` — $0.05

**Request:**
```json
{ "token": "0x1234...5678", "chain": "base" }
```

**Response:**
```json
{
  "score": 4,
  "verdict": "HIGH_RISK",
  "confidence": 0.85,
  "flags": [
    { "severity": "critical", "type": "top5_holders_above_50", "value": "84.2%", "detail": "Top 5 wallets hold 84.2% of supply (sampled from recent transfers)" },
    { "severity": "high", "type": "lp_unlocked", "value": true, "detail": "LP tokens not found in known lock contracts" },
    { "severity": "medium", "type": "deployer_fresh_wallet", "value": "3 days", "detail": "Deployer wallet created 3 days ago" }
  ],
  "data": {
    "contract": { "verified": false, "can_mint": true, "can_blacklist": false, "can_pause": false, "is_proxy": false, "owner_renounced": false },
    "holders": { "total_approx": 342, "top5_pct": 84.2, "top10_pct": 91.5, "deployer_pct": 12.3, "method": "sampled_last_1000_transfers" },
    "liquidity": { "total_usd": 8200, "lp_locked": false, "lock_provider": null, "pool_age_hours": 48, "dex": "aerodrome" },
    "deployer": { "age_days": 3, "tx_count": 12, "eth_balance": 0.02 },
    "trading": { "buy_tax_pct": 2.0, "sell_tax_pct": 2.0, "can_sell": true, "simulation_method": "eth_call_aerodrome_router" },
    "market": { "price_usd": 0.00023, "volume_24h": 4500, "pair_age_hours": 48, "price_change_24h_pct": 180 }
  },
  "checks_completed": 17,
  "checks_total": 20,
  "disclaimer": "Risk assessment only. Not financial advice. May contain errors. DYOR.",
  "scanned_at": "2026-04-06T14:00:00Z"
}
```

**Score = flag count** (simple, transparent). Verdict from threshold logic above.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | TypeScript + Hono | @x402/hono exists, edge-ready |
| Deploy | Cloudflare Workers (paid $5/mo) | 50ms CPU, global edge. Free tier risky (10ms CPU limit) |
| x402 | `@x402/hono` middleware | Official SDK. Hardcode wallet address. |
| Cache | Upstash Redis (~$5/mo) | Real-time consistency (not KV's 60s delay) |
| RPC | Alchemy free tier (300M CU/mo) | Base + Ethereum. ~100K scans/mo budget |
| Market data | DEXScreener API (free) | Price, volume, pairs. Commercial use OK |
| Explorer | Basescan/Etherscan API (free, 5 calls/sec) | Source verification |
| Bytecode | EVMole library | Function selector extraction from unverified contracts |
| MCP | Separate Node.js bridge (~50 lines) | Calls our Workers API via @x402/axios |

### Cost Per Scan
| Component | Cost |
|-----------|------|
| Alchemy RPC (~8 calls) | ~$0.001 |
| DEXScreener | $0.00 |
| Basescan API | $0.00 |
| Upstash Redis | ~$0.0001 |
| Cloudflare Workers | ~$0.000005 |
| **Total** | **~$0.001** |
| **Revenue at $0.05** | **98% margin** |

(No LLM cost in MVP — purely deterministic analysis)

---

## Implementation (12-14 Days)

### Day 0: Setup (Before Coding)
- [ ] Create Coinbase Developer Platform account, get CDP API keys
- [ ] Create Base wallet (MetaMask), note USDC receive address
- [ ] Get Alchemy API key (free tier)
- [ ] Get Basescan API key (free tier)
- [ ] Create Upstash Redis instance ($5/mo)
- [ ] Sign up for Cloudflare Workers paid plan ($5/mo)

### Day 1-2: Scaffolding + x402
- [ ] Init Hono + TypeScript project
- [ ] @x402/hono middleware with **testnet** facilitator (`https://x402.org/facilitator`)
- [ ] Zod input validation (hex address regex, chain enum: base | ethereum)
- [ ] Upstash Redis connection
- [ ] Deploy skeleton to Cloudflare Workers
- [ ] **Test x402 payment flow end-to-end on testnet** (this is the learning curve)

### Day 3-4: Core Analysis Engine
- [ ] Contract bytecode analyzer: EVMole for selector extraction, check mint/blacklist/pause
- [ ] Proxy detection: read EIP-1967 storage slots
- [ ] Ownership check: read owner() storage
- [ ] Source verification: Basescan/Etherscan API
- [ ] Holder analysis: getAssetTransfers (last 1000) → balanceOf top addresses → concentration
- [ ] Deployer analysis: wallet age, tx count, balance
- [ ] Cache layer: Redis with 30min TTL

### Day 5: Liquidity + Simulation (Go/No-Go)
- [ ] Pool discovery: Uniswap V2/V3 Factory + **Aerodrome Factory** on Base
- [ ] Liquidity read: pool reserves, LP token supply
- [ ] LP lock check: balanceOf on UNCX, Team Finance, Unilocker
- [ ] **Buy/sell simulation via eth_call** — attempt implementation
- [ ] **GO/NO-GO DECISION:** If simulation works → keep it. If not → ship without, add in V2.

### Day 6-7: Scoring + Integration
- [ ] Threshold-based verdict logic (no weights)
- [ ] Confidence calculation (checks_completed / checks_total)
- [ ] DEXScreener integration (price, volume, pair age)
- [ ] Parallel fetching with Promise.allSettled (graceful degradation)
- [ ] Full /scan endpoint wired together
- [ ] Response formatting with disclaimer

### Day 8-9: Testing
- [ ] Find 10 known rug-pulled tokens (Twitter #rugpull, Etherscan phishing list)
- [ ] Find 5 known safe tokens (USDC, WETH, AAVE, UNI, LINK)
- [ ] Find 5 edge cases (new legit token, proxy contract, renounced ownership)
- [ ] Run all 20 through scanner, check verdicts
- [ ] **Target: 70%+ correct on first run.** Tweak thresholds until 80%+
- [ ] Test provider failures: what happens when Alchemy is slow? DEXScreener down?

### Day 10: Deploy to Mainnet
- [ ] Switch facilitator to Coinbase CDP mainnet (`https://api.cdp.coinbase.com/platform/v2/x402`)
- [ ] Set production wallet address
- [ ] Verify first real payment settles to wallet
- [ ] Add `/.well-known/x402.json` discovery file
- [ ] Privacy policy page (wallet address processing, 30-day retention)

### Day 11: MCP + Distribution
- [ ] Create MCP bridge server (separate Node.js, ~50 lines, calls Workers API via @x402/axios)
- [ ] Publish MCP package to npm
- [ ] List on Glama MCP registry
- [ ] List on Smithery MCP registry
- [ ] Submit PR to x402.org/ecosystem

### Day 12: Launch
- [ ] Make first payment to trigger x402 Bazaar auto-indexing
- [ ] Verify service appears in Bazaar
- [ ] X thread: "I built a rug scanner in 12 days — here's what I learned about x402"
- [ ] Monitor first 24h of probes

### Day 13-14: Buffer
- [ ] Fix issues found in first 24h
- [ ] Tweak scoring based on real probe data
- [ ] If simulation didn't make Day 5, attempt again with more time

---

## Legal Checklist
- [ ] Every response includes: `"disclaimer": "Risk assessment only. Not financial advice. May contain errors. DYOR."`
- [ ] Use "HIGH_RISK" / "CRITICAL" verdicts, never "SCAM" (defamation risk)
- [ ] Ground all flags in objective data: "top 5 holders = 84.2%" not "this is a scam"
- [ ] Privacy policy: wallet address processing, 30-day log retention
- [ ] Use Coinbase hosted facilitator only (merchant status, not MSB)
- [ ] No GoPlus data, no Honeypot.is data — all analysis is our own
- [ ] No "SAFE" as guarantee — always pair with disclaimer

---

## V2 Roadmap (After Launch Data)

| Feature | Trigger |
|---------|---------|
| Buy/sell simulation (if cut from MVP) | First priority post-launch |
| Stripe API keys for humans | 50+ human users requesting |
| Batch endpoint (5-50 tokens) | Agents requesting batch |
| Solana chain support | Demand from Solana agents |
| The Graph for accurate holders | Sampling proves insufficient |
| LLM summary (optional ?explain=true) | Humans requesting explanations |
| Deployer deep history (past tokens) | Deployer flags prove valuable |
| Webhook alerts (subscribe to token) | Trading agents want monitoring |
| More DEX routers (Curve, Balancer) | Tokens missed by current routers |

---

## File Structure

```
rug-scanner/
├── src/
│   ├── index.ts                 # Hono app + /scan route
│   ├── middleware/
│   │   └── x402.ts              # x402 payment config (hardcoded wallet)
│   ├── providers/
│   │   ├── alchemy.ts           # EVM RPC: bytecode, balances, events, storage
│   │   ├── dexscreener.ts       # Price, volume, pair data
│   │   ├── explorer.ts          # Basescan/Etherscan source verification
│   │   └── simulation.ts        # Buy/sell tax simulation via eth_call
│   ├── analysis/
│   │   ├── contract.ts          # EVMole selector extraction + flag detection
│   │   ├── holders.ts           # Transfer event sampling + concentration calc
│   │   ├── liquidity.ts         # Pool discovery (Uni V2/V3 + Aerodrome) + LP lock
│   │   ├── deployer.ts          # Wallet age, tx count, balance
│   │   └── scorer.ts            # Threshold-based verdict (no weights)
│   ├── cache/
│   │   └── redis.ts             # Upstash Redis (30min TTL)
│   └── types/
│       └── index.ts             # ScanResult, Flag, Verdict, etc.
├── mcp/
│   └── server.ts                # MCP bridge (separate Node.js process)
├── test/
│   ├── known-rugs.test.ts       # 10 confirmed rug pulls
│   ├── known-safe.test.ts       # 5 major tokens
│   └── edge-cases.test.ts       # 5 edge cases
├── wrangler.toml
├── package.json
├── tsconfig.json
├── .well-known/
│   └── x402.json
├── PLAN.md
├── CLAUDE.md
└── README.md
```

---

## Success Metrics (Month 1)

- [ ] 500+ probes
- [ ] 50+ paid scans
- [ ] Listed on 4+ platforms (Bazaar, Glama, Smithery, x402.org)
- [ ] <2s response time (p95)
- [ ] 80%+ correct verdicts on 20-token test set
- [ ] Zero downtime
- [ ] Revenue: $0-50 (positioning, not profit)
