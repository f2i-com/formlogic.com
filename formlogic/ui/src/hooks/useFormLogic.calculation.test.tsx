// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCalculatedField } from './useFormLogic';
import { calculateValue } from '../lib/formlogic';

vi.mock('../lib/formlogic', () => ({ calculateValue: vi.fn() }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const dependencies = ['amount'];

function Calculation({ expression = 'amount * 2', amount }: { expression?: string; amount: number }) {
  const result = useCalculatedField(expression, { amount }, dependencies);
  return <output>{JSON.stringify({ value: result.value, busy: result.isCalculating, error: result.error })}</output>;
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); });

it('keeps the newest calculated answer when an older evaluation completes later', async () => {
  let finishOld!: (value: number) => void;
  vi.mocked(calculateValue)
    .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce(8);
  await act(async () => root.render(<Calculation amount={2} />));
  await act(async () => root.render(<Calculation amount={4} />));
  expect(container.textContent).toContain('"value":8');
  await act(async () => { finishOld(4); });
  expect(container.textContent).toContain('"value":8');
  expect(vi.mocked(calculateValue).mock.calls[1]).toEqual(['amount * 2', { amount: 4 }]);
});

it('clears a removed expression and ignores its pending result', async () => {
  let finish!: (value: number) => void;
  vi.mocked(calculateValue).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<Calculation amount={2} />));
  await act(async () => root.render(<Calculation expression="" amount={2} />));
  await act(async () => { finish(4); });
  expect(JSON.parse(container.textContent!)).toEqual({ value: null, busy: false, error: null });
});
