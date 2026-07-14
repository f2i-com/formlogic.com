import type { KeyboardEvent } from 'react';

/**
 * Roving-tabindex arrow-key navigation for an option group whose option <button>
 * elements are DIRECT siblings sharing the same role (radio/checkbox). Moves focus
 * with Up/Down/Left/Right (wrap-around) and, for radiogroups (selectFollowsFocus),
 * updates selection to follow focus per the ARIA radiogroup pattern.
 *
 * stopPropagation() keeps the arrow keys from reaching the page-level Enter/nav
 * handler. The buttons render in `options` order and are filtered by role, so the
 * focused button's sibling index lines up with `options[next]`.
 */
export function handleRovingKeys<T extends { value: string }>(
  e: KeyboardEvent<HTMLButtonElement>,
  options: T[],
  selectFollowsFocus: boolean,
  onChange?: (value: string) => void,
): void {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  const role = e.currentTarget.getAttribute('role');
  const buttons = Array.from(e.currentTarget.parentElement?.children ?? [])
    .filter((c): c is HTMLElement => c instanceof HTMLElement && c.getAttribute('role') === role);
  const i = buttons.indexOf(e.currentTarget);
  if (i < 0 || buttons.length === 0) return;
  const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
  const next = forward ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
  buttons[next].focus();
  if (selectFollowsFocus && onChange && options[next]) onChange(options[next].value);
}
