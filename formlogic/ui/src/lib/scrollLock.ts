// Shared body-scroll lock so the page can't scroll behind any open overlay. One
// module-level counter is shared by the Modal primitive AND useFocusTrap (custom
// dialogs), so a Modal and a focus-trap dialog can coexist without one's close
// prematurely unlocking the other.
let lockCount = 0;

export function lockBodyScroll(): void {
  lockCount++;
  document.body.style.overflow = 'hidden';
}

export function unlockBodyScroll(): void {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = '';
  }
}
