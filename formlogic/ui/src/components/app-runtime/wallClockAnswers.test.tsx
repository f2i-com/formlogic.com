// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDataTable } from './AppDataTable';
import { AppResponseDetail } from './AppResponseDetail';
import { RecordsGridWidget } from './RecordsGridWidget';
import { RelatedRecordsPanel } from './RelatedRecordsPanel';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { DEFAULT_APP_SETTINGS, DEFAULT_APP_THEME } from '../../types/app';
import type { DashboardWidget } from '../../types/app';

const h = vi.hoisted(() => ({ record: {} as Record<string, unknown>, related: [] as unknown[] }));
vi.mock('../../lib/api', () => ({ api: {
  isDemoMode: () => false,
  getAppResponseByIdResolved: async () => ({ data: { response: h.record } }),
  getAppResponseById: async () => ({ data: { response: h.record } }),
  getRelatedRecords: async () => ({ data: { related: h.related } }),
} }));
vi.mock('./LinkedRecordInput', () => ({ LinkedRecordInput: () => null }));
vi.mock('./RecordScreenPanel', () => ({ RecordScreenPanel: () => null }));

// A record's appointment time, a wall clock the respondent picked, read by a member with no zone
// of their own: the app is in Sydney, the browser in New York. Through the viewer's zone the
// same value came out as 1 April, 5:30 am AEDT.
const APPOINTMENT = '2026-03-31T14:30';
const FIELD = { id: 'at', type: 'datetime', label: 'Appointment', properties: {}, required: false };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let zone: string | undefined;

async function mount(element: React.ReactElement, path = '/app/demo/form/f1') {
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/app/:appSlug/form/:formId" element={element} />
      <Route path="/app/:appSlug/form/:formId/responses/:responseId" element={element} />
    </Routes>
  </MemoryRouter>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

// The submission time beside it is an instant, and rightly names Sydney's zone. The answer doesn't.
function expectWrittenTime() {
  const text = container.textContent ?? '';
  expect(text).toMatch(/(31 Mar 2026|Mar 31, 2026),? (at )?0?2:30\s*[Pp][Mm](?!\s*(AEDT|GMT))/);
  expect(text).not.toMatch(/1 Apr|Apr 1,/);
}

beforeEach(() => {
  zone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  useAppRuntimeStore.setState({
    appSlug: 'demo',
    memberTimezone: null,
    config: {
      app: { id: 'demo', name: 'Demo', slug: 'demo', ownerId: 'owner', status: 'published', settings: { ...DEFAULT_APP_SETTINGS, timezone: 'Australia/Sydney' }, theme: DEFAULT_APP_THEME, navConfig: [], createdAt: '', updatedAt: '' },
      forms: [{ formId: 'f1', title: 'Bookings', fields: [FIELD] }],
      userPermissions: {},
    },
    canViewAll: () => true, canViewOwn: () => true, canSubmit: () => false, canDelete: () => false, canEdit: () => false, canExport: () => false,
    fetchResponsePage: async () => ({ rows: [{ id: 'r1', status: 'submitted', submittedAt: '2026-03-30 10:00:00', answers: { at: APPOINTMENT } }], total: 1 }),
  } as unknown as Parameters<typeof useAppRuntimeStore.setState>[0]);
  h.record = { id: 'r1', status: 'submitted', submittedAt: '2026-03-30 10:00:00', updatedAt: '2026-03-30 10:00:00', answers: { at: APPOINTMENT } };
  h.related = [{ formId: 'f2', formTitle: 'Bookings', fieldId: 'parent', fieldLabel: 'Parent', columns: [{ id: 'at', label: 'Appointment', type: 'datetime' }], records: [{ id: 'r2', submittedAt: '2026-03-30 10:00:00', fields: { at: APPOINTMENT } }], total: 1 }];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
});

describe('a zone-less datetime answer shows as written, wherever the browser is', () => {
  it('in the record table', async () => {
    await mount(<AppDataTable />);
    expectWrittenTime();
  });

  it('on the record page', async () => {
    await mount(<AppResponseDetail />, '/app/demo/form/f1/responses/r1');
    expectWrittenTime();
  });

  it('in the dashboard grid', async () => {
    const widget = { id: 'w', type: 'records_grid', grid: { formId: 'f1', columnFieldIds: ['at'], pageSize: 10 } } as unknown as DashboardWidget;
    await mount(<RecordsGridWidget widget={widget} form={{ formId: 'f1', fields: [FIELD] } as never} fetchPage={async () => ({ rows: [{ id: 'r1', answers: { at: APPOINTMENT } }], total: 1 })} />);
    expectWrittenTime();
  });

  it('among related records', async () => {
    await mount(<RelatedRecordsPanel formId="f1" responseId="r1" appSlug="demo" />, '/app/demo/form/f1/responses/r1');
    expectWrittenTime();
  });
});
