// Aokie DEMO driver (pack-embedded, sandboxed QuickJS; see packConnectorDriver.ts).
//
// Ported 1:1 from the retired browser mock (client-runtime/connectors/aokieConnector.ts,
// mockAokieConnector + simulateIncomingCall). This script is a PURE state machine:
// the host passes ctx.state in and persists the returned state; ctx.now is the only
// clock (never Date.now()); events are declared in the returned envelope list and the
// HOST allowlists them against manifest.demoEvents and stamps data.simulated itself.
// Errors return typed as { error: { code, message } } - the host folds unknown codes
// to command_failed, so only command_failed / stale_call / connector_unavailable are
// meaningful here.
//
// Provenance rules (audit FL-CONN-001): this driver only ever answers inside an
// explicit simulator session, brokered by the host - it must NOT add a `simulated`
// flag itself (the trusted host stamps results and event data).

function run(ctx) {
  var state = ctx.state;
  if (!state) state = initialState();
  if (ctx.fn === 'request') return handleRequest(ctx, state);
  if (ctx.fn === 'ceremonyStep') return handleCeremonyStep(ctx, state);
  return { error: { code: 'command_failed', message: 'unknown driver entry point' }, state: state };
}

function initialState() {
  return {
    currentCall: null,
    smsCounter: 0,
    // Operator-spoken demo turns need idempotency keys that can never collide
    // with the scripted sequence's turn.0/turn.1 - start well above them.
    turnCounter: 100,
    // Simulator plugin settings - enough surface for the Receptionist Settings
    // console (settings.get whole-object + typed-ish settings.set). managerPin
    // is write-only parity: never stored back into the readable map.
    configVersion: 7,
    managerPinSet: false,
    settings: {
      autoAnswer: true,
      aiReceptionist: true,
      greeting: 'Thanks for calling! How can I help you today?',
      ttsVoice: '',
      aiModel: '',
      ttsEngine: '',
      ttsModelDir: ''
    },
    ceremonyCallId: null
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// Contract-shaped envelope declaration ('aokie:<correlationId>:<step>:v1' keys,
// AOKIE_PLUGIN_CONTRACT.md section 4). The host builds the real envelope.
function ev(name, correlationId, stepKey, data) {
  return {
    name: name,
    correlationId: correlationId,
    idempotencyKey: 'aokie:' + correlationId + ':' + stepKey + ':v1',
    data: data
  };
}

function refuse(state, code, message) {
  return { error: { code: code, message: message }, state: state };
}

/**
 * Demo twin of the plugin's callId guard (audit C-01): a supplied callId that
 * is not the current call is the typed stale_call error, and state requirements
 * surface as command_failed - the demo bridge fails the same way the real
 * plugin does, so the Live Call screen can be exercised honestly.
 * Returns { call } or { error }.
 */
function checkCall(state, command, payload, allowed) {
  var p = payload || {};
  var current = state.currentCall;
  if (typeof p.callId === 'string' && (!current || p.callId !== current.callId)) {
    return {
      error: {
        code: 'stale_call',
        message: current
          ? 'callId ' + p.callId + ' is not the current call (' + current.callId + ')'
          : 'callId ' + p.callId + ' is stale: there is no current call'
      }
    };
  }
  if (!current) return { error: { code: 'command_failed', message: command + ': no active call' } };
  if (allowed.indexOf(current.state) === -1) {
    return {
      error: {
        code: 'command_failed',
        message: command + ': call ' + current.callId + ' is ' + current.state + ', not ' + allowed.join('/')
      }
    };
  }
  return { call: current };
}

function copyCallWithState(call, newState) {
  return {
    callId: call.callId,
    direction: call.direction,
    from: call.from,
    callerName: call.callerName,
    state: newState,
    startedAt: call.startedAt
  };
}

function mockDongles() {
  return [
    {
      id: 'usb-0a12-0001',
      name: 'CSR 4.0 Bluetooth dongle',
      vendorId: '0a12',
      productId: '0001',
      driverInstalled: true,
      preferred: true
    },
    {
      id: 'usb-0b05-190e',
      name: 'ASUS USB-BT400',
      vendorId: '0b05',
      productId: '190e',
      driverInstalled: false,
      preferred: false
    }
  ];
}

// Demo twin of the plugin's ttsVoiceCatalog side key (whole-object settings.get
// only - AOKIE_PLUGIN_CONTRACT.md section 2): a plausible on-disk voice
// inventory so the demo console exercises the engine-first pickers.
function ttsVoiceCatalog() {
  return {
    engines: [
      {
        id: 'pocket',
        label: 'Pocket-TTS',
        voices: ['alba', 'cosette', 'eponine', 'fantine', 'javert', 'jean', 'marius']
      },
      {
        id: 'sherpa',
        label: 'Sherpa (Piper/VITS/Kokoro)',
        bundles: [
          {
            dir: 'C:/aokie/models/tts/vits-piper-en_US-lessac-medium',
            name: 'vits-piper-en_US-lessac-medium',
            kind: 'vits'
          }
        ],
        scanRoot: 'C:/aokie/models/tts'
      }
    ]
  };
}

function mockThreads(now) {
  return [
    {
      threadId: 'thr_demo_1',
      address: '+61400111222',
      displayName: 'Riley Chen',
      lastMessage: 'Thanks, see you at 2pm.',
      lastAt: iso(now - 45 * 60000),
      unread: 0
    },
    {
      threadId: 'thr_demo_2',
      address: '+61400333444',
      displayName: 'Jordan Blake',
      lastMessage: 'Can I move my booking to Friday?',
      lastAt: iso(now - 3 * 3600000),
      unread: 1
    }
  ];
}

function handleRequest(ctx, state) {
  var command = ctx.command;
  var payload = ctx.payload || {};
  var guard;
  var call;

  if (command === 'dongle.list') {
    return { result: { dongles: mockDongles() }, state: state };
  }

  if (command === 'phone.status') {
    // Canonical shape (audit C-02): the device is NESTED under `device` exactly
    // like the real plugin's radio response - never a root-level deviceName the
    // real path does not have.
    return {
      result: {
        paired: true,
        connected: true,
        device: {
          address: '00:11:22:33:44:55',
          name: 'Demo Phone',
          pairedAt: iso(ctx.now - 86400000)
        },
        battery: 82,
        signal: 4,
        source: 'mock'
      },
      state: state
    };
  }

  if (command === 'call.current') {
    return { result: { call: state.currentCall }, state: state };
  }

  if (command === 'call.answer') {
    guard = checkCall(state, 'call.answer', payload, ['ringing']);
    if (guard.error) return { error: guard.error, state: state };
    call = guard.call;
    state.currentCall = copyCallWithState(call, 'active');
    return {
      result: { answered: true },
      state: state,
      events: [
        ev('aokie.call.answered', call.callId, 'answered', {
          callId: call.callId,
          answeredBy: 'operator'
        })
      ]
    };
  }

  if (command === 'call.dial') {
    // Phase 2 mock parity: validates like the plugin (number shape + required
    // opening line) and emits the outbound.dialing envelope so demo flows can
    // bind to it. No simulated conversation follows - the demo has no remote
    // party to answer.
    var number = typeof payload.number === 'string' ? payload.number.trim() : '';
    var openingLine = typeof payload.openingLine === 'string' ? payload.openingLine.trim() : '';
    var purpose = typeof payload.purpose === 'string' ? payload.purpose : null;
    var phoneShape = new RegExp('^\\+?[0-9][0-9 ()\\-.]{4,}$');
    if (!phoneShape.test(number)) {
      return refuse(state, 'command_failed', 'call.dial requires a phone-format {number}.');
    }
    if (!openingLine) {
      return refuse(
        state,
        'command_failed',
        'call.dial requires {openingLine} - the exact first words spoken when they answer.'
      );
    }
    if (state.currentCall && state.currentCall.state !== 'ended') {
      return refuse(
        state,
        'command_failed',
        'a call is already in progress - outbound dialing needs an idle line.'
      );
    }
    var dialCallId = 'call_demo_' + ctx.now.toString(36);
    return {
      result: { accepted: true, queued: true, callId: dialCallId, to: number },
      state: state,
      events: [
        ev('aokie.call.outbound.dialing', dialCallId, 'outbound.dialing', {
          callId: dialCallId,
          to: number,
          purpose: purpose
        })
      ]
    };
  }

  if (command === 'call.reject') {
    guard = checkCall(state, 'call.reject', payload, ['ringing']);
    if (guard.error) return { error: guard.error, state: state };
    call = guard.call;
    state.currentCall = copyCallWithState(call, 'ended');
    return {
      result: { rejected: true },
      state: state,
      events: [
        ev('aokie.call.rejected', call.callId, 'rejected', {
          callId: call.callId,
          reason: 'operator_reject'
        })
      ]
    };
  }

  if (command === 'call.hangup') {
    guard = checkCall(state, 'call.hangup', payload, ['ringing', 'active']);
    if (guard.error) return { error: guard.error, state: state };
    call = guard.call;
    state.currentCall = copyCallWithState(call, 'ended');
    var durationSeconds = Math.max(
      0,
      Math.round((ctx.now - new Date(call.startedAt).getTime()) / 1000)
    );
    return {
      result: { ended: true },
      state: state,
      events: [
        ev('aokie.call.ended', call.callId, 'ended', {
          callId: call.callId,
          from: call.from,
          callerPhone: call.from,
          reason: 'operator_hangup',
          durationSeconds: durationSeconds,
          outcome: 'completed'
        })
      ]
    };
  }

  if (command === 'call.operatorSpeak') {
    // Section 9.2 parity: inResponseTo (the caller turn number the speech
    // answers) is type-checked like the plugin does; the demo never simulates
    // caller turns, so staleness itself is not simulated.
    if (typeof payload.text !== 'string' || !payload.text.trim()) {
      return refuse(state, 'command_failed', 'call.operatorSpeak requires {text}.');
    }
    if (
      payload.inResponseTo !== undefined &&
      payload.inResponseTo !== null &&
      typeof payload.inResponseTo !== 'number'
    ) {
      return refuse(
        state,
        'command_failed',
        'call.operatorSpeak inResponseTo must be the caller turn NUMBER the speech answers.'
      );
    }
    guard = checkCall(state, 'call.operatorSpeak', payload, ['active']);
    if (guard.error) return { error: guard.error, state: state };
    call = guard.call;
    state.turnCounter = state.turnCounter + 1;
    return {
      result: { spoken: true, mock: true },
      state: state,
      events: [
        ev('aokie.call.turn.final', call.callId, 'turn.' + state.turnCounter + '.final', {
          callId: call.callId,
          turn: state.turnCounter,
          speaker: 'operator',
          text: payload.text
        })
      ]
    };
  }

  if (command === 'call.configureAgent') {
    // Phase 0 / section 9.3 parity with the plugin: call-scoped persona/greeting.
    // callId is REQUIRED (no legacy window on a new surface) and must be the
    // current call; empty config is refused, not silently accepted.
    if (typeof payload.callId !== 'string' || !payload.callId) {
      return refuse(state, 'command_failed', 'call.configureAgent requires {callId}.');
    }
    var persona = typeof payload.persona === 'string' ? payload.persona.trim() : '';
    var greeting = typeof payload.greeting === 'string' ? payload.greeting.trim() : '';
    if (!persona && !greeting) {
      return refuse(
        state,
        'command_failed',
        'call.configureAgent needs a persona and/or greeting to apply.'
      );
    }
    guard = checkCall(state, 'call.configureAgent', payload, ['ringing', 'active']);
    if (guard.error) return { error: guard.error, state: state };
    return { result: { accepted: true, mock: true, callId: guard.call.callId }, state: state };
  }

  if (command === 'settings.get') {
    if (typeof payload.key === 'string' && payload.key) {
      // Single-key form (contract parity: managerPin is never revealed).
      if (payload.key === 'managerPin') {
        return { result: { key: payload.key, value: null, set: state.managerPinSet }, state: state };
      }
      var single = state.settings[payload.key];
      if (single === undefined || single === null) single = null;
      return { result: { key: payload.key, value: single }, state: state };
    }
    // Whole-object form: settings + side keys, incl. the ttsVoiceCatalog voice
    // inventory the console's engine-first pickers render from.
    var settingsCopy = {};
    for (var sk in state.settings) {
      if (Object.prototype.hasOwnProperty.call(state.settings, sk)) settingsCopy[sk] = state.settings[sk];
    }
    return {
      result: {
        settings: settingsCopy,
        configVersion: state.configVersion,
        configQuarantined: false,
        managerPinSet: state.managerPinSet,
        ttsVoiceCatalog: ttsVoiceCatalog()
      },
      state: state
    };
  }

  if (command === 'settings.set') {
    var keys = [];
    for (var k in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) keys.push(k);
    }
    if (keys.length === 0) {
      return refuse(state, 'command_failed', 'settings.set requires at least one key.');
    }
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = payload[key];
      if (value !== null && ['string', 'number', 'boolean'].indexOf(typeof value) === -1) {
        return refuse(state, 'command_failed', 'settings.set: "' + key + '" must be a scalar value.');
      }
      if (key === 'managerPin') {
        // Write-only (AOK-304A): remember only that one is (un)set.
        state.managerPinSet = typeof value === 'string' && value.trim() !== '';
        continue;
      }
      state.settings[key] = value;
    }
    state.configVersion = state.configVersion + 1;
    return {
      result: { updated: true, configVersion: state.configVersion, managerPinSet: state.managerPinSet },
      state: state
    };
  }

  if (command === 'sms.threads') {
    return { result: { threads: mockThreads(ctx.now) }, state: state };
  }

  if (command === 'sms.send') {
    if (
      typeof payload.to !== 'string' ||
      !payload.to ||
      typeof payload.body !== 'string' ||
      !payload.body
    ) {
      return refuse(state, 'command_failed', 'sms.send requires {to, body}.');
    }
    state.smsCounter = state.smsCounter + 1;
    var messageId = 'msg_demo_' + state.smsCounter;
    return {
      result: { messageId: messageId, status: 'queued' },
      state: state,
      events: [
        ev('aokie.sms.sent', messageId, 'sent', {
          messageId: messageId,
          to: payload.to,
          status: 'sent'
        })
      ]
    };
  }

  return refuse(state, 'command_failed', 'Aokie demo mode does not support "' + command + '".');
}

// The contract's scripted call lifecycle (dongle.detected -> dongle.ready ->
// call.incoming -> call.answered -> 2x call.turn.final -> call.ended ->
// sms.received; AOKIE_PLUGIN_CONTRACT.md section 4), one host-paced step per
// call. The operator can reject/hang up mid-script through the demo call
// controls; a dead call must stay dead - the script stops instead of
// resurrecting it (the callStillLive guard below).
function handleCeremonyStep(ctx, state) {
  if (ctx.ceremony !== 'simulate-call') {
    return { error: { code: 'command_failed', message: 'unknown ceremony' }, done: true, state: state };
  }
  var step = ctx.step;

  if (step === 0) {
    var callId = 'call_demo_' + ctx.now.toString(36);
    var from = '+61400555666';
    var callerName = 'Alex Morgan (demo)';
    state.currentCall = {
      callId: callId,
      direction: 'incoming',
      from: from,
      callerName: callerName,
      state: 'ringing',
      startedAt: iso(ctx.now)
    };
    state.ceremonyCallId = callId;
    return {
      state: state,
      events: [
        ev('aokie.dongle.detected', callId, 'dongle.detected', { dongleId: 'usb-0a12-0001' }),
        ev('aokie.dongle.ready', callId, 'dongle.ready', { dongleId: 'usb-0a12-0001' }),
        ev('aokie.call.incoming', callId, 'incoming', { callId: callId, from: from, callerName: callerName })
      ],
      delayMs: 1200
    };
  }

  var id = state.ceremonyCallId;
  var live = !!(state.currentCall && state.currentCall.callId === id && state.currentCall.state !== 'ended');
  if (!live) return { done: true, state: state };

  if (step === 1) {
    var events = [];
    // The operator may have ANSWERED already (demo call.answer) - don't double-emit.
    if (state.currentCall.state !== 'active') {
      state.currentCall = copyCallWithState(state.currentCall, 'active');
      events.push(ev('aokie.call.answered', id, 'answered', { callId: id, answeredBy: 'bot' }));
    }
    return { state: state, events: events, delayMs: 1200 };
  }

  if (step === 2) {
    return {
      state: state,
      events: [
        ev('aokie.call.turn.final', id, 'turn.0.final', {
          callId: id,
          turn: 0,
          speaker: 'caller',
          text: 'Hi, I would like to book an appointment for tomorrow morning.'
        })
      ],
      delayMs: 1200
    };
  }

  if (step === 3) {
    return {
      state: state,
      events: [
        ev('aokie.call.turn.final', id, 'turn.1.final', {
          callId: id,
          turn: 1,
          speaker: 'bot',
          text: 'Sure - I have 9:30am available. I will text you a confirmation.'
        })
      ],
      delayMs: 1200
    };
  }

  if (step === 4) {
    var endedFrom = state.currentCall.from;
    state.currentCall = null;
    state.ceremonyCallId = null;
    return {
      state: state,
      events: [
        ev('aokie.call.ended', id, 'ended', { callId: id, durationSeconds: 42, outcome: 'completed' }),
        ev('aokie.sms.received', id, 'sms.received', {
          from: endedFrom,
          body: 'Perfect, 9:30am works. Thanks!',
          receivedAt: iso(ctx.now)
        })
      ],
      done: true
    };
  }

  return { done: true, state: state };
}
