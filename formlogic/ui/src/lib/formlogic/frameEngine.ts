/**
 * Which engine a hosted app's frame boots, as a pure rule over three facts: what the server
 * decided, what the frame's shell announced it can serve, and what this page holds bytes for.
 *
 * The decision is the server's, but it is made from an install record rather than from the
 * document that actually answered, so the frame treats it as a request. Nothing here reaches a
 * DOM, a message or a fetch, so the rule can be read and tested on its own.
 */

import type { EngineIdentity } from './zipp-bytes';

/** The engine every hosted app has always run, and the one anything unusable falls back to. */
export const DEFAULT_ENGINE = 'zipp-web-python';

/**
 * Identity equality BY VALUE. A shell's announcement crosses a structured clone, and the same
 * identity object arrives as `ready.zipp` and as `ready.engines[id]`; neither is ever the object
 * this page holds, so only the fields can be compared.
 */
export function sameIdentity(announced: unknown, identity: EngineIdentity | undefined): boolean {
  if (!identity || !announced || typeof announced !== 'object') return false;
  const value = announced as { version?: unknown; sha256?: unknown };
  return value.version === identity.version && value.sha256 === identity.sha256;
}

/** What a shell announced for one engine: its `engines` entry, or the lone `zipp` an older shell sends. */
export function announcedIdentity(data: { engines?: unknown; zipp?: unknown }, id: string): unknown {
  const engines = data.engines;
  if (engines && typeof engines === 'object' && Object.hasOwn(engines, id)) return (engines as Record<string, unknown>)[id];
  return data.zipp;
}

/**
 * The engine to boot: the server's decision only when both sides can honour it.
 *
 * It is passed through only when the shell announced that id AND this page holds bytes whose
 * identity the announcement matches; anything else falls back to {@link DEFAULT_ENGINE}. Both
 * ends of that stay backward compatible: a shell from before the handshake announces no `engines`
 * at all, and the fallback is never required to be announced.
 *
 * `installed` is the parent's half (zipp-bytes' engineIdentity), injected so this rule needs no
 * page, frame or fetch to be exercised.
 */
export function chooseFrameEngine(
  requested: { id: string } | undefined,
  readyEngines: unknown,
  installed: (id: string) => EngineIdentity | undefined,
): string {
  const id = requested?.id;
  if (typeof id !== 'string' || id === DEFAULT_ENGINE) return DEFAULT_ENGINE;
  if (!readyEngines || typeof readyEngines !== 'object' || !Object.hasOwn(readyEngines, id)) return DEFAULT_ENGINE;
  const identity = installed(id);
  if (!identity) return DEFAULT_ENGINE;
  return sameIdentity((readyEngines as Record<string, unknown>)[id], identity) ? id : DEFAULT_ENGINE;
}
