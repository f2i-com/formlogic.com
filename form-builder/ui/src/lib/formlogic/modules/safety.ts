import {
  IntegerObject,
  StringObject,
  type BaseObject,
} from 'formlogic-lang';
import { getValue } from './helpers';

/**
 * Safety module for FormLogic engine.
 * Provides OHS risk assessment calculations.
 */
export const safetyModule: Record<string, (args: BaseObject[]) => BaseObject> = {
  /**
   * Risk matrix score: likelihood (1-5) x consequence (1-5).
   * Returns score 1-25.
   */
  riskMatrix: (args: BaseObject[]) => {
    if (args.length < 2) return new IntegerObject(0);
    const likelihood = getValue(args[0]);
    const consequence = getValue(args[1]);
    if (typeof likelihood !== 'number' || typeof consequence !== 'number') {
      return new IntegerObject(0);
    }
    const l = Math.max(1, Math.min(5, Math.round(likelihood)));
    const c = Math.max(1, Math.min(5, Math.round(consequence)));
    return new IntegerObject(l * c);
  },

  /**
   * Risk level label from a risk score (1-25).
   * Critical: 20-25, High: 12-19, Medium: 5-11, Low: 1-4.
   */
  riskLevel: (args: BaseObject[]) => {
    if (args.length < 1) return new StringObject('Unknown');
    const score = getValue(args[0]);
    if (typeof score !== 'number') return new StringObject('Unknown');

    if (score >= 20) return new StringObject('Critical');
    if (score >= 12) return new StringObject('High');
    if (score >= 5) return new StringObject('Medium');
    if (score >= 1) return new StringObject('Low');
    return new StringObject('Unknown');
  },

  /**
   * Control effectiveness rating.
   * Scores: elimination=5, substitution=4, engineering=3, administrative=2, ppe=1.
   */
  controlEffectiveness: (args: BaseObject[]) => {
    if (args.length < 1) return new IntegerObject(0);
    const controlType = getValue(args[0]);
    if (typeof controlType !== 'string') return new IntegerObject(0);

    const scores: Record<string, number> = {
      elimination: 5,
      substitution: 4,
      engineering: 3,
      administrative: 2,
      ppe: 1,
    };

    return new IntegerObject(scores[controlType.toLowerCase()] ?? 0);
  },

  /**
   * Residual risk after control application.
   * residualRisk = riskScore * (1 - effectivenessRatio)
   * effectivenessRatio = controlScore / 5
   */
  residualRisk: (args: BaseObject[]) => {
    if (args.length < 2) return new IntegerObject(0);
    const riskScore = getValue(args[0]);
    const controlType = getValue(args[1]);
    if (typeof riskScore !== 'number' || typeof controlType !== 'string') {
      return new IntegerObject(0);
    }

    const scores: Record<string, number> = {
      elimination: 5,
      substitution: 4,
      engineering: 3,
      administrative: 2,
      ppe: 1,
    };

    const effectiveness = scores[controlType.toLowerCase()] ?? 0;
    const residual = Math.round(riskScore * (1 - effectiveness / 5));
    return new IntegerObject(Math.max(0, residual));
  },
};
