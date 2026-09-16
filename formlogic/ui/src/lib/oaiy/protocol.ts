/**
 * The OAIY protocols FormLogic speaks, and at which version. `protocol.json` is the source of
 * truth; this module types it for the UI and names what each key means. It is the mirror of
 * `src/lib/softn/protocol.json`, which does the same job for the Softn runtime.
 *
 * WHAT IT IS FOR. An OAIY CLI reports its own side with `oaiy capabilities --json`, whose
 * `protocols` map is `{run, script, profile}`. `scripts/fetch-oaiy-cli.mjs` (PR-D) compares THIS
 * file against that map before it installs a release: every key here must equal OAIY's value for
 * the same key, and OAIY may carry keys this file does not. The comparison is a SUBSET, not an
 * equality, for two reasons - OAIY's own Desktop reads FormLogic's side the same way (it
 * requires the one protocol it uses and stores no map), and the Softn fetcher already sets the
 * precedent of comparing named keys only. A protocol OAIY adds is not FormLogic's problem until
 * FormLogic uses it; a protocol FormLogic uses that OAIY has moved past is a refusal.
 *
 * WHY `run` IS ABSENT, WHICH IS THE ONLY INTERESTING THING HERE. OAIY reports three protocols
 * and FormLogic deliberately claims two:
 *
 * - script (1) - the leaf-script envelope (`oaiy script`): one request carrying a condition, a
 *   logic block, an entry call or a Python project, answered per job. This is how FormLogic's
 *   author-written logic reaches an OAIY engine.
 * - profile (1) - the leaf-script profile (`protocol/v1/script-profile.schema.json`): the
 *   document FormLogic SERVES at GET /api/v1/script-profile, carrying its prelude and its
 *   Python contract, so a Desktop means the same thing by a flow condition that the browser
 *   does. `scripts/build-script-profile.mjs` generates it.
 * - run - NOT claimed. `oaiy run` executes an OAIY workflow file: OAIY's own graph, OAIY's own
 *   nodes. FormLogic never asks for one. Claiming it would make the fetcher refuse a release
 *   over a protocol FormLogic does not exercise, which is a false alarm that costs an engine
 *   upgrade; and it would tell anyone reading this file that FormLogic drives OAIY workflows,
 *   which it does not.
 *
 * Both versions are 1, read from what the CLI reports today (oaiy.com `capabilities --json`:
 * `protocols: {run: 1, script: 1, profile: 1}`). The numbers here are FormLogic's requirement,
 * not a mirror that must be kept in step: when OAIY moves `script` to 2, this file stays at 1
 * until FormLogic speaks 2, and the fetcher's refusal is the signal that the two have parted.
 */
import protocol from './protocol.json';

/** `oaiy script` - the leaf-script envelope FormLogic sends its author-written logic through. */
export const SCRIPT_PROTOCOL: number = protocol.script;

/** The `ScriptProfile` document FormLogic serves at GET /api/v1/script-profile. */
export const PROFILE_PROTOCOL: number = protocol.profile;

/** Every protocol FormLogic speaks, as the fetcher compares it. */
export const OAIY_PROTOCOLS: Readonly<Record<string, number>> = Object.freeze({ ...protocol });
