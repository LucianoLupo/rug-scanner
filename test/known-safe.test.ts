import { describe, it, expect } from 'vitest';
import { getVerdict } from '../src/analysis/scorer.js';
import type { Flag } from '../src/types/index.js';

// Known safe token addresses for future integration testing:
// Ethereum:
//   USDC: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
//   WETH: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
//   LINK: 0x514910771AF9Ca656af840dff83E8264EcF986CA
// Base:
//   USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
//   WETH: 0x4200000000000000000000000000000000000006

function flag(type: string, severity: Flag['severity'] = 'low'): Flag {
  return { type, severity, value: true, detail: `${type} detected` };
}

describe('Known Safe Tokens', () => {
  it('no flags at all → SAFE, score 0', () => {
    const result = getVerdict([]);
    expect(result.verdict).toBe('SAFE');
    expect(result.score).toBe(0);
  });

  it('only owner_not_renounced (e.g., USDC) → LOW_RISK', () => {
    const flags: Flag[] = [flag('owner_not_renounced', 'low')];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('LOW_RISK');
    expect(result.score).toBe(1);
  });

  it('only one low-severity flag → LOW_RISK', () => {
    const flags: Flag[] = [flag('deployer_low_balance', 'low')];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('LOW_RISK');
    expect(result.score).toBe(1);
  });

  it('verified source, locked LP, distributed holders → SAFE', () => {
    const result = getVerdict([]);
    expect(result.verdict).toBe('SAFE');
    expect(result.score).toBe(0);
  });

  it('well-known token patterns (WETH-like: no flags) → SAFE', () => {
    const result = getVerdict([]);
    expect(result.verdict).toBe('SAFE');
    expect(result.score).toBe(0);
  });
});
