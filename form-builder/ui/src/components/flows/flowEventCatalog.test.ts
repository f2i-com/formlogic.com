// Flow event catalog parity with the Aokie Desktop manifest.
//
// The manifest declares the machine contract; the UI catalog adds labels/help. This test fails if
// a declared Aokie event/command is missing from the authoring catalog or if the UI invents a
// phantom aokie.* event name.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AOKIE_CONNECTOR_COMMANDS,
  AOKIE_EVENT_NAMES,
  FLOW_EVENT_CATALOG,
  flowEventGroupsForConnectors,
  mergeKnownConnectorCommands,
  type FlowTriggerEventEntry,
} from './flowEventCatalog';

interface AokieManifest {
  events: string[];
  connectors: Array<{ id: string; commands: string[] }>;
}

function manifest(): AokieManifest {
  return JSON.parse(
    readFileSync(join(__dirname, '../../../../desktop/src-tauri/resources/plugins/aokie/manifest.json'), 'utf8')
  ) as AokieManifest;
}

const eventEntries = (): FlowTriggerEventEntry[] =>
  FLOW_EVENT_CATALOG.filter((entry): entry is FlowTriggerEventEntry => entry.kind === 'event');

describe('flowEventCatalog parity', () => {
  it('covers every Aokie manifest event exactly once', () => {
    const declaredEvents = manifest().events;
    const declared = new Set(declaredEvents);
    const catalogEvents = eventEntries()
      .filter((entry) => entry.event.startsWith('aokie.'))
      .map((entry) => entry.event);

    expect([...AOKIE_EVENT_NAMES]).toEqual(declaredEvents);
    expect(new Set(catalogEvents)).toEqual(declared);
    expect(catalogEvents).toHaveLength(declared.size);
  });

  it('does not contain undeclared Aokie event names', () => {
    const declared = new Set(manifest().events);
    for (const entry of eventEntries()) {
      if (entry.event.startsWith('aokie.')) {
        expect(declared.has(entry.event), `${entry.event} is not declared in the manifest`).toBe(true);
      }
    }
    const phantomMissedCallEvent = ['aokie', 'call', 'missed'].join('.');
    expect(eventEntries().some((entry) => entry.event === phantomMissedCallEvent)).toBe(false);
  });

  it('keeps teach entries separate from event names', () => {
    const teach = FLOW_EVENT_CATALOG.filter((entry) => entry.kind === 'teach');
    expect(teach).toHaveLength(1);
    expect(teach[0]).toMatchObject({
      label: 'Missed call',
      event: 'aokie.call.ended',
      presetCondition: "event.data.outcome === 'missed'",
    });
  });

  it('every catalog item has author-facing copy and payload chips use event.data selectors', () => {
    for (const entry of FLOW_EVENT_CATALOG) {
      expect(entry.label.trim()).not.toBe('');
      expect(entry.description.trim()).not.toBe('');
      for (const hint of entry.payloadHints) {
        expect(hint.startsWith('$event.data.'), `${entry.id} hint ${hint}`).toBe(true);
      }
    }
  });

  it('covers every Aokie connector command from the manifest, including settings.set', () => {
    const aokie = manifest().connectors.find((connector) => connector.id === 'aokie');
    expect(aokie?.commands).toEqual([...AOKIE_CONNECTOR_COMMANDS]);
    expect(AOKIE_CONNECTOR_COMMANDS).toContain('settings.set');
  });

  it('filters Aokie event groups unless the aokie connector is available', () => {
    expect(flowEventGroupsForConnectors([]).map((group) => group.id)).toEqual(['formlogic']);
    expect(flowEventGroupsForConnectors(['stripe']).map((group) => group.id)).toEqual(['formlogic']);
    expect(flowEventGroupsForConnectors(['aokie']).map((group) => group.id)).toEqual([
      'aokie.calls',
      'aokie.sms',
      'aokie.device',
      'formlogic',
    ]);
  });

  it('only injects manifest-known Aokie commands when aokie is available', () => {
    expect(mergeKnownConnectorCommands('aokie', ['sms.send'], [])).toEqual(['sms.send']);
    const merged = mergeKnownConnectorCommands('aokie', ['sms.send'], ['aokie']);
    expect(merged[0]).toBe('sms.send');
    expect(new Set(merged)).toEqual(new Set(AOKIE_CONNECTOR_COMMANDS));
    expect(merged).toHaveLength(AOKIE_CONNECTOR_COMMANDS.length);
    expect(mergeKnownConnectorCommands('stripe', ['charge.create'], ['aokie'])).toEqual(['charge.create']);
  });
});
