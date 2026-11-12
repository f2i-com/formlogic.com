import { deferEffect } from '../../lib/deferredEffect';
import { useState, useEffect, useCallback } from 'react';
import { Zap, Plus, Trash2, ToggleLeft, ToggleRight, Copy, CheckCircle, XCircle, Clock, ChevronDown, ChevronUp, Pencil } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { toast } from '../../stores/toastStore';
import { api } from '../../lib/api';
import type { Webhook, WebhookDelivery } from '../../lib/api';
import { cn, parseServerDate } from '../../lib/utils';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { GROUP_TITLE } from './builderDialog';

// A row's small actions: 32 px for a mouse, a finger's 44 px on a phone.
const ICON_BUTTON = 'inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:h-11 max-sm:w-11';

interface WebhookManagerProps {
  formId: string;
}

const WEBHOOK_EVENTS = [
  { value: 'response.created', label: 'Response created', desc: 'When a new response is submitted' },
  { value: 'response.updated', label: 'Response updated', desc: 'When a response is changed' },
  { value: 'response.deleted', label: 'Response deleted', desc: 'When a response is removed' },
  { value: 'form.published', label: 'Form published', desc: 'When the form is published' },
];

export function WebhookManager(props: WebhookManagerProps) {
  return <FormWebhookManager key={props.formId} {...props} />;
}
function FormWebhookManager({ formId }: WebhookManagerProps) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newEvents, setNewEvents] = useState<string[]>(['response.created']);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedWebhook, setExpandedWebhook] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadWebhooks = useCallback(async () => {
    const result = await api.getWebhooks(formId);
    if (result.error) {
      toast.error('Failed to load webhooks', typeof result.error === 'string' ? result.error : 'Please try again.');
    } else if (result.data) {
      setWebhooks(result.data.webhooks);
    }
    setLoading(false);
  }, [formId]);

  useEffect(() => deferEffect(() => { void loadWebhooks(); }), [loadWebhooks]);

  const resetForm = () => {
    setNewUrl('');
    setNewDescription('');
    setNewEvents(['response.created']);
    setShowCreate(false);
    setEditingId(null);
  };

  const openCreate = () => {
    setEditingId(null);
    setNewUrl('');
    setNewDescription('');
    setNewEvents(['response.created']);
    setShowCreate(true);
  };

  const openEdit = (webhook: Webhook) => {
    setEditingId(webhook.id);
    setNewUrl(webhook.url);
    setNewDescription(webhook.description || '');
    setNewEvents(webhook.events.length ? webhook.events : ['response.created']);
    setShowCreate(true);
  };

  const handleCreate = async () => {
    if (!newUrl.trim()) {
      toast.error('URL required', 'Please enter a webhook URL');
      return;
    }
    if (newEvents.length === 0) {
      toast.error('Events required', 'Select at least one event');
      return;
    }

    setCreating(true);

    // Edit mode: update the existing webhook (URL / events / description).
    if (editingId) {
      const result = await api.updateWebhook(formId, editingId, {
        url: newUrl.trim(),
        events: newEvents,
        description: newDescription.trim() || undefined,
      });
      setCreating(false);
      if (result.error) {
        toast.error('Failed to update webhook', result.error);
        return;
      }
      toast.success('Webhook updated');
      resetForm();
      loadWebhooks();
      return;
    }

    const result = await api.createWebhook(formId, {
      url: newUrl.trim(),
      events: newEvents,
      description: newDescription.trim() || undefined,
    });
    setCreating(false);

    if (result.error) {
      toast.error('Failed to create webhook', result.error);
      return;
    }

    if (result.data?.webhook) {
      setNewSecret(result.data.webhook.secret);
      toast.success('Webhook created', 'Copy the signing secret — it won\'t be shown again');
      resetForm();
      loadWebhooks();
    }
  };

  const handleToggle = async (webhook: Webhook) => {
    const result = await api.updateWebhook(formId, webhook.id, { is_active: !webhook.isActive });
    if (result.error) {
      toast.error('Failed to update webhook', result.error);
      return;
    }
    loadWebhooks();
  };

  const handleDelete = async (webhookId: string) => {
    const result = await api.deleteWebhook(formId, webhookId);
    if (result.error) {
      toast.error('Failed to delete webhook', result.error);
      return;
    }
    toast.success('Webhook deleted');
    loadWebhooks();
  };

  const handleViewDeliveries = async (webhookId: string) => {
    if (expandedWebhook === webhookId) {
      setExpandedWebhook(null);
      return;
    }
    setExpandedWebhook(webhookId);
    const result = await api.getWebhookDeliveries(formId, webhookId);
    if (result.data) {
      setDeliveries(prev => ({ ...prev, [webhookId]: result.data!.deliveries }));
    }
  };

  const toggleEvent = (event: string) => {
    setNewEvents(prev =>
      prev.includes(event) ? prev.filter(e => e !== event) : [...prev, event]
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin h-6 w-6 border-2 border-primary-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Secret display (shown after creation) */}
      {newSecret && (
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-xl p-3 sm:p-4">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300 mb-2">Signing secret: copy it now, it is not shown again</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 text-xs bg-white dark:bg-slate-900 p-2 rounded-lg border border-amber-200 dark:border-slate-700 font-mono break-all text-gray-900 dark:text-slate-100">{newSecret}</code>
            <button
              type="button"
              title="Copy"
              onClick={() => {
                if (navigator.clipboard && window.isSecureContext) {
                  navigator.clipboard.writeText(newSecret).then(() => toast.success('Copied'));
                } else {
                  const textarea = document.createElement('textarea');
                  textarea.value = newSecret;
                  textarea.style.position = 'fixed';
                  textarea.style.opacity = '0';
                  document.body.appendChild(textarea);
                  textarea.select();
                  document.execCommand('copy');
                  document.body.removeChild(textarea);
                  toast.success('Copied');
                }
              }}
              className={cn(ICON_BUTTON, 'text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20')}
              aria-label="Copy secret to clipboard"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <button type="button" onClick={() => setNewSecret(null)} className="text-xs text-amber-700 dark:text-amber-400 mt-2 underline cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 max-sm:min-h-11">
            Dismiss
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className={GROUP_TITLE}>Webhooks</h3>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
            FormLogic calls an address of yours when one of these things happens to the form.
          </p>
        </div>
        <Button size="sm" className="flex-none whitespace-nowrap" onClick={() => (showCreate ? resetForm() : openCreate())}>
          <Plus className="h-4 w-4 mr-1" />
          Add webhook
        </Button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="border border-gray-200 dark:border-slate-700 rounded-xl p-3 sm:p-4 space-y-4 bg-gray-50 dark:bg-slate-800/50">
          <Input
            label="Endpoint URL"
            value={newUrl}
            onChange={e => setNewUrl(e.target.value)}
            placeholder="https://example.com/webhook"
          />
          <Input
            label="Description (optional)"
            value={newDescription}
            onChange={e => setNewDescription(e.target.value)}
            placeholder="e.g. Notify Slack on new submissions"
          />
          <div>
            <label className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Events</label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {WEBHOOK_EVENTS.map(evt => (
                <button
                  key={evt.value}
                  type="button"
                  onClick={() => toggleEvent(evt.value)}
                  aria-pressed={newEvents.includes(evt.value)}
                  className={cn(
                    'p-2 rounded-lg border text-left text-xs transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:min-h-11',
                    newEvents.includes(evt.value)
                      ? 'border-primary-500 ring-1 ring-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                      : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'
                  )}
                >
                  <p className="font-medium">{evt.label}</p>
                  <p className="text-[11px] leading-4 opacity-80">{evt.desc}</p>
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={resetForm}>Cancel</Button>
            <Button size="sm" onClick={handleCreate} disabled={creating}>
              {editingId ? (creating ? 'Saving…' : 'Save changes') : (creating ? 'Creating…' : 'Create webhook')}
            </Button>
          </div>
        </div>
      )}

      {/* Webhook list */}
      {webhooks.length === 0 && !showCreate ? (
        <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
          <Zap className="h-4 w-4 flex-none text-gray-400 dark:text-slate-500" />
          No webhooks yet.
        </p>
      ) : (
        <div className="space-y-2">
          {webhooks.map(webhook => (
            <div key={webhook.id} className="border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
              <div className="flex items-center gap-1 py-2 pl-2 pr-1.5">
                <button type="button" onClick={() => handleToggle(webhook)} title={webhook.isActive ? 'Active' : 'Inactive'} aria-label={webhook.isActive ? 'Deactivate webhook' : 'Activate webhook'} aria-pressed={webhook.isActive} className={ICON_BUTTON}>
                  {webhook.isActive ? (
                    <ToggleRight className="h-5 w-5 text-green-500" />
                  ) : (
                    <ToggleLeft className="h-5 w-5 text-gray-400" />
                  )}
                </button>
                <div className="ml-1 flex-1 min-w-0">
                  <p className="text-sm font-mono text-gray-900 dark:text-white break-all">{webhook.url}</p>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    {webhook.events.map(evt => (
                      <span key={evt} className="text-[11px] px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-slate-700 font-mono text-gray-600 dark:text-slate-300">{evt}</span>
                    ))}
                  </div>
                </div>
                <button type="button" onClick={() => handleViewDeliveries(webhook.id)} className={cn(ICON_BUTTON, 'text-gray-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-slate-700')} title="View deliveries" aria-label="View deliveries" aria-expanded={expandedWebhook === webhook.id}>
                  {expandedWebhook === webhook.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                <button type="button" onClick={() => openEdit(webhook)} className={cn(ICON_BUTTON, 'text-gray-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-slate-700')} title="Edit" aria-label="Edit webhook">
                  <Pencil className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => setConfirmDeleteId(webhook.id)} className={cn(ICON_BUTTON, 'text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-400')} title="Delete" aria-label="Delete webhook">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              {/* Deliveries */}
              {expandedWebhook === webhook.id && (
                <div className="border-t border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/30 p-3">
                  <p className={cn(GROUP_TITLE, 'mb-2')}>Recent deliveries</p>
                  {(deliveries[webhook.id] ?? []).length === 0 ? (
                    <p className="text-xs text-gray-500 dark:text-slate-400">No deliveries yet</p>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {(deliveries[webhook.id] ?? []).map(d => (
                        <div key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums">
                          {d.success ? (
                            <CheckCircle className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                          ) : (
                            <XCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
                          )}
                          <span className="font-mono text-gray-600 dark:text-slate-300">{d.event}</span>
                          <span className="text-gray-400">{d.responseStatus ?? '---'}</span>
                          <span className="text-gray-400 flex items-center gap-0.5">
                            <Clock className="h-3 w-3" />{d.durationMs}ms
                          </span>
                          {d.errorMessage && <span className="text-red-500 truncate">{d.errorMessage}</span>}
                          <span className="ml-auto text-gray-400">{parseServerDate(d.createdAt).toLocaleTimeString()}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        isOpen={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={async () => {
          if (!confirmDeleteId) return;
          setDeleting(true);
          try { await handleDelete(confirmDeleteId); setConfirmDeleteId(null); }
          finally { setDeleting(false); }
        }}
        title="Delete webhook?"
        message="This permanently deletes the webhook and its signing secret. This can't be undone."
        confirmLabel="Delete"
        variant="danger"
        isLoading={deleting}
      />
    </div>
  );
}
