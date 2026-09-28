/** @jsxImportSource preact */
// On the OAIY route the model, speech, voice, turn-taking and replies are
// OAIY's: FormLogic stops pushing them (Aokie ignores them there, and a pushed
// lane would only fight OAIY's choice). This card says where each one lives
// now, in place of the voice, speech and audio cards.

const ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ['replies', 'Replies', "OAIY > Agent > Front desk: its /brief.md, knowledge files and each caller's notes. The brief on this page is added to it."],
  ['instructions', 'Call instructions', 'OAIY > Agent > Phone: your instructions for calls and texts, and whether the agent answers calls at all.'],
  ['model', 'Model', 'OAIY > Engines: the Front desk agent answers with the model chosen there.'],
  ['speech', 'Hearing and voice', 'OAIY Voice: Parakeet hears the caller, and Qwen3-TTS speaks in the voice chosen in OAIY.'],
  ['turns', 'Turn-taking', 'OAIY Voice decides: it talks on over an "mm-hmm" and stops for a real interruption.'],
  ['callbacks', 'Missed-call callbacks', 'OAIY > Agent > Phone > Missed calls. FormLogic\'s follow-ups do not ring them back on this route.'],
];

export function SetInOaiyCard() {
  return (
    <section class="card" data-set-in-oaiy aria-label="Set in OAIY">
      <h2>Set in OAIY</h2>
      <p class="muted">These are OAIY's on this route, so this page does not send them. Change them in OAIY Desktop.</p>
      <dl class="facts pointers">
        {ROWS.map(([key, label, where]) => (
          <div key={key} data-set-in-oaiy-row={key}>
            <dt>{label}</dt>
            <dd>{where}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
