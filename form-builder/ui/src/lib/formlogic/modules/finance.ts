import {
  FloatObject,
  IntegerObject,
  StringObject,
  type BaseObject,
} from 'formlogic-lang';
import { getValue } from './helpers';

/**
 * Finance module for FormLogic engine.
 * Provides financial calculations for wealth management workflows.
 */
export const financeModule: Record<string, (args: BaseObject[]) => BaseObject> = {
  /**
   * Compound interest: A = P * (1 + r)^n, rounded to 2 decimals.
   */
  compoundInterest: (args: BaseObject[]) => {
    if (args.length < 3) return new FloatObject(0);
    const principal = getValue(args[0]);
    const rate = getValue(args[1]);
    const periods = getValue(args[2]);
    if (typeof principal !== 'number' || typeof rate !== 'number' || typeof periods !== 'number') {
      return new FloatObject(0);
    }
    const result = principal * Math.pow(1 + rate, periods);
    return new FloatObject(Math.round(result * 100) / 100);
  },

  /**
   * Tiered AUM fee calculation.
   * Default tiers: 1% first $1M, 0.75% $1M-$5M, 0.50% $5M-$10M, 0.35% above $10M.
   * Optional tiersJson param for custom tiers.
   */
  aumFee: (args: BaseObject[]) => {
    if (args.length < 1) return new FloatObject(0);
    const assets = getValue(args[0]);
    const tiersJson = args.length > 1 ? getValue(args[1]) : undefined;
    if (typeof assets !== 'number' || assets <= 0) return new FloatObject(0);

    // Default tiers: [ceiling, rate] pairs
    let tiers: Array<[number, number]> = [
      [1_000_000, 0.01],
      [5_000_000, 0.0075],
      [10_000_000, 0.005],
      [Infinity, 0.0035],
    ];

    if (typeof tiersJson === 'string') {
      try {
        const parsed = JSON.parse(tiersJson);
        if (Array.isArray(parsed) && parsed.length > 0 &&
            parsed.every((t: unknown) => Array.isArray(t) && t.length >= 2 && typeof t[0] === 'number' && typeof t[1] === 'number')) {
          tiers = parsed.map((t: [number, number]) => [t[0], t[1]]);
        }
      } catch {
        // Use default tiers on parse error
      }
    }

    let remaining = assets;
    let totalFee = 0;
    let prevCeiling = 0;

    for (const [ceiling, rate] of tiers) {
      const tierAmount = Math.min(remaining, ceiling - prevCeiling);
      if (tierAmount <= 0) break;
      totalFee += tierAmount * rate;
      remaining -= tierAmount;
      prevCeiling = ceiling;
      if (remaining <= 0) break;
    }

    return new FloatObject(Math.round(totalFee * 100) / 100);
  },

  /**
   * Risk score (1-100): weighted — age 30%, horizon 30%, tolerance 40%.
   */
  riskScore: (args: BaseObject[]) => {
    if (args.length < 3) return new IntegerObject(0);
    const age = getValue(args[0]);
    const timeHorizon = getValue(args[1]);
    const riskTolerance = getValue(args[2]);
    if (typeof age !== 'number' || typeof timeHorizon !== 'number' || typeof riskTolerance !== 'number') {
      return new IntegerObject(0);
    }

    // Age: younger = higher risk capacity (inverse)
    const ageScore = Math.max(0, Math.min(100, 100 - age));
    // Time horizon: longer = higher risk capacity
    const horizonScore = Math.max(0, Math.min(100, timeHorizon * 3.33));
    // Risk tolerance: direct scale 1-10 → 10-100
    const tolScore = Math.max(0, Math.min(100, riskTolerance * 10));

    const weighted = ageScore * 0.30 + horizonScore * 0.30 + tolScore * 0.40;
    return new IntegerObject(Math.round(Math.max(1, Math.min(100, weighted))));
  },

  /**
   * Portfolio allocation based on risk score.
   * Returns "equity:bond:cash" string.
   * Linear interpolation from conservative(20:50:30) to aggressive(90:8:2).
   */
  portfolioAllocation: (args: BaseObject[]) => {
    if (args.length < 1) return new StringObject('20:50:30');
    const riskScore = getValue(args[0]);
    if (typeof riskScore !== 'number') return new StringObject('20:50:30');

    const score = Math.max(1, Math.min(100, riskScore));
    const t = (score - 1) / 99; // 0 to 1

    const equity = Math.round(20 + t * 70);  // 20 → 90
    const bond = Math.round(50 - t * 42);    // 50 → 8
    const cash = 100 - equity - bond;         // 30 → 2

    return new StringObject(`${equity}:${bond}:${cash}`);
  },

  /**
   * Transfer fee by custodian.
   * Schwab/Fidelity/Vanguard = $0, others = $75, waived under $500.
   */
  transferFee: (args: BaseObject[]) => {
    if (args.length < 1) return new FloatObject(0);
    const amount = getValue(args[0]);
    const custodian = args.length > 1 ? getValue(args[1]) : undefined;
    if (typeof amount !== 'number') return new FloatObject(0);

    const zeroCostCustodians = ['schwab', 'fidelity', 'vanguard'];

    if (typeof custodian === 'string' && zeroCostCustodians.includes(custodian.toLowerCase())) {
      return new FloatObject(0);
    }

    // Waive fee for small transfers
    if (amount < 500) return new FloatObject(0);

    return new FloatObject(75);
  },
};
