// Core provider: the compile-time node catalog wrapped behind the provider contract
// (extensible-flows plan §21.3 — "wrap current static catalog entries as CoreNodeProvider").
// The catalog stays the single authority for core specs; this file adds no data.
import { getNodeSpec, NODE_SPECS } from '../editor/nodeCatalog';
import type { FlowNodeProvider } from './types';

export const coreNodeProvider: FlowNodeProvider = {
  id: 'core',
  resolve: (type) => getNodeSpec(type),
  list: () => NODE_SPECS,
};
