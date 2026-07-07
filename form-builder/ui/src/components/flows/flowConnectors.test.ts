import { describe, expect, it } from 'vitest';
import { deriveFlowConnectors } from './flowConnectors';
import type { App } from '../../types/app';
import type { CustomAppLogicBundle } from '../../types/customAppLogic';

function appWithLogic(bundle: CustomAppLogicBundle | undefined): Pick<App, 'customLogic'> {
  return { customLogic: bundle };
}

describe('deriveFlowConnectors', () => {
  it('returns [] for an app with no customLogic', () => {
    expect(deriveFlowConnectors(appWithLogic(undefined))).toEqual([]);
    expect(deriveFlowConnectors(null)).toEqual([]);
  });

  it('extracts connectors + commands from app-wide connector.<id>.<command> grants', () => {
    const bundle: CustomAppLogicBundle = {
      version: 1,
      runtime: 'quickjs',
      scripts: [],
      permissions: [
        'formlogic.responses.read',
        'connector.aokie.call.operatorSpeak',
        'connector.aokie.sms.send',
      ],
    };
    expect(deriveFlowConnectors(appWithLogic(bundle))).toEqual([
      { id: 'aokie', commands: ['call.operatorSpeak', 'sms.send'] },
    ]);
  });

  it('merges per-script grants and treats connector.<id>.* as the connector with no command', () => {
    const bundle: CustomAppLogicBundle = {
      version: 1,
      runtime: 'quickjs',
      permissions: ['connector.aokie.*'],
      scripts: [
        { id: 's1', hook: 'onConnectorEvent', runtime: 'quickjs', source: '', permissions: ['connector.stripe.charge.create'] },
      ],
    };
    expect(deriveFlowConnectors(appWithLogic(bundle))).toEqual([
      { id: 'aokie', commands: [] },
      { id: 'stripe', commands: ['charge.create'] },
    ]);
  });
});
