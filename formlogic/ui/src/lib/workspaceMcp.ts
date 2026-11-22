import { useSyncExternalStore } from 'react';
import { api } from './api';
import { resolveBackendApiUrl } from './apiBase';
import { currentSessionGeneration, currentSessionOwner, subscribeSessionGeneration } from './sessionGeneration';
import { parseServerDate } from './utils';

const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

export interface WorkspaceMcpAttachment {
  id: string;
  scopeLabel: string;
  expiresAt: string;
  status: 'connected' | 'connecting' | 'expired' | 'unavailable';
}

export interface WorkspaceMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

const marker = 'formlogic.workspace-mcp-selection';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
let selection: WorkspaceMcpAttachment | null = null;
let owner: string | null = null;
let connection: { token: string; idleMs: number; controller: AbortController; until: number } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let connecting = false;

function dropCredential() {
  clearTimeout(timer);
  connection?.controller.abort();
  connection = null;
}

function remember() {
  try {
    // Only the grant id and label survive refresh, so restoring the chat never widens a selected grant.
    if (selection) sessionStorage.setItem(marker, JSON.stringify({ owner, id: selection.id, scopeLabel: selection.scopeLabel, expiresAt: selection.expiresAt }));
    else sessionStorage.removeItem(marker);
  } catch { /* Storage can be unavailable. The live grant stays in memory. */ }
}

function restore() {
  if (!owner) return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(marker) ?? 'null');
    if (saved?.owner === owner && typeof saved.id === 'string' && typeof saved.scopeLabel === 'string' && typeof saved.expiresAt === 'string') {
      selection = { id: saved.id, scopeLabel: saved.scopeLabel, expiresAt: saved.expiresAt, status: Date.parse(saved.expiresAt) <= Date.now() ? 'expired' : 'unavailable' };
    }
  } catch { /* No selection to restore. */ }
}

owner = currentSessionOwner();
restore();
subscribeSessionGeneration(() => {
  dropCredential();
  if (selection) { selection = null; remember(); }
  owner = currentSessionOwner();
  restore();
  emit();
});

export function getWorkspaceMcp(): WorkspaceMcpAttachment | null { return selection; }
export function useWorkspaceMcp(): WorkspaceMcpAttachment | null {
  return useSyncExternalStore(subscribe, getWorkspaceMcp, () => null);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Revocation and expiry leave the grant selected until the person disconnects it. */
export function invalidateWorkspaceMcp(id: string, status: 'unavailable' | 'expired' = 'unavailable') {
  if (selection?.id !== id || selection.status === status) return;
  dropCredential();
  selection = { ...selection, status };
  emit();
}

function resetIdle(id: string) {
  if (!selection || !connection) return;
  connection.until = Math.min(Date.parse(selection.expiresAt), Date.now() + connection.idleMs);
  clearTimeout(timer);
  timer = setTimeout(() => invalidateWorkspaceMcp(id, 'expired'), Math.max(0, connection.until - Date.now()));
}

function requireConnection(id: string) {
  if (connection && Date.now() >= connection.until) invalidateWorkspaceMcp(id, 'expired');
  if (!connection || selection?.id !== id || owner !== currentSessionOwner() || api.isAdminActing()) {
    throw new Error('This MCP connection is unavailable. Review workspace chat access to reconnect.');
  }
  return connection;
}

async function rpc(id: string, method: string, params: object, signal?: AbortSignal, notify = false) {
  const live = requireConnection(id);
  const requestId = crypto.randomUUID();
  const csrf = api.getCsrfToken();
  const mcpUrl = resolveBackendApiUrl('/mcp');
  const isSameOrigin = mcpUrl.startsWith('/') || (typeof window !== 'undefined' && new URL(mcpUrl, window.location.origin).origin === window.location.origin);
  const response = await fetch(mcpUrl, {
    // WebKit sends Origin: null on a POST with no-referrer. Send this site's origin only.
    method: 'POST', credentials: 'omit', mode: isSameOrigin ? 'same-origin' : 'cors', redirect: 'error', cache: 'no-store', referrerPolicy: 'origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + live.token, ...(csrf && isSameOrigin ? { 'X-CSRF-Token': csrf } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id: requestId }), method, params }),
    signal: signal ? AbortSignal.any([signal, live.controller.signal]) : live.controller.signal,
  });
  if (response.status === 401) invalidateWorkspaceMcp(id);
  if (!response.ok) throw new Error('The MCP server refused the request (HTTP ' + response.status + ').');
  const message = notify ? null : await response.json();
  if (requireConnection(id) !== live) throw new Error('The workspace MCP connection changed.');
  resetIdle(id);
  if (notify) return null;
  if (message?.jsonrpc !== '2.0' || message.id !== requestId) throw new Error('Invalid MCP response.');
  if (message.error) throw new Error(message.error.message || 'The MCP request failed.');
  return message.result;
}

export async function connectWorkspaceMcp(options: { appId?: string; creator: boolean; scopeLabel: string; connectors: boolean; extraScopes: string[] }) {
  if (!owner || selection || connecting || api.isAdminActing()) throw new Error('Disconnect any current workspace connection before connecting.');
  const generation = currentSessionGeneration();
  connecting = true;
  try {
    const result = await api.createMcpToken(options.appId, options.creator, options.connectors, options.extraScopes);
    if (generation !== currentSessionGeneration()) throw new Error('The signed-in account changed.');
    const grant = result.data;
    if (result.error || !grant?.id || !grant.token) throw new Error(result.error || 'Could not create a workspace connection.');
    try {
      selection = { id: grant.id, scopeLabel: options.scopeLabel, expiresAt: parseServerDate(grant.expiresAt).toISOString(), status: 'connecting' };
      connection = { token: grant.token, idleMs: grant.idleTimeout * 1000, controller: new AbortController(), until: 0 };
      resetIdle(grant.id);
      remember();
      emit();
      const ready = await rpc(grant.id, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'FormLogic Workspace Chat', version: '1' } });
      if (!ready?.capabilities?.tools || !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(String(ready.protocolVersion || ''))) throw new Error('This MCP server did not offer workspace tools.');
      await rpc(grant.id, 'notifications/initialized', {}, undefined, true);
      requireConnection(grant.id);
      selection = { ...selection!, status: 'connected' };
      emit();
    } catch (error) {
      invalidateWorkspaceMcp(grant.id);
      if (generation === currentSessionGeneration()) await api.revokeMcpToken(grant.id).catch(() => {});
      throw error;
    }
  } finally { connecting = false; }
}

export async function disconnectWorkspaceMcp(id: string) {
  if (!selection || selection.id !== id) return;
  invalidateWorkspaceMcp(id);
  const result = await api.revokeMcpToken(id);
  if (result.error) throw new Error('The connection was stopped in this tab. Retry to revoke its grant on the server.');
  if (selection?.id === id) { selection = null; remember(); emit(); }
}

export async function listWorkspaceMcpTools(id: string, signal?: AbortSignal): Promise<WorkspaceMcpTool[]> {
  const result = await rpc(id, 'tools/list', {}, signal);
  if (!Array.isArray(result?.tools)) throw new Error('The MCP server returned an invalid tool catalog.');
  return result.tools.map((tool: { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }) => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema, readOnly: tool.annotations?.readOnlyHint === true,
  }));
}

export async function callWorkspaceMcpTool(id: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const result = await rpc(id, 'tools/call', { name, arguments: args }, signal);
  if (!Array.isArray(result?.content)) throw new Error('The MCP server returned an invalid tool result.');
  const text = result.content.filter((item: { type: string }) => item.type === 'text').map((item: { text: string }) => item.text).join('\n');
  if (result.isError) throw new Error(text || 'The MCP tool refused the request.');
  try { return JSON.parse(text); } catch { return text; }
}
