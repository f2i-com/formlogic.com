/**
 * Which engine a hosted app's frame boots, as a pure rule over three facts: what the server
 * decided, what the frame's shell announced it can serve, and what this page holds bytes for.
 *
 * The decision is the server's, but it is made from an install record rather than from the
 * document that actually answered, so the frame treats it as a request. Nothing here reaches a
 * DOM, a message or a fetch, so the rule can be read and tested on its own.
 */

/** What a hosted-runtime shell must announce for an engine whose bytes this page holds. */
export type EngineIdentity = { version: string; sha256: string };

/**
 * An engine that IS its document: it runs the author's code as the shell's own JavaScript, so
 * there are no engine bytes for this page to hold, fetch or compare. The shell announces exactly
 * this value for such an engine, and matching it is the whole of the identity check — there is
 * nothing else to be right or wrong about. It is a boolean rather than an object precisely so it
 * can never be confused with a ZIPP identity, in either direction.
 */
export const OWN_DOCUMENT_ENGINE = true;

/** What a page holds for one engine: the bytes' identity, or {@link OWN_DOCUMENT_ENGINE}. */
export type FrameEngineBytes = EngineIdentity | typeof OWN_DOCUMENT_ENGINE;

/** The engine every hosted app has always run, and the one anything unusable falls back to. */
export const DEFAULT_ENGINE = 'zipp-web-python';

/**
 * The author's code run as the runtime document's own JavaScript, with no VM around it. It is an
 * explicit transfer of trust to an owner an administrator verified, and what contains it is the
 * frame: the opaque origin, the sandbox attribute and the response headers, none of which this
 * module decides.
 */
export const HOST_JS_ENGINE = 'host-js';

/** The runtime document serving the ZIPP engines: the policy every hosted app has always had. */
export const ZIPP_DOCUMENT = '/hosted-runtime/index.html';
/**
 * The runtime document serving {@link HOST_JS_ENGINE}. It is {@link ZIPP_DOCUMENT} plus one
 * attribute, and the attribute is why it is a second file: host JavaScript cannot exist without
 * `'unsafe-eval'` in the shell's policy, and a policy can be tightened after it is written but
 * never relaxed. So the weaker policy gets its own document and `index.html` keeps its own.
 */
export const HOST_JS_DOCUMENT = '/hosted-runtime/host.html';

/**
 * Which runtime document to mount for the engine the SERVER decided.
 *
 * The document has to be chosen before the frame loads, which is before any `ready` can arrive:
 * it is the document that decides the policy, what its shell announces and what `init` it will
 * accept. Anything that is not host JavaScript — including an id this page does not know, which
 * will fall back — is the document every hosted app has always been mounted on.
 */
export function frameSource(id: string | undefined): string {
  return id === HOST_JS_ENGINE ? HOST_JS_DOCUMENT : ZIPP_DOCUMENT;
}

/**
 * Identity equality BY VALUE. A shell's announcement crosses a structured clone, and the same
 * identity object arrives as `ready.zipp` and as `ready.engines[id]`; neither is ever the object
 * this page holds, so only the fields can be compared.
 *
 * An engine that is its own document announces {@link OWN_DOCUMENT_ENGINE} and nothing else will
 * do: an object carrying a version and a digest is a shell describing ENGINE BYTES, which is a
 * shell answering about a different kind of engine than the one that was asked for.
 */
export function sameIdentity(announced: unknown, identity: FrameEngineBytes | undefined): boolean {
  if (identity === OWN_DOCUMENT_ENGINE) return announced === OWN_DOCUMENT_ENGINE;
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
 * The engine to boot: the server's decision only when both sides can honour it, or `null` when
 * the document that was mounted cannot honour anything.
 *
 * It is passed through only when the shell announced that id AND this page holds, for that id,
 * what the announcement matches; anything else falls back to {@link DEFAULT_ENGINE}. Both ends of
 * that stay backward compatible: a shell from before the handshake announces no `engines` at all,
 * and the fallback is never required to be announced.
 *
 * The one thing that CANNOT fall back is host JavaScript, and not falling back is the point.
 * {@link frameSource} has already mounted {@link HOST_JS_DOCUMENT} by then, and that document
 * serves host-js alone — it refuses a ZIPP `init` by name. Worse, a caller reading `ready` would
 * be handed one anyway: the announcement for an unlisted engine falls back to the shell's lone
 * `zipp` field, which on the host document is a perfectly valid ZIPP identity describing an engine
 * that document will not run. So a host-js request that the shell did not announce yields `null`,
 * which the caller reports as an out-of-date runtime rather than initialising anything.
 *
 * `installed` is the parent's half (zipp-bytes' engineIdentity), injected so this rule needs no
 * page, frame or fetch to be exercised.
 */
export function chooseFrameEngine(
  requested: { id: string } | undefined,
  readyEngines: unknown,
  installed: (id: string) => FrameEngineBytes | undefined,
): string | null {
  const id = requested?.id;
  const honoured =
    typeof id === 'string' &&
    !!readyEngines && typeof readyEngines === 'object' && Object.hasOwn(readyEngines, id) &&
    sameIdentity((readyEngines as Record<string, unknown>)[id], installed(id));
  if (id === HOST_JS_ENGINE) return honoured ? HOST_JS_ENGINE : null;
  if (typeof id !== 'string' || id === DEFAULT_ENGINE) return DEFAULT_ENGINE;
  return honoured ? id : DEFAULT_ENGINE;
}
