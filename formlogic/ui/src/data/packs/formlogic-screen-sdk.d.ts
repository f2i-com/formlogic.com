// Ambient typings for SANDBOXED custom-screen sources (the .tsx files in this folder tree).
// These files run inside the CustomScreenRuntime iframe where `window.FormLogic` is the ONLY
// capability — this declaration mirrors the SDK_SHIM surface (CustomScreenRuntime.tsx) so the
// screen sources type-check in the repo. Keep in lock-step with the shim when the bridge grows.
//
// NOTE: this is a global .d.ts (no imports/exports) — it applies to the whole ui project, which
// is fine: `FormLogic` only exists at runtime inside screen iframes, and nothing else declares it.

interface FlScreenRecord {
  id: string;
  answers: Record<string, unknown>;
  submittedAt?: string;
  status?: string;
  tags?: string[];
}

interface FlConnectorOutcome {
  status: 'done' | 'failed' | 'expired' | 'uncertain';
  result?: unknown;
  /** Typed refusal/failure detail — an object like { code?, message? } (screenBridge shape). */
  error?: { code?: string; message?: string } | Record<string, unknown> | null;
  via?: string;
  handledBy?: string;
}

interface FlServiceOutcome {
  status: 'done' | 'failed';
  result?: unknown;
  /** Typed refusal/failure detail — an object like { message? } (screenBridge shape). */
  error?: { code?: string; message?: string } | Record<string, unknown> | null;
}

interface FlPresence {
  kind: 'local' | 'remote' | 'none';
  deviceName?: string;
  lastSeenAt?: string;
}

interface FlPushFrame {
  kind: string;
  seq: number;
  data: unknown;
}

interface FlScreenSdk {
  submit(answers: Record<string, unknown>): Promise<unknown>;
  records(opts?: { limit?: number }): Promise<FlScreenRecord[]>;
  currentUser(): Promise<{ id: string; name: string; email: string } | null>;
  context(): Promise<{ formId: string; title: string; fields: Array<{ id: string; label: string; type: string; options?: Array<{ label: string; value: string }> }> }>;
  toast: {
    success(msg: string, detail?: string): Promise<unknown>;
    error(msg: string, detail?: string): Promise<unknown>;
    info(msg: string, detail?: string): Promise<unknown>;
  };
  openForm(): Promise<unknown>;
  openRecords(): Promise<unknown>;
  record(): Promise<FlScreenRecord>;
  related(): Promise<Record<string, { fieldId?: string; columns?: Array<{ id: string; label?: string }>; records?: Array<{ id: string; fields: Record<string, unknown>; submittedAt?: string }> }>>;
  connector(connectorId: string, command: string, payload?: Record<string, unknown>): Promise<FlConnectorOutcome>;
  updateRecord(responseId: string | null, answers: Record<string, unknown>): Promise<unknown>;
  deleteRecords(responseIds: string[]): Promise<{ deleted: string[]; failed: Array<{ id: string; error: string }> }>;
  queryRecords(formTarget: string, opts?: { limit?: number }): Promise<FlScreenRecord[]>;
  presence(): Promise<FlPresence>;
  aiSources(): Promise<Array<Record<string, unknown>> | null>;
  events: {
    subscribe(
      filter: { connectorId: string; names?: string[] },
      handler: (frame: FlPushFrame) => void
    ): Promise<{ unsubscribe(): Promise<unknown> }>;
  };
  captions: {
    subscribe(
      handler: (frame: FlPushFrame) => void
    ): Promise<{ unsubscribe(): Promise<unknown>; tombstone(): Promise<unknown> }>;
  };
  service(operationId: string, input?: Record<string, unknown>): Promise<FlServiceOutcome>;
  can(permission: string): Promise<boolean>;
  host: {
    openScreen(target: string): Promise<unknown>;
    openRecord(target: string, recordId: string): Promise<unknown>;
    ceremony(name: string): Promise<{ status: 'done' | 'failed' | 'denied' | 'unavailable'; message?: string; deleted?: number }>;
  };
  escapeHtml(v: unknown): string;
}

declare const FormLogic: FlScreenSdk;
