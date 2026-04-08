# Rug Scanner

On-chain token risk analysis API. Pay-per-scan via x402 (USDC on Base).

**Live:** https://rug-scanner-production.up.railway.app

## Endpoints

```
GET  /                             → Landing page (HTML) or API info (JSON)
GET  /health                       → 200 {"status":"ok"}
POST /scan                         → 402 Payment Required ($0.05 USDC on Base)
GET  /.well-known/x402.json        → x402 discovery file
GET  /.well-known/agent-card.json  → A2A agent card
```

### Scan a token

```bash
curl -X POST https://rug-scanner-production.up.railway.app/scan \
  -H "Content-Type: application/json" \
  -d '{"token": "0x1234...5678", "chain": "base"}'
```

Without payment, returns `402` with `payment-required` header containing x402 payment requirements. With valid x402 payment signature, returns full analysis.

### Request

```json
{
  "token": "0x1234...5678",
  "chain": "base"
}
```

`chain`: `base` or `ethereum`

### Response

```json
{
  "score": 4,
  "verdict": "HIGH_RISK",
  "confidence": 0.85,
  "flags": [
    { "severity": "critical", "type": "top5_holders_above_50", "value": "84.2%", "detail": "..." },
    { "severity": "high", "type": "lp_unlocked", "value": true, "detail": "..." }
  ],
  "data": {
    "contract": { "verified": false, "can_mint": true, "can_blacklist": false, "..." },
    "holders": { "top5_pct": 84.2, "top10_pct": 91.5, "deployer_pct": 12.3, "..." },
    "liquidity": { "total_usd": 8200, "lp_locked": false, "dex": "aerodrome", "..." },
    "deployer": { "age_days": 3, "tx_count": 12, "eth_balance": 0.02 },
    "trading": { "buy_tax_pct": 2.0, "sell_tax_pct": 2.0, "can_sell": true, "..." },
    "market": { "price_usd": 0.00023, "volume_24h": 4500, "..." }
  },
  "disclaimer": "Risk assessment only. Not financial advice. May contain errors. DYOR.",
  "scanned_at": "2026-04-07T14:00:00Z"
}
```

### Verdicts

| Verdict | Meaning |
|---------|---------|
| `CRITICAL` | Definite scam signals (honeypot, deployer majority + unlocked LP) |
| `HIGH_RISK` | Strong rug indicators (mint + blacklist, asymmetric tax) |
| `MEDIUM_RISK` | Concerning but not definitive |
| `LOW_RISK` | Minor flags |
| `SAFE` | No flags triggered |

## What it checks

All analysis is our own on-chain queries. No third-party risk APIs.

- **Contract:** Function selectors (mint, blacklist, pause, fee setter), proxy detection (EIP-1967), ownership, source verification
- **Holders:** Top 5/10 concentration, deployer holdings (sampled from recent transfers)
- **Liquidity:** Pool discovery (Uniswap V2/V3 + Aerodrome on Base), reserves, LP lock detection (UNCX, Team Finance)
- **Deployer:** Wallet age, tx count, ETH balance
- **Trading:** Buy/sell tax simulation via router getAmountsOut
- **Market:** Price, volume, pair age (DEXScreener)

## Security

- SSRF validation on all address inputs
- API key masking in error messages
- Rate limiting (10 req/sec per IP)
- 5s timeouts on all external calls
- HTTP status checking on all fetch calls
- No third-party data resale (all analysis is own on-chain queries)

## Tech Stack

- TypeScript, Hono, @hono/node-server
- x402 payment gate (CDP facilitator, ExactEvmScheme, Base mainnet)
- Alchemy RPCs (Base + Ethereum)
- Upstash Redis (30min cache)
- Basescan/Etherscan APIs (source verification)
- DEXScreener API (market data)
- EVMole (bytecode analysis)
- Railway (deploy)

## Testing

140 tests, all fully mocked (zero network calls), runs in ~500ms.

```bash
npm test
```

| Category | Tests |
|----------|-------|
| Contract analysis | 16 |
| Holders analysis | 22 |
| Deployer analysis | 16 |
| Liquidity analysis | 22 |
| Alchemy provider | 12 |
| DEXScreener provider | 11 |
| Explorer provider | 9 |
| Scorer (rugs, safe, edge cases) | 30 |
| Simulation provider | 2 |
| **Total** | **140** |

## Setup

```bash
cp .env.example .env
# Fill in API keys
npm install
npm run dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ALCHEMY_API_KEY` | Yes | RPC calls for Base + Ethereum |
| `BASESCAN_API_KEY` | Yes | Source verification on Base |
| `ETHERSCAN_API_KEY` | Yes | Source verification on Ethereum |
| `UPSTASH_REDIS_REST_URL` | Yes | Cache layer |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Cache auth |
| `X402_WALLET_ADDRESS` | Yes | Your Base USDC receive address |
| `CDP_API_KEY_ID` | Yes | Coinbase Developer Platform key |
| `CDP_API_KEY_SECRET` | Yes | CDP secret for JWT signing |
| `PORT` | No | Server port (default: 3000) |

## MCP Server

Use Rug Scanner as a tool in Claude Code, Cursor, or any MCP client:

```bash
claude mcp add rug-scanner -- npx rug-scanner-mcp
```

## Deploy

```bash
railway up
```

## Stats

- 15 source files, ~1,600 lines TypeScript
- 10 test files, ~2,900 lines
- 18 commits
- 140 tests passing

## License

MIT
