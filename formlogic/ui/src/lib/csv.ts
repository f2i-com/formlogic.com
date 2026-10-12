// One cell of a CSV the browser writes (the responses table's filtered export, Analytics' local
// export, a private form's decrypted export).

/** A plain decimal number, optionally negative: what a spreadsheet reads as a number and never as a formula. */
const PLAIN_NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A quoted CSV cell. Quotes are doubled, and text that starts like a formula (`=`, `+`, `-`, `@`,
 * TAB or CR, after any leading whitespace) gets a leading apostrophe so a spreadsheet shows it
 * rather than evaluating it, as the server's export does (ResponseService::exportResponsesStreaming).
 *
 * A plain number is written as it is, negative ones included. The cells here are text by the time
 * they are written, so the number is recognised by its form; the server goes by the stored type
 * instead, so a text answer that is exactly a number (`-5` typed into a text field) is written
 * bare here and with the apostrophe there. Either way it cannot be a formula.
 */
export function csvEscapeCell(val: unknown): string {
  let str = String(val ?? '').replace(/"/g, '""');
  if (/^\s*[=+\-@\t\r]/.test(str) && !PLAIN_NUMBER.test(str)) str = "'" + str;
  return `"${str}"`;
}
