// Leaf module: the Aokie receptionist's built-in default persona.
//
// Extracted from aokieReceptionistPack.ts so it has NO imports of its own — the
// pack, the console payload composer (receptionistPayload.ts), AND the pack-owned
// Receptionist Settings screen all import DEFAULT_PERSONA from HERE. That keeps
// the import graph acyclic: without this leaf, `pack → settingsScreen →
// receptionistPayload → pack` (for DEFAULT_PERSONA) is a cycle, and the screen's
// module-init `JSON.stringify(DEFAULT_PERSONA)` embed would hit the temporal dead
// zone (the pack's const isn't initialized yet while the pack is resolving the
// screen import). A leaf sink can never be in a cycle, so the value is always
// ready when embedded.
//
// Byte-identical to docs/contracts/aokie-persona.v1.json (the plugin's
// DEFAULT_AGENT_PERSONA is locked to the same file). It is business context
// only: the agent that reads it - OAIY's Front desk agent as its receptionist
// brief, or Aokie's own - brings its own rules, so it gives no name, no
// sentence limits and no stock phrases. It keeps the one promise that matters
// (audit AK-009/C-16): bookings made on a call are REQUESTS a person confirms.
export const DEFAULT_PERSONA =
  'A small business answers this phone. People call to ask a question, to book a time, or to leave a message for the team. Bookings made on a call are requests: someone from the team confirms each one with the caller afterwards. When someone needs a call back, the team needs their name, what it is about, and a good number and time to reach them.';
