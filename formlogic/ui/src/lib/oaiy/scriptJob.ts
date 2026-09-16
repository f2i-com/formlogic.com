/**
 * The job FormLogic hands a consumer for one Python logic block, condition, app-logic script or
 * syntax check: OAIY's leaf-script request shape, in the form that lets the RUNNER do the
 * wrapping (oaiy.com protocol/v1/script-request.schema.json, `$defs/pythonJob`).
 *
 * WHY IT IS THIS NARROW. A Python job can be spelled out - `files`, `entry`, `call`, and the
 * author's code already wrapped into one of them - or it can NAME modes of the request's profile
 * and carry the author's text unwrapped. Never both: two ways to build one project is an
 * ambiguity, and the schema refuses it rather than resolving it. `modes` therefore requires
 * `source` and forbids `files`, `entry`, `call` and `fallbackOnSourceError`, and a request with
 * ANY malformed job is refused WHOLE - one stray key costs every other job in the batch.
 *
 * WHAT THE RUNNER DOES WITH IT. For each name in `modes`, in order: merge the profile's
 * `python.files` with that mode's, write `before` + `source` + `after` to the mode's block file,
 * run `python.entry` and call the mode's own `call` (or the contract's) with `args`. It moves to
 * the next mode ONLY when the engine reported a `source` failure while the project initialised -
 * the engine's own words for "nothing of yours ran". Whatever it reports comes back with THAT
 * mode's `lineOffset` already subtracted, so the lines are the author's own.
 *
 * WHY THE CHAIN LIVES HERE AND NOT IN THE PROFILE. Which wrappings apply depends on the author's
 * text, not on the kind alone: a flow block with code is tried as one parenthesised expression
 * and then as a module, but an EMPTY block compiled as an expression is a valid empty tuple, not
 * a compile failure, so the chain would never reach the module phase and the block would answer
 * `()` where `None` is right. modesFor makes that judgement once, for this host and for a job.
 */
import { isPythonKind, modesFor, type PythonKind } from '../formlogic/python/pythonContract';

/** `$defs/id`: 1..128 characters. */
const ID_MAX = 128;

/** The keys a mode job carries, in the order it carries them. */
export const PYTHON_JOB_KEYS = Object.freeze(['id', 'language', 'mode', 'modes', 'source', 'args'] as const);

/** One Python job that names profile modes rather than carrying its own file set. */
export interface PythonModeJob {
  id: string;
  language: 'python';
  /** The only Python mode the envelope has: a project, however its files are arrived at. */
  mode: 'python-project';
  /** Profile mode names, tried in order; the next only after a `source` failure at init. */
  modes: string[];
  /** The author's text, unwrapped. The mode says what goes around it. */
  source: string;
  /** The call's arguments, crossing as JSON literals - never as program text. */
  args: unknown[];
}

/**
 * Build the job for one evaluation. Refuses here what the consumer would refuse there: a job
 * this host could not have meant is cheaper to stop before it is sent than to have a whole
 * request rejected over.
 */
export function pythonModeJob(id: string, kind: PythonKind, source: string, context: unknown): PythonModeJob {
  if (id.length < 1 || id.length > ID_MAX) {
    throw new Error(`A job id must be 1 to ${ID_MAX} characters; ${JSON.stringify(id)} is ${id.length}`);
  }
  if (!isPythonKind(kind)) throw new Error(`There is no Python contract for '${kind}' evaluations.`);
  return {
    id,
    language: 'python',
    mode: 'python-project',
    modes: [...modesFor(kind, source)],
    source,
    // The JSON view zipp-host parses in the guest: a Date becomes its string and an undefined
    // member drops out, so both hosts see the same values. `syntax` passes nothing at all - its
    // mode overrides the call with the entry's own never-run function, which takes no argument.
    args: kind === 'syntax' ? [] : [JSON.parse(JSON.stringify(context ?? {})) as unknown],
  };
}
