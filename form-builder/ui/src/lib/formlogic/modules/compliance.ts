import {
  IntegerObject,
  StringObject,
  trueObject,
  falseObject,
  type BaseObject,
} from 'formlogic-lang';
import { getValue, isNullish } from './helpers';

/**
 * Compliance module for FormLogic engine.
 * Provides regulatory compliance checks for financial services.
 */
export const complianceModule: Record<string, (args: BaseObject[]) => BaseObject> = {
  /**
   * Reg BI suitability check — validates portfolio type against risk score.
   * Conservative: 0-30, Moderate: 20-60, Aggressive: 50-85, Speculative: 75-100
   */
  regBICheck: (args: BaseObject[]) => {
    if (args.length < 2) return falseObject;
    const riskScore = getValue(args[0]);
    const portfolioType = getValue(args[1]);
    if (typeof riskScore !== 'number' || typeof portfolioType !== 'string') return falseObject;

    const ranges: Record<string, [number, number]> = {
      conservative: [0, 30],
      moderate: [20, 60],
      aggressive: [50, 85],
      speculative: [75, 100],
    };

    const range = ranges[portfolioType.toLowerCase()];
    if (!range) return falseObject;
    return riskScore >= range[0] && riskScore <= range[1] ? trueObject : falseObject;
  },

  /**
   * Weighted suitability score (1-100).
   * Age 20%, Income 15%, Net Worth 20%, Risk Tolerance 25%, Time Horizon 20%
   */
  suitabilityScore: (args: BaseObject[]) => {
    if (args.length < 5) return new IntegerObject(0);
    const age = getValue(args[0]);
    const income = getValue(args[1]);
    const netWorth = getValue(args[2]);
    const riskTolerance = getValue(args[3]);
    const timeHorizon = getValue(args[4]);

    if (typeof age !== 'number' || typeof income !== 'number' ||
        typeof netWorth !== 'number' || typeof riskTolerance !== 'number' ||
        typeof timeHorizon !== 'number') {
      return new IntegerObject(0);
    }

    // Normalize each factor to 0-100 scale
    const ageScore = Math.max(0, Math.min(100, 100 - age)); // younger = higher score
    const incomeScore = Math.max(0, Math.min(100, (income / 500000) * 100)); // $500k = 100
    const nwScore = Math.max(0, Math.min(100, (netWorth / 5000000) * 100)); // $5M = 100
    const tolScore = Math.max(0, Math.min(100, riskTolerance * 10)); // 1-10 scale → 10-100
    const horizonScore = Math.max(0, Math.min(100, timeHorizon * 3.33)); // 30 years = ~100

    const weighted = ageScore * 0.20 + incomeScore * 0.15 + nwScore * 0.20 +
                     tolScore * 0.25 + horizonScore * 0.20;

    return new IntegerObject(Math.round(Math.max(1, Math.min(100, weighted))));
  },

  /**
   * AML flag — flags suspicious transaction patterns.
   * >= $10k single, structuring ($8k-$10k with freq>3), high volume (>50/month), high aggregate (>$100k)
   */
  amlFlag: (args: BaseObject[]) => {
    if (args.length < 1) return falseObject;
    const amount = getValue(args[0]);
    const frequency = args.length > 1 ? getValue(args[1]) : 0;
    if (typeof amount !== 'number') return falseObject;
    const freq = typeof frequency === 'number' ? frequency : 0;

    // Single transaction >= $10,000 (CTR threshold)
    if (amount >= 10000) return trueObject;
    // Structuring detection: $8k-$10k with frequency > 3
    if (amount >= 8000 && amount < 10000 && freq > 3) return trueObject;
    // High volume: > 50 transactions per month
    if (freq > 50) return trueObject;
    // High aggregate: > $100k total
    if (amount * freq > 100000) return trueObject;

    return falseObject;
  },

  /**
   * KYC completeness — all variadic fields must be non-empty.
   */
  kycComplete: (args: BaseObject[]) => {
    for (const arg of args) {
      if (isNullish(arg)) return falseObject;
      const val = getValue(arg);
      if (val === undefined || val === null) return falseObject;
      if (typeof val === 'string' && val.trim().length === 0) return falseObject;
    }
    return args.length > 0 ? trueObject : falseObject;
  },

  /**
   * NIGO check — returns comma-separated 1-based indices of missing fields.
   * Empty string = all complete.
   */
  nigoCheck: (args: BaseObject[]) => {
    const missing: number[] = [];
    for (let i = 0; i < args.length; i++) {
      if (isNullish(args[i])) {
        missing.push(i + 1);
        continue;
      }
      const val = getValue(args[i]);
      if (val === undefined || val === null) {
        missing.push(i + 1);
        continue;
      }
      if (typeof val === 'string' && val.trim().length === 0) {
        missing.push(i + 1);
      }
    }
    return new StringObject(missing.join(','));
  },

  /**
   * Accredited investor check — SEC Rule 501(a).
   * Income > $200k or Net Worth > $1M
   */
  accreditedInvestor: (args: BaseObject[]) => {
    if (args.length < 2) return falseObject;
    const income = getValue(args[0]);
    const netWorth = getValue(args[1]);
    if (typeof income !== 'number' || typeof netWorth !== 'number') return falseObject;

    if (income > 200000 || netWorth > 1000000) return trueObject;
    return falseObject;
  },

  /**
   * Australian wholesale client check — Corporations Act s761G.
   * Gross income >= $250,000 OR net assets >= $2,500,000.
   */
  wholesaleClient: (args: BaseObject[]) => {
    if (args.length < 2) return falseObject;
    const income = getValue(args[0]);
    const netAssets = getValue(args[1]);
    if (typeof income !== 'number' || typeof netAssets !== 'number') return falseObject;

    if (income >= 250000 || netAssets >= 2500000) return trueObject;
    return falseObject;
  },

  /**
   * AUSTRAC Threshold Transaction Report flag.
   * Flags: single >= AUD $10,000, structuring ($8k-$10k + freq>3),
   * high volume (>50/month), high aggregate (>$100k).
   */
  austracFlag: (args: BaseObject[]) => {
    if (args.length < 1) return falseObject;
    const amount = getValue(args[0]);
    const frequency = args.length > 1 ? getValue(args[1]) : 0;
    if (typeof amount !== 'number') return falseObject;
    const freq = typeof frequency === 'number' ? frequency : 0;

    if (amount >= 10000) return trueObject;
    if (amount >= 8000 && amount < 10000 && freq > 3) return trueObject;
    if (freq > 50) return trueObject;
    if (amount * freq > 100000) return trueObject;

    return falseObject;
  },

  /**
   * Australian TFN validation — 9-digit format (###-###-### or #########).
   */
  tfnValid: (args: BaseObject[]) => {
    if (args.length < 1) return falseObject;
    const tfn = getValue(args[0]);
    if (typeof tfn !== 'string') return falseObject;

    const pattern = /^\d{3}-?\d{3}-?\d{3}$/;
    return pattern.test(tfn.trim()) ? trueObject : falseObject;
  },
};
