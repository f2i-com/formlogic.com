/**
 * Structured engine config for the split Aokie speech services (aokie-stt /
 * aokie-tts): the service card's Engine select + model-folder input COMPOSE
 * the service's generic extra-args array (`--stt-engine X --stt-model-dir DIR`
 * resp. `--tts-engine` / `--tts-model-dir`) instead of introducing a second
 * persistence lane — the raw extra-args input stays the advanced escape hatch
 * and both views edit the SAME saved array.
 *
 * Pure parse/compose helpers, unit-tested (speechEngineArgs.test.ts).
 */

export interface EngineFlagSpec {
  /** e.g. `--stt-engine` */
  engineFlag: string;
  /** e.g. `--stt-model-dir` */
  modelDirFlag: string;
}

export const STT_ENGINE_FLAGS: EngineFlagSpec = {
  engineFlag: '--stt-engine',
  modelDirFlag: '--stt-model-dir',
};

export const TTS_ENGINE_FLAGS: EngineFlagSpec = {
  engineFlag: '--tts-engine',
  modelDirFlag: '--tts-model-dir',
};

export interface ParsedEngineArgs {
  /** Selected engine ('' = service default — flag absent). */
  engine: string;
  /** Model folder ('' = service default — flag absent). */
  modelDir: string;
  /** Every OTHER token, in order (the user's own extra args). */
  rest: string[];
}

/**
 * Pull the engine/model-dir flag values out of an extra-args array. The LAST
 * occurrence of a duplicated flag wins (CLI convention); a dangling flag with
 * no value is dropped (treated as unset). Every other token is preserved in
 * order in `rest`.
 */
export function parseEngineArgs(
  args: readonly string[],
  spec: EngineFlagSpec,
): ParsedEngineArgs {
  let engine = '';
  let modelDir = '';
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === spec.engineFlag) {
      if (i + 1 < args.length) engine = args[++i];
      continue;
    }
    if (a === spec.modelDirFlag) {
      if (i + 1 < args.length) modelDir = args[++i];
      continue;
    }
    rest.push(a);
  }
  return { engine, modelDir, rest };
}

/**
 * Write the engine/model-dir selection back into an extra-args array:
 * removes every existing `engineFlag X` / `modelDirFlag DIR` pair (including
 * duplicates and dangling flags), PRESERVES every other user token in order,
 * then appends the new pairs. Blank engine/modelDir simply removes the
 * corresponding flag (the service's built-in default takes over).
 */
export function composeEngineArgs(
  args: readonly string[],
  spec: EngineFlagSpec,
  engine: string,
  modelDir: string,
): string[] {
  const out = [...parseEngineArgs(args, spec).rest];
  const e = engine.trim();
  const d = modelDir.trim();
  if (e) out.push(spec.engineFlag, e);
  if (d) out.push(spec.modelDirFlag, d);
  return out;
}
