// The stack of open dialogs, oldest first: the shared <Modal> and every hand-rolled overlay
// that traps focus (useFocusTrap) register here while they are open.
//
// Only the dialog on TOP may act on Escape and Tab. Without this a dialog underneath
// another one closes on the Escape meant for the one above it (taking everything mounted
// inside it along, e.g. a wizard opened from Form settings and the recovery kit it is
// showing), and its focus trap pulls Tab focus out of the dialog on top.

const stack: string[] = [];

export function pushDialog(id: string): void {
  if (!stack.includes(id)) stack.push(id);
}

export function removeDialog(id: string): void {
  const index = stack.indexOf(id);
  if (index >= 0) stack.splice(index, 1);
}

/** True when `id` is the dialog opened most recently and still open. */
export function isTopDialog(id: string): boolean {
  return stack.at(-1) === id;
}
