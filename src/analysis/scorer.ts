import type { Flag, Verdict } from '../types/index.js';

export function getVerdict(flags: Flag[]): { verdict: Verdict; score: number } {
  const score = flags.length;
  const has = (type: string) => flags.some((f) => f.type === type);

  // CRITICAL — definite scam signals
  if (has('honeypot_cant_sell')) return { verdict: 'CRITICAL', score };
  if (has('deployer_holds_majority') && has('lp_unlocked'))
    return { verdict: 'CRITICAL', score };
  if (has('no_liquidity_pool')) return { verdict: 'CRITICAL', score };
  if (has('lp_unlocked_low_liquidity')) return { verdict: 'CRITICAL', score };

  // HIGH_RISK — strong rug indicators
  if (has('deployer_holds_majority')) return { verdict: 'HIGH_RISK', score };
  if (has('lp_unlocked') && has('low_liquidity'))
    return { verdict: 'HIGH_RISK', score };
  if (has('can_mint') && has('can_blacklist'))
    return { verdict: 'HIGH_RISK', score };
  if (has('asymmetric_tax')) return { verdict: 'HIGH_RISK', score };
  if (has('high_sell_tax')) return { verdict: 'HIGH_RISK', score };

  // MEDIUM_RISK — concerning but not definitive
  if (has('unverified_source') && has('is_proxy'))
    return { verdict: 'MEDIUM_RISK', score };
  if (has('top5_holders_above_50')) return { verdict: 'MEDIUM_RISK', score };
  if (
    flags.filter((f) => f.severity === 'high' || f.severity === 'critical')
      .length >= 2
  )
    return { verdict: 'MEDIUM_RISK', score };
  if (score >= 3) return { verdict: 'MEDIUM_RISK', score };

  // LOW_RISK — minor flags
  if (score >= 1) return { verdict: 'LOW_RISK', score };

  // SAFE — no flags triggered
  return { verdict: 'SAFE', score };
}

export function calculateConfidence(
  checksCompleted: number,
  checksTotal: number,
): number {
  if (checksTotal <= 0) return 0;
  return Math.max(0, Math.min(1, checksCompleted / checksTotal));
}
