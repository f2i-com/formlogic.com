import { useState, useEffect, useCallback } from 'react';
import { Zap, Plus, Trash2, ToggleLeft, ToggleRight, Copy, CheckCircle, XCircle, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { toast } from '../../stores/toastStore';
import { api } from '../../lib/api';
import type { Webhook, WebhookDelivery } from '../../lib/api';
import { cn } from '../../lib/utils';

interface WebhookManagerProps {
  formId: string;
}

const WEBHOOK_EVENTS = [
  { value: 'response.created', label: 'Response Created', desc: 'When a new response is submitted' },
  { value: 'response.updated', label: 'Response Updated', desc: 'When a response is modified' },
  { value: 'response.deleted', label: 'Response Deleted', desc: 'When a response is removed' },
  { value: 'form.published', label: 'Form Published', desc: 'When the form is published' },
];

export function WebhookManager({ formId }: WebhookManagerProps) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newEvents, setNewEvents] = useState<string[]>(['response.created']);
  const [creating, setCreating] = useState(false);
  const [expandedWebhook, setExpandedWebhook] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const loadWebhooks = useCallback(async () => {
    const result = await api.getWebhooks(formId);
    if (result.data) {
      setWebhooks(result.data.webhooks);
    }
    setLoading(false);
  }, [formId]);

  useEffect(() => { loadWebhooks(); }, [loadWebhooks]);

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
      setNewUrl('');
      setNewDescription('');
      setNewEvents(['response.created']);
      setShowCreate(false);
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
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-lg p-4">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300 mb-2">Signing Secret (copy now — won't be shown again)</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white dark:bg-slate-900 p-2 rounded border font-mono break-all">{newSecret}</code>
            <button
              onClick={() => {
                if (navigator.clipboard && window.isSecureContext) {
                  navigator.clipboard.writeText(newSecret).then(() => toast.success('Copied!'));
                } else {
                  const textarea = document.createElement('textarea');
                  textarea.value = newSecret;
                  textarea.style.position = 'fixed';
                  textarea.style.opacity = '0';
                  document.body.appendChild(textarea);
                  textarea.select();
                  document.execCommand('copy');
                  document.body.removeChild(textarea);
                  toast.success('Copied!');
                }
              }}
              className="p-2 hover:bg-amber-100 dark:hover:bg-amber-500/20 rounded cursor-pointer"
              aria-label="Copy secret to clipboard"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <button type="button" onClick={() => setNewSecret(null)} className="text-xs text-amber-600 dark:text-amber-400 mt-2 underline cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-900 dark:text-white">Webhooks</h3>
          <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
            Get notified via HTTP when events occur
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
          <Plus className="h-4 w-4 mr-1" />
          Add Webhook
        </Button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="border border-gray-200 dark:border-slate-700 rounded-lg p-4 space-y-4 bg-gray-50 dark:bg-slate-800/50">
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
            <div className="grid grid-cols-2 gap-2">
              {WEBHOOK_EVENTS.map(evt => (
                <button
                  key={evt.value}
                  onClick={() => toggleEvent(evt.value)}
                  className={cn(
                    'p-2 rounded-lg border text-left text-xs transition-all cursor-pointer',
                    newEvents.includes(evt.value)
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                      : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:border-gray-300'
                  )}
                >
                  <p className="font-medium">{evt.label}</p>
                  <p className="text-[10px] opacity-70">{evt.desc}</p>
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating...' : 'Create Webhook'}
            </Button>
          </div>
        </div>
      )}

      {/* Webhook list */}
      {webhooks.length === 0 && !showCreate ? (
        <div className="text-center py-8 text-gray-500 dark:text-slate-400">
          <Zap className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No webhooks configured</p>
        </div>
      ) : (
        <div className="space-y-3">
          {webhooks.map(webhook => (
            <div key={webhook.id} className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
              <div className="flex items-center gap-3 p-3">
                <button type="button" onClick={() => handleToggle(webhook)} title={webhook.isActive ? 'Active' : 'Inactive'} aria-label={webhook.isActive ? 'Deactivate webhook' : 'Activate webhook'} className="cursor-pointer">
                  {webhook.isActive ? (
                    <ToggleRight className="h-5 w-5 text-green-500" />
                  ) : (
                    <ToggleLeft className="h-5 w-5 text-gray-400" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-gray-900 dark:text-white truncate">{webhook.url}</p>
                  <div className="flex items-center gap-2 mt-1">
                    {webhook.events.map(evt => (
                      <span key={evt} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300">{evt}</span>
                    ))}
                  </div>
                </div>
                <button type="button" onClick={() => handleViewDeliveries(webhook.id)} className="p-1.5 hover:bg-gray-100 dark:hover:bg-slate-700 rounded cursor-pointer" title="View deliveries" aria-label="View deliveries">
                  {expandedWebhook === webhook.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                <button type="button" onClick={() => handleDelete(webhook.id)} className="p-1.5 hover:bg-red-50 dark:hover:bg-red-500/10 rounded text-red-500 cursor-pointer" title="Delete" aria-label="Delete webhook">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              {/* Deliveries */}
              {expandedWebhook === webhook.id && (
                <div className="border-t border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/30 p-3">
                  <p className="text-xs font-medium text-gray-600 dark:text-slate-400 mb-2">Recent Deliveries</p>
                  {(deliveries[webhook.id] ?? []).length === 0 ? (
                    <p className="text-xs text-gray-400 dark:text-slate-500">No deliveries yet</p>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {(deliveries[webhook.id] ?? []).map(d => (
                        <div key={d.id} className="flex items-center gap-2 text-xs">
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
                          <span className="ml-auto text-gray-400">{new Date(d.createdAt).toLocaleTimeString()}</span>
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
    </div>
  );
}
