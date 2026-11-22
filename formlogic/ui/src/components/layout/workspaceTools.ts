import { Database, Map, Package, Trash2 } from 'lucide-react';

const tools = [
  { path: '/import', icon: Database, label: 'Import database', hint: 'Bring SQL schemas & rows into forms' },
  { path: '/diagrams', icon: Map, label: 'Diagrams', hint: 'Sketch an app before building it' },
  { path: '/packs', icon: Package, label: 'Templates', hint: 'Ready-made apps to install' },
  { path: '/trash', icon: Trash2, label: 'Recycle bin', hint: 'Restore deleted items' },
];

export function workspaceTools(isDemo: boolean) {
  return isDemo ? tools.filter(tool => tool.path !== '/trash') : tools;
}
