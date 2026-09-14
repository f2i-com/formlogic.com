// The protocol versions FormLogic shares with Softn, for the build and check
// scripts. Same source of truth as src/lib/softn/protocol.ts: protocol.json.
import { readFileSync } from 'node:fs';

const protocol = JSON.parse(readFileSync(new URL('../src/lib/softn/protocol.json', import.meta.url), 'utf8'));
for (const key of ['nativeProtocol', 'recordEvents', 'editorBridge']) {
  if (!Number.isInteger(protocol[key]) || protocol[key] < 1) throw new Error(`protocol.json: ${key} must be a positive integer`);
}

export const NATIVE_PROTOCOL = protocol.nativeProtocol;
export const RECORD_EVENTS_PROTOCOL = protocol.recordEvents;
export const EDITOR_BRIDGE_PROTOCOL = protocol.editorBridge;
