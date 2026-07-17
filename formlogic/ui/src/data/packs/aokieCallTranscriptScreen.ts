// Pack-owned Calls transcript record screen (plan APP-505 PoC — self-contained apps, first slice).
//
// This is the SANDBOXED-CODE twin of the compiled registry screen
// `aokie-call-transcript` (components/custom-screen/aokie/AokieCallTranscriptScreen.tsx):
// the same chat-bubble transcript, but shipped INSIDE the pack as plain HTML/CSS/JS so the
// app is self-contained — no compiled-registry reference, and the operator can read/fork it
// in the Studio editor. The compiled screen + its registry entry stay untouched; rollback is
// flipping the Calls form's customScreen.recordScreen back to the sdk reference.
//
// Runtime contract (CustomScreenRuntime + RecordScreenPanel):
//  - runs in an opaque-origin iframe (sandbox="allow-scripts", strict CSP, no network);
//  - `window.FormLogic` is the only bridge: this screen uses `related()` (the record's
//    related-record groups) and `escapeHtml()` — both record()-class actions are
//    TRUSTED_ONLY, so the form's custom_screen_trust must be owner/verified;
//  - theme comes from the injected `--fl-*` CSS variables (screenTheme.ts) and the
//    `fl-dark` root class, so light/dark both work with token-only styling.

/**
 * True conversation order for transcript turns — the SAME rule the compiled screen uses:
 *  1. `spokenAt` (the plugin's speech-START stamp, ISO-8601 UTC — string compare is
 *     chronological): a caller line spoken OVER a bot reply sorts where it was SAID,
 *     not where it was committed;
 *  2. `turnIndex` orders rows from older plugins that predate the timestamp;
 *  3. `submittedAt` breaks the remaining ties.
 *
 * Exported for unit tests AND embedded into the sandboxed source below via
 * `compareTurns.toString()` — the tested function IS the shipped code (keep the body
 * plain ES5-compatible JS; type annotations are stripped by the bundler).
 */
export function compareTurns(
  a: { spokenAt?: string | null; turnIndex?: number | null; submittedAt?: string | null },
  b: { spokenAt?: string | null; turnIndex?: number | null; submittedAt?: string | null }
): number {
  if (a.spokenAt && b.spokenAt && a.spokenAt !== b.spokenAt) return a.spokenAt.localeCompare(b.spokenAt);
  if (a.turnIndex != null && b.turnIndex != null && a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
  return String(a.submittedAt || '').localeCompare(String(b.submittedAt || ''));
}

const HTML = `<div id="transcript" aria-label="Call transcript"></div>`;

// Token-only styling (--fl-* variables from the host palette) so the widget follows the
// app accent and flips with the viewer's light/dark theme automatically.
const CSS = `
html, body { background: transparent; }
body { padding: 14px 18px; }

#transcript .meta { margin: 0 0 10px; font-size: 12px; color: var(--fl-faint); }
#transcript .turns { display: flex; flex-direction: column; gap: 10px; max-height: 380px; overflow-y: auto; padding-right: 4px; }

#transcript .turn { display: flex; align-items: flex-start; gap: 8px; max-width: 86%; }
#transcript .turn.caller { flex-direction: row-reverse; align-self: flex-end; }

#transcript .avatar {
  flex: none; width: 24px; height: 24px; margin-top: 2px; border-radius: 999px;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 600;
}
#transcript .turn.agent .avatar { background: var(--fl-accent); color: var(--fl-accent-contrast); }
#transcript .turn.caller .avatar { background: var(--fl-track); color: var(--fl-muted); }

#transcript .bubble { min-width: 0; padding: 8px 12px; }
#transcript .turn.agent .bubble { border-radius: 4px 12px 12px 12px; background: var(--fl-surface-2); }
#transcript .turn.caller .bubble { border-radius: 12px 4px 12px 12px; background: var(--fl-surface); border: 1px solid var(--fl-border); }

#transcript .who { display: block; font-size: 11px; font-weight: 500; }
#transcript .turn.agent .who { color: var(--fl-accent); }
#transcript .turn.caller .who { color: var(--fl-muted); }
#transcript .text { margin: 2px 0 0; font-size: 14px; line-height: 1.45; color: var(--fl-text); white-space: pre-wrap; overflow-wrap: break-word; }

#transcript .more {
  align-self: center; margin: 4px 0; padding: 6px 14px; cursor: pointer;
  font: inherit; font-size: 12px; font-weight: 500; color: var(--fl-muted);
  background: var(--fl-surface); border: 1px solid var(--fl-border); border-radius: 999px;
}
#transcript .more:hover { background: var(--fl-surface-2); }

#transcript .state { padding: 20px 0; text-align: center; font-size: 13px; color: var(--fl-faint); }
#transcript .state.error { color: var(--fl-bad); }

#transcript .skeleton { height: 36px; width: 66%; border-radius: 12px; background: var(--fl-track); margin-bottom: 8px; animation: fl-pulse 1.4s ease-in-out infinite; }
#transcript .skeleton.right { margin-left: auto; }
@keyframes fl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
`;

const JS = `
// Calls record widget: renders this call's Transcript Turns as chat bubbles.
// Data comes from FormLogic.related() — the record's related groups (match-based join
// turns.call_id = calls.call_id) — so it works for every record the flow wrote.
// EVERY record value is escaped with FormLogic.escapeHtml before touching innerHTML.
(function () {
  var FL = window.FormLogic;
  var esc = FL.escapeHtml;
  var root = document.getElementById('transcript');

  // Turns rendered per "Load more" click; the full turn set stays in memory so a long
  // call does not paint hundreds of bubbles up front.
  var TURN_PAGE = 30;
  // The related endpoint's match-join cap: a group at exactly this size is almost
  // certainly truncated to the newest turns.
  var SERVER_TURN_CAP = 500;

  // True conversation order: speech-start stamp, then turn number, then commit time.
  var compareTurns = ${compareTurns.toString()};

  function toTurn(r) {
    var f = r.fields || {};
    var idx = f.turn_index;
    var turnIndex = typeof idx === 'number' ? idx
      : (typeof idx === 'string' && idx !== '' && !isNaN(Number(idx)) ? Number(idx) : null);
    return {
      id: r.id,
      speaker: typeof f.speaker === 'string' && f.speaker ? f.speaker : 'system',
      text: typeof f.text === 'string' ? f.text : String(f.text == null ? '' : f.text),
      turnIndex: turnIndex,
      spokenAt: typeof f.timestamp === 'string' && f.timestamp !== '' ? f.timestamp : null,
      submittedAt: r.submittedAt,
      // The audio model re-heard and corrected this line (source=audio_model).
      corrected: f.source === 'audio_model'
    };
  }

  // Caller sits right and neutral; the receptionist's own voice (Aokie, or the operator
  // standing in for it) sits left in the app accent.
  function speakerMeta(speaker) {
    if (speaker === 'caller') return { label: 'Caller', side: 'caller', initial: 'C' };
    if (speaker === 'operator') return { label: 'You', side: 'agent', initial: 'Y' };
    return { label: 'Aokie', side: 'agent', initial: 'A' };
  }

  function bubbleHtml(t) {
    var who = speakerMeta(t.speaker);
    var tip = t.corrected ? ' title="Corrected by the audio model"' : '';
    return '<div class="turn ' + who.side + '">'
      + '<span class="avatar" aria-hidden="true">' + esc(who.initial) + '</span>'
      + '<div class="bubble">'
      + '<span class="who">' + esc(who.label) + '</span>'
      + '<p class="text"' + tip + '>' + esc(t.text) + '</p>'
      + '</div></div>';
  }

  var state = { turns: null, error: null, visible: TURN_PAGE };

  function paint() {
    if (state.error) {
      root.innerHTML = '<p class="state error">' + esc(state.error) + '</p>';
      return;
    }
    if (state.turns === null) {
      root.innerHTML = '<div role="status" aria-label="Loading transcript">'
        + '<div class="skeleton"></div><div class="skeleton right"></div><div class="skeleton"></div></div>';
      return;
    }
    if (state.turns.length === 0) {
      root.innerHTML = '<p class="state">No transcript was recorded for this call.</p>';
      return;
    }
    var shown = state.turns.slice(0, state.visible);
    var meta = state.turns.length === 1 ? '1 turn' : state.turns.length + ' turns';
    if (state.turns.length >= SERVER_TURN_CAP) meta += ' - showing the most recent turns';
    var html = '<p class="meta">' + esc(meta) + '</p><div class="turns">';
    for (var i = 0; i < shown.length; i++) html += bubbleHtml(shown[i]);
    var remaining = state.turns.length - shown.length;
    if (remaining > 0) {
      html += '<button type="button" class="more" data-more>Load more ('
        + remaining + ' more ' + (remaining === 1 ? 'turn' : 'turns') + ')</button>';
    }
    html += '</div>';
    root.innerHTML = html;
  }

  root.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== root && !el.hasAttribute('data-more')) el = el.parentElement;
    if (!el || el === root) return;
    state.visible += TURN_PAGE;
    paint();
  });

  paint();

  FL.related().then(function (related) {
    var groups = Object.keys(related || {}).map(function (k) { return related[k]; });
    // Several forms link to Calls through a field named call_link (follow-up tasks do
    // too), so a fieldId match alone can pick the wrong group — require the group to
    // actually carry transcript turns (speaker + text).
    function looksLikeTurns(g) {
      var cols = g.columns || [];
      function hasCol(id) { return cols.some(function (c) { return c.id === id; }); }
      if (hasCol('speaker') && hasCol('text')) return true;
      var f = g.records && g.records[0] && g.records[0].fields;
      return !!f && 'speaker' in f && 'text' in f;
    }
    var group = null;
    for (var i = 0; i < groups.length; i++) {
      if (groups[i] && groups[i].fieldId === 'call_link' && looksLikeTurns(groups[i])) { group = groups[i]; break; }
    }
    var rows = ((group && group.records) || []).map(toTurn);
    rows.sort(compareTurns);
    state.turns = rows;
    paint();
  }).catch(function (e) {
    state.error = (e && e.message) || 'Failed to load the transcript';
    paint();
  });
})();
`;

/**
 * The customScreen.recordScreen payload for the Calls form (kind 'code').
 * consumesRelated keeps hiding the transcript-turns.call_link group from the generic
 * related panel — this widget renders that data itself.
 */
export const AOKIE_CALL_TRANSCRIPT_SCREEN = {
  kind: 'code' as const,
  title: 'Transcript',
  consumesRelated: ['transcript-turns.call_link'],
  height: 480,
  html: HTML,
  css: CSS,
  js: JS,
};
