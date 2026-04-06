import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { getVerdict, calculateConfidence } from '../src/analysis/scorer.js';
import type { Flag } from '../src/types/index.js';

function flag(type: string, severity: Flag['severity'] = 'medium'): Flag {
  return { type, severity, value: true, detail: `${type} detected` };
}

// Mirror the scan request schema from src/index.ts for validation tests
const scanRequestSchema = z.object({
  token: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid token address'),
  chain: z.enum(['base', 'ethereum']),
});

describe('Edge Cases', () => {
  it('empty flags array → SAFE', () => {
    const result = getVerdict([]);
    expect(result.verdict).toBe('SAFE');
    expect(result.score).toBe(0);
  });

  it('exactly 3 flags (threshold) → MEDIUM_RISK', () => {
    const flags: Flag[] = [
      flag('deployer_low_balance', 'low'),
      flag('deployer_fresh_wallet', 'medium'),
      flag('owner_not_renounced', 'low'),
    ];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('MEDIUM_RISK');
    expect(result.score).toBe(3);
  });

  it('2 flags, none high severity → LOW_RISK', () => {
    const flags: Flag[] = [
      flag('deployer_low_balance', 'low'),
      flag('owner_not_renounced', 'low'),
    ];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('LOW_RISK');
    expect(result.score).toBe(2);
  });

  it('proxy + unverified → MEDIUM_RISK', () => {
    const flags: Flag[] = [
      flag('is_proxy', 'medium'),
      flag('unverified_source', 'high'),
    ];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('MEDIUM_RISK');
    expect(result.score).toBe(2);
  });

  it('calculateConfidence with 0 total → 0', () => {
    expect(calculateConfidence(0, 0)).toBe(0);
  });

  it('calculateConfidence with all checks passing → 1.0', () => {
    expect(calculateConfidence(7, 7)).toBe(1);
  });

  it('calculateConfidence with partial → correct ratio', () => {
    expect(calculateConfidence(3, 7)).toBeCloseTo(3 / 7);
    expect(calculateConfidence(5, 10)).toBe(0.5);
  });

  it('single critical flag → verdict based on type', () => {
    const flags: Flag[] = [flag('honeypot_cant_sell', 'critical')];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('CRITICAL');
    expect(result.score).toBe(1);
  });

  it('many low flags (5 low severity) → MEDIUM_RISK', () => {
    const flags: Flag[] = [
      flag('deployer_low_balance', 'low'),
      flag('owner_not_renounced', 'low'),
      flag('deployer_fresh_wallet', 'low'),
      flag('minor_issue_a', 'low'),
      flag('minor_issue_b', 'low'),
    ];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('MEDIUM_RISK');
    expect(result.score).toBe(5);
  });

  it('scan request validation — invalid address rejected', () => {
    const invalid = scanRequestSchema.safeParse({
      token: '0xinvalid',
      chain: 'ethereum',
    });
    expect(invalid.success).toBe(false);
  });

  it('scan request validation — valid address accepted', () => {
    const valid = scanRequestSchema.safeParse({
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      chain: 'ethereum',
    });
    expect(valid.success).toBe(true);
  });

  it('scan request validation — invalid chain rejected', () => {
    const invalid = scanRequestSchema.safeParse({
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      chain: 'solana',
    });
    expect(invalid.success).toBe(false);
  });
});

describe('Analysis Module Helpers', () => {
  it('calculateConfidence clamps above 1', () => {
    expect(calculateConfidence(10, 7)).toBe(1);
  });

  it('calculateConfidence clamps below 0', () => {
    expect(calculateConfidence(-1, 7)).toBe(0);
  });

  it('calculateConfidence with negative total → 0', () => {
    expect(calculateConfidence(5, -1)).toBe(0);
  });
});
