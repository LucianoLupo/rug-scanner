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
});
