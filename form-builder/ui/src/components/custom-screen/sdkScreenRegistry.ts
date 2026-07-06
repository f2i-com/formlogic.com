// Registry of trusted, host-rendered SDK screens (spec §27.2 / §28).
//
// A stable Map of screenId → first-party React component. Only trusted, in-bundle screens register
// here — arbitrary/untrusted package UI must ship as a sandboxed 'code' screen, never host-rendered.
// Kept separate from SdkScreenRuntime.tsx so the runtime file exports only components (React Fast
// Refresh requirement).
import type { ComponentType } from 'react';

export type SdkScreenComponent = ComponentType<{ params?: Record<string, unknown> }>;

const REGISTRY = new Map<string, SdkScreenComponent>();

/** Register a first-party SDK screen. Called at module init by trusted screen bundles only. */
export function registerSdkScreen(id: string, component: SdkScreenComponent): void {
  REGISTRY.set(id, component);
}

export function getSdkScreen(id: string): SdkScreenComponent | undefined {
  return REGISTRY.get(id);
}

/** The ids of all registered SDK screens (for the Studio picker). */
export function listSdkScreens(): string[] {
  return Array.from(REGISTRY.keys());
}
