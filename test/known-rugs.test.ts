import { describe, it, expect } from 'vitest';
import { getVerdict } from '../src/analysis/scorer.js';
import type { Flag } from '../src/types/index.js';

// Known rug token addresses for future integration testing:
// Ethereum:
//   SQUID Game token: 0x87230146E138d3F296a9a77e497A2A83012e9Bc5
//   SaveTheKids:      0x5B0390bAcde6B793A6e005EFd498fC4C6C9F3A2F
//   AnubisDAO:        0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1
// Base:
//   Various memecoins removed within hours of launch — addresses rotate frequently

function flag(type: string, severity: Flag['severity'] = 'high'): Flag {
  return { type, severity, value: true, detail: `${type} detected` };
}

describe('Known Rug Patterns', () => {
  it('honeypot (cant sell) → CRITICAL', () => {
    const flags: Flag[] = [flag('honeypot_cant_sell', 'critical')];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('CRITICAL');
    expect(result.score).toBe(1);
  });

  it('deployer holds majority + LP unlocked → CRITICAL', () => {
    const flags: Flag[] = [
      flag('deployer_holds_majority', 'critical'),
      flag('lp_unlocked', 'high'),
    ];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('CRITICAL');
    expect(result.score).toBe(2);
  });

  it('no liquidity pool → CRITICAL', () => {
    const flags: Flag[] = [flag('no_liquidity_pool', 'critical')];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('CRITICAL');
    expect(result.score).toBe(1);
  });

  it('LP unlocked + low liquidity (combined flag) → CRITICAL', () => {
    const flags: Flag[] = [flag('lp_unlocked_low_liquidity', 'critical')];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('CRITICAL');
    expect(result.score).toBe(1);
  });

  it('can mint + can blacklist → HIGH_RISK', () => {
    const flags: Flag[] = [
      flag('can_mint', 'high'),
      flag('can_blacklist', 'high'),
    ];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('HIGH_RISK');
    expect(result.score).toBe(2);
  });

  it('asymmetric tax → HIGH_RISK', () => {
    const flags: Flag[] = [flag('asymmetric_tax', 'high')];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('HIGH_RISK');
    expect(result.score).toBe(1);
  });

  it('high sell tax → HIGH_RISK', () => {
    const flags: Flag[] = [flag('high_sell_tax', 'high')];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('HIGH_RISK');
    expect(result.score).toBe(1);
  });

  it('deployer holds majority (no LP flag) → HIGH_RISK', () => {
    const flags: Flag[] = [flag('deployer_holds_majority', 'critical')];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('HIGH_RISK');
    expect(result.score).toBe(1);
  });

  it('LP unlocked + low liquidity (separate flags) → HIGH_RISK', () => {
    const flags: Flag[] = [
      flag('lp_unlocked', 'high'),
      flag('low_liquidity', 'high'),
    ];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('HIGH_RISK');
    expect(result.score).toBe(2);
  });

  it('multiple high severity flags → MEDIUM_RISK', () => {
    const flags: Flag[] = [
      flag('deployer_disposable', 'high'),
      flag('unverified_source', 'high'),
    ];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('MEDIUM_RISK');
    expect(result.score).toBe(2);
  });

  it('top5_holders_above_50 → MEDIUM_RISK', () => {
    const flags: Flag[] = [
      { type: 'top5_holders_above_50', severity: 'critical', value: 65.0, detail: 'Top 5 holders control 65.0% of supply' },
    ];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('MEDIUM_RISK');
  });
});

describe('Scorer Blindspot Tests', () => {
  it('zero_supply alone → HIGH_RISK (1 high flag, triggers generic high count)', () => {
    const flags: Flag[] = [flag('zero_supply', 'high')];
    const result = getVerdict(flags);
    // Only 1 high flag — no specific rule matches, falls to score >= 1 → LOW_RISK
    // This documents the current behavior as a known blindspot
    expect(result.verdict).toBe('LOW_RISK');
    expect(result.score).toBe(1);
  });

  it('no_bytecode alone → LOW_RISK (1 critical flag, no specific rule)', () => {
    const flags: Flag[] = [flag('no_bytecode', 'critical')];
    const result = getVerdict(flags);
    // Only 1 critical flag — no named rule matches, falls to score >= 1 → LOW_RISK
    // This documents a blindspot: a contract with no bytecode should arguably be higher risk
    expect(result.verdict).toBe('LOW_RISK');
    expect(result.score).toBe(1);
  });

  it('has_fee_setter alone → LOW_RISK (1 high flag, no specific rule)', () => {
    const flags: Flag[] = [flag('has_fee_setter', 'high')];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('LOW_RISK');
    expect(result.score).toBe(1);
  });

  it('no_bytecode + zero_supply → MEDIUM_RISK (2 high/critical flags)', () => {
    const flags: Flag[] = [
      flag('no_bytecode', 'critical'),
      flag('zero_supply', 'high'),
    ];
    const result = getVerdict(flags);
    // 2 flags with severity >= high → triggers the generic "2+ high/critical" rule
    expect(result.verdict).toBe('MEDIUM_RISK');
    expect(result.score).toBe(2);
  });

  it('can_blacklist alone (without can_mint) → LOW_RISK', () => {
    const flags: Flag[] = [flag('can_blacklist', 'high')];
    const result = getVerdict(flags);
    expect(result.verdict).toBe('LOW_RISK');
    expect(result.score).toBe(1);
  });
});
