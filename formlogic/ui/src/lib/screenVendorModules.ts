// Built-in npm modules available to custom-screen bundles (the sandboxed iframe has no network,
// so the bundler must carry everything). TSX/JSX components run on Preact; 'react' / 'react-dom'
// alias to preact/compat so normal React-style code (`import { useState } from 'react'`) works
// unchanged. The sources are preact's own minified ESM dist files, inlined at build time via ?raw.
//
// ⚠️ This module weighs ~30KB of source strings — it is loaded LAZILY from screenCompile (alongside
// esbuild-wasm) so it never lands in the main bundle or on public form pages running precompiled js.

import preactSrc from 'preact?raw';
import hooksSrc from 'preact/hooks?raw';
import compatSrc from 'preact/compat?raw';
import compatClientSrc from 'preact/compat/client?raw';
import jsxRuntimeSrc from 'preact/jsx-runtime?raw';

/** Canonical vendor module id → ESM source. Aliases resolve to these ids first (see below) so
 *  e.g. 'react' and 'preact/compat' are the SAME module instance in the bundle — never two
 *  copies of compat with divergent state. */
export const VENDOR_MODULES: Record<string, string> = {
  'preact': preactSrc,
  'preact/hooks': hooksSrc,
  'preact/compat': compatSrc,
  'preact/compat/client': compatClientSrc,
  'preact/jsx-runtime': jsxRuntimeSrc,
};

/** Bare-import aliases → canonical vendor id. */
const VENDOR_ALIASES: Record<string, string> = {
  'react': 'preact/compat',
  'react-dom': 'preact/compat',
  'react-dom/client': 'preact/compat/client',
  'react/jsx-runtime': 'preact/jsx-runtime',
  'react/jsx-dev-runtime': 'preact/jsx-runtime',
  'preact/jsx-dev-runtime': 'preact/jsx-runtime',
};

/** Resolve a bare import specifier to a canonical vendor id, or null when it isn't a built-in. */
export function resolveVendorId(specifier: string): string | null {
  if (Object.prototype.hasOwnProperty.call(VENDOR_MODULES, specifier)) return specifier;
  return Object.prototype.hasOwnProperty.call(VENDOR_ALIASES, specifier) ? VENDOR_ALIASES[specifier] : null;
}

/** The names screens may import, for the honest bundle-error message. */
export const VENDOR_IMPORT_HINT = "react, react-dom/client, preact, preact/hooks";
