/** @jsxImportSource preact */
// FormLogic screen kit - the built-in component library for sandboxed custom screens.
//
// Screens import it as a BARE module: `import { Card, Button } from 'formlogic/kit'` - the
// sandbox bundler ships this source as an embedded vendor module (screenVendorModules.ts), so
// no network is involved and pack-owned screens may use it too (it counts as a built-in).
//
// Every component styles itself on the injected --fl-* theme tokens (screenTheme.ts), so kit
// UIs follow the app accent and flip with the viewer's light/dark theme automatically. The
// stylesheet self-injects ONCE on first use (the iframe CSP allows inline styles).
//
// Keep this file ASCII-only and token-only (no hex colors) - pack screens shipping kit-based
// UIs must stay policy-clean, and the kit is the example they follow.
import type { ComponentChildren, JSX } from 'preact';

const KIT_CSS = `
.flk-card { background: var(--fl-surface); border: 1px solid var(--fl-border); border-radius: 14px; padding: 14px 16px; box-shadow: var(--fl-shadow); }
.flk-card + .flk-card { margin-top: 12px; }
.flk-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 10px; }
.flk-card-title { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fl-muted); }
.flk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--fl-border); background: var(--fl-surface); color: var(--fl-text); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease; }
.flk-btn:hover:not(:disabled) { background: var(--fl-surface-2); border-color: var(--fl-accent); }
.flk-btn:focus-visible { outline: 2px solid var(--fl-accent); outline-offset: 2px; }
.flk-btn:disabled { opacity: 0.55; cursor: default; }
.flk-btn.primary { background: var(--fl-accent); border-color: var(--fl-accent); color: var(--fl-accent-contrast); }
.flk-btn.primary:hover:not(:disabled) { background: var(--fl-accent); filter: brightness(1.08); }
.flk-btn.danger { color: var(--fl-bad); border-color: var(--fl-bad); background: var(--fl-surface); }
.flk-field { display: block; margin: 0 0 12px; }
.flk-label { display: block; margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--fl-text); }
.flk-hint { margin: 4px 0 0; font-size: 11.5px; color: var(--fl-faint); }
.flk-input { width: 100%; box-sizing: border-box; padding: 8px 12px; border-radius: 9px; border: 1px solid var(--fl-border); background: var(--fl-bg); color: var(--fl-text); font: inherit; font-size: 13.5px; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.flk-input:focus { outline: none; border-color: var(--fl-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--fl-accent) 18%, transparent); }
textarea.flk-input { min-height: 84px; resize: vertical; }
.flk-stat { display: inline-flex; flex-direction: column; gap: 2px; padding: 10px 16px; border-radius: 12px; background: var(--fl-surface-2); }
.flk-stat b { font-size: 20px; line-height: 1.15; color: var(--fl-accent); }
.flk-stat span { font-size: 11.5px; color: var(--fl-muted); }
.flk-badge { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; line-height: 1.5; background: var(--fl-surface-2); color: var(--fl-muted); white-space: nowrap; }
.flk-badge.ok { color: var(--fl-good); background: color-mix(in srgb, currentColor 12%, var(--fl-surface-2)); }
.flk-badge.warn { color: var(--fl-warn); background: color-mix(in srgb, currentColor 12%, var(--fl-surface-2)); }
.flk-badge.bad { color: var(--fl-bad); background: color-mix(in srgb, currentColor 12%, var(--fl-surface-2)); }
.flk-badge.accent { color: var(--fl-accent); background: color-mix(in srgb, currentColor 12%, var(--fl-surface-2)); }
.flk-empty { padding: 26px 12px; text-align: center; }
.flk-empty p { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--fl-muted); }
.flk-empty small { display: block; margin-top: 4px; font-size: 12px; color: var(--fl-faint); }
.flk-skel { display: block; border-radius: 8px; background: var(--fl-track); animation: flk-pulse 1.4s ease-in-out infinite; }
@keyframes flk-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.flk-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.flk-toolbar .spacer { flex: 1; }
`;

let stylesInjected = false;

/** Inject the kit stylesheet once per document (idempotent; safe to call anywhere). */
export function ensureKitStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  if (document.getElementById('flk-styles')) { stylesInjected = true; return; }
  const el = document.createElement('style');
  el.id = 'flk-styles';
  el.textContent = KIT_CSS;
  document.head.appendChild(el);
  stylesInjected = true;
}

export interface CardProps {
  /** Rendered as the uppercase eyebrow heading. */
  title?: ComponentChildren;
  /** Right-aligned header slot (buttons, badges). */
  actions?: ComponentChildren;
  children?: ComponentChildren;
}

export function Card({ title, actions, children }: CardProps) {
  ensureKitStyles();
  return (
    <section class="flk-card">
      {(title || actions) && (
        <div class="flk-card-head">
          {title ? <h2 class="flk-card-title">{title}</h2> : <span />}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export interface ButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'class' | 'className' | 'type'> {
  variant?: 'default' | 'primary' | 'danger';
  type?: 'button' | 'submit' | 'reset';
  children?: ComponentChildren;
}

export function Button({ variant = 'default', children, type, ...rest }: ButtonProps) {
  ensureKitStyles();
  const cls = 'flk-btn' + (variant === 'default' ? '' : ' ' + variant);
  return (
    <button class={cls} type={type ?? 'button'} {...rest}>
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: ComponentChildren; hint?: ComponentChildren; children?: ComponentChildren }) {
  ensureKitStyles();
  return (
    <label class="flk-field">
      <span class="flk-label">{label}</span>
      {children}
      {hint && <p class="flk-hint">{hint}</p>}
    </label>
  );
}

type InputProps = Omit<JSX.HTMLAttributes<HTMLInputElement>, 'class' | 'className'>;
export function Input(props: InputProps) {
  ensureKitStyles();
  return <input class="flk-input" {...props} />;
}

type SelectProps = Omit<JSX.HTMLAttributes<HTMLSelectElement>, 'class' | 'className'> & { children?: ComponentChildren };
export function Select({ children, ...rest }: SelectProps) {
  ensureKitStyles();
  return <select class="flk-input" {...rest}>{children}</select>;
}

type TextareaProps = Omit<JSX.HTMLAttributes<HTMLTextAreaElement>, 'class' | 'className'>;
export function Textarea(props: TextareaProps) {
  ensureKitStyles();
  return <textarea class="flk-input" {...props} />;
}

export function Stat({ label, value }: { label: ComponentChildren; value: ComponentChildren }) {
  ensureKitStyles();
  return (
    <p class="flk-stat">
      <b>{value}</b>
      <span>{label}</span>
    </p>
  );
}

export function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'bad' | 'accent' | 'muted'; children?: ComponentChildren }) {
  ensureKitStyles();
  const cls = 'flk-badge' + (tone && tone !== 'muted' ? ' ' + tone : '');
  return <span class={cls}>{children}</span>;
}

export function EmptyState({ title, hint }: { title: ComponentChildren; hint?: ComponentChildren }) {
  ensureKitStyles();
  return (
    <div class="flk-empty">
      <p>{title}</p>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function Skeleton({ width = '100%', height = 16 }: { width?: string | number; height?: string | number }) {
  ensureKitStyles();
  const dim = (v: string | number) => (typeof v === 'number' ? `${v}px` : v);
  return <span class="flk-skel" style={{ width: dim(width), height: dim(height) }} />;
}

export function Toolbar({ children }: { children?: ComponentChildren }) {
  ensureKitStyles();
  return <div class="flk-toolbar">{children}</div>;
}

/** A flexible gap inside a Toolbar (pushes what follows to the right). */
export function Spacer() {
  return <span class="spacer" />;
}
