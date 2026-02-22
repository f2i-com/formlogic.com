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
          // Ensure tiers are sorted by ceiling ascending
          tiers.sort((a, b) => a[0] - b[0]);
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

    let equity = Math.round(20 + t * 70);  // 20 → 90
    let bond = Math.round(50 - t * 42);    // 50 → 8
    let cash = 100 - equity - bond;         // 30 → 2

    // Clamp cash to prevent negative values from independent rounding
    if (cash < 0) {
      bond += cash; // reduce bond by the overshoot
      cash = 0;
    }

    return new StringObject(`${equity}:${bond}:${cash}`);
  },

  /**
   * ACAT transfer fee by custodian (US).
   * Schwab=$50, Fidelity=$0, Vanguard=$100, E*TRADE=$75, others=$75.
   * Fee waived for transfers under $500.
   */
  transferFee: (args: BaseObject[]) => {
    if (args.length < 1) return new FloatObject(0);
    const amount = getValue(args[0]);
    const custodian = args.length > 1 ? getValue(args[1]) : undefined;
    if (typeof amount !== 'number') return new FloatObject(0);

    // Waive fee for small transfers
    if (amount < 500) return new FloatObject(0);

    const feeSchedule: Record<string, number> = {
      schwab: 50,
      fidelity: 0,
      vanguard: 100,
      etrade: 75,
      pershing: 75,
      lpl: 75,
    };

    if (typeof custodian === 'string') {
      const fee = feeSchedule[custodian.toLowerCase()];
      if (fee !== undefined) return new FloatObject(fee);
    }

    return new FloatObject(75);
  },

  /**
   * Australian tiered AUM fee (GST inclusive).
   * Default tiers: 1.1% first $500k, 0.88% $500k-$2M, 0.66% $2M-$5M, 0.44% above $5M.
   * Optional tiersJson param for custom tiers.
   */
  auAumFee: (args: BaseObject[]) => {
    if (args.length < 1) return new FloatObject(0);
    const assets = getValue(args[0]);
    const tiersJson = args.length > 1 ? getValue(args[1]) : undefined;
    if (typeof assets !== 'number' || assets <= 0) return new FloatObject(0);

    let tiers: Array<[number, number]> = [
      [500_000, 0.011],
      [2_000_000, 0.0088],
      [5_000_000, 0.0066],
      [Infinity, 0.0044],
    ];

    if (typeof tiersJson === 'string') {
      try {
        const parsed = JSON.parse(tiersJson);
        if (Array.isArray(parsed) && parsed.length > 0 &&
            parsed.every((t: unknown) => Array.isArray(t) && t.length >= 2 && typeof t[0] === 'number' && typeof t[1] === 'number')) {
          tiers = parsed.map((t: [number, number]) => [t[0], t[1]]);
          tiers.sort((a, b) => a[0] - b[0]);
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
   * Australian off-market transfer fee by platform.
   * Netwealth/HUB24=$0, BT Panorama=$54 flat, Macquarie=$33, CFS=$0, others=$55.
   */
  auTransferFee: (args: BaseObject[]) => {
    if (args.length < 2) return new FloatObject(0);
    const amount = getValue(args[0]);
    const platform = getValue(args[1]);
    if (typeof amount !== 'number' || typeof platform !== 'string') return new FloatObject(0);

    const feeSchedule: Record<string, number> = {
      netwealth: 0,
      hub24: 0,
      'bt panorama': 54,
      macquarie: 33,
      cfs: 0,
      'cfs firstchoice': 0,
    };

    const fee = feeSchedule[platform.toLowerCase()];
    if (fee !== undefined) return new FloatObject(fee);

    return new FloatObject(55);
  },
};
