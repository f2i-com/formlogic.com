import { useRef, useState } from 'react';
import { Box, Check, DollarSign, Eye, EyeOff, FolderUp, Layers, Lock, Puzzle, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { isSoftnApp } from '../../lib/softnApps';
import { useAppStore } from '../../stores/appStore';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';

interface PublishSoftnModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultSourceAppId?: string;
  onPublished?: (slug: string) => void;
}

const CATEGORIES = [
  'Business & CRM',
  'Operations',
  'Finance & Billing',
  'Productivity',
  'Data & Analytics',
  'AI & Automation',
  'E-Commerce',
  'Plugins',
  'Developer Tools',
  'Other',
];

export function PublishSoftnModal({
  isOpen,
  onClose,
  defaultSourceAppId,
  onPublished,
}: PublishSoftnModalProps) {
  const apps = useAppStore((s) => s.apps);
  const eligibleApps = apps.filter((a) => isSoftnApp(a) && !a.settings?.sourceProtected && a.status !== 'archived');

  const initialSourceMode = defaultSourceAppId ? 'existing' : 'upload';
  const defaultApp = eligibleApps.find((a) => a.id === defaultSourceAppId);

  const [itemType, setItemType] = useState<'softn_app' | 'plugin'>('softn_app');
  const [sourceMode, setSourceMode] = useState<'upload' | 'existing'>(initialSourceMode);
  const [file, setFile] = useState<File | null>(null);
  const [sourceAppId, setSourceAppId] = useState<string>(defaultSourceAppId || eligibleApps[0]?.id || '');
  const [name, setName] = useState<string>(defaultApp?.name || '');
  const [description, setDescription] = useState<string>(defaultApp?.description || '');
  const [category, setCategory] = useState<string>('Business & CRM');
  const [tagsText, setTagsText] = useState<string>('softn');
  const [version, setVersion] = useState<string>('1.0.0');
  const [sourceVisibility, setSourceVisibility] = useState<'private' | 'open'>('private');
  const [billingModel, setBillingModel] = useState<'free' | 'one_time' | 'subscription'>('free');
  const [priceDollars, setPriceDollars] = useState<string>('19.00');
  const [demoEnabled, setDemoEnabled] = useState<boolean>(true);
  const [compatibleWith, setCompatibleWith] = useState<string>('any');
  const [customCompatSlug, setCustomCompatSlug] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileChange = (picked: File | undefined) => {
    if (!picked) return;
    setFile(picked);
    if (!name.trim()) {
      const cleaned = picked.name.replace(/\.(softn|zip)$/i, '').replace(/[-_]+/g, ' ').trim();
      if (cleaned) setName(cleaned.charAt(0).toUpperCase() + cleaned.slice(1));
    }
  };

  const handleSelectExistingApp = (appId: string) => {
    setSourceAppId(appId);
    const chosen = eligibleApps.find((a) => a.id === appId);
    if (chosen) {
      setName(chosen.name);
      if (chosen.description) setDescription(chosen.description);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (sourceMode === 'upload' && !file) {
      setError('Please choose a .softn or .zip file to upload.');
      return;
    }
    if (sourceMode === 'existing' && !sourceAppId) {
      setError('Please pick one of your hosted SoftN apps.');
      return;
    }
    if (name.trim().length < 2) {
      setError('Please enter a listing name (at least 2 characters).');
      return;
    }

    let priceCents = 0;
    if (billingModel !== 'free') {
      const parsed = Number.parseFloat(priceDollars);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100000) {
        setError('Enter a valid price between $1.00 and $100,000.00.');
        return;
      }
      priceCents = Math.round(parsed * 100);
    }

    const tags = tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);

    const resolvedCompat =
      itemType === 'plugin'
        ? compatibleWith === 'specific'
          ? customCompatSlug.trim() || 'any'
          : compatibleWith
        : undefined;

    setSubmitting(true);
    try {
      const res = await api.publishSoftnToMarketplace({
        file: sourceMode === 'upload' ? (file ?? undefined) : undefined,
        sourceAppId: sourceMode === 'existing' ? sourceAppId : undefined,
        name: name.trim(),
        description: description.trim() || undefined,
        itemType,
        sourceVisibility,
        billingModel,
        priceCents,
        currency: 'USD',
        demoEnabled,
        compatibleWith: resolvedCompat,
        category: itemType === 'plugin' && category === 'Business & CRM' ? 'Plugins' : category,
        tags,
        version: version.trim() || '1.0.0',
        icon: itemType === 'plugin' ? 'puzzle' : 'box',
      });
      if (res.error || !res.data?.slug) {
        setError(res.error || 'Could not publish to the marketplace.');
        return;
      }
      toast.success(
        itemType === 'plugin' ? 'Plugin published to Marketplace!' : 'SoftN App published to Marketplace!',
        sourceVisibility === 'private'
          ? 'Hosted privately with source protection enabled.'
          : 'Published as open source.'
      );
      onPublished?.(res.data.slug);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish to marketplace.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-softn-title"
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div>
            <h2 id="publish-softn-title" className="text-lg font-bold text-slate-900 dark:text-white">
              Publish to FormLogic Marketplace
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Sell or share a SoftN app or modular plugin with private, source-hidden sandbox demos.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close publish dialog"
            className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form body */}
        <form onSubmit={handleSubmit} className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {error && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          )}

          {/* Step 1: Listing Type */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              1. What are you publishing?
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setItemType('softn_app')}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border-2 p-4 text-left transition',
                  itemType === 'softn_app'
                    ? 'border-primary-500 bg-primary-50/70 dark:bg-primary-500/10'
                    : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                )}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300">
                  <Box className="h-5 w-5" />
                </span>
                <div>
                  <p className="font-semibold text-slate-900 dark:text-white">SoftN Application</p>
                  <p className="mt-0.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
                    Full standalone app with UI, private SQLite database &amp; live sandbox demo.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setItemType('plugin')}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border-2 p-4 text-left transition',
                  itemType === 'plugin'
                    ? 'border-primary-500 bg-primary-50/70 dark:bg-primary-500/10'
                    : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                )}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                  <Puzzle className="h-5 w-5" />
                </span>
                <div>
                  <p className="font-semibold text-slate-900 dark:text-white">Modular Plugin (SoftN)</p>
                  <p className="mt-0.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
                    A SoftN app packaged as a modular plugin members can attach to their apps.
                  </p>
                </div>
              </button>
            </div>
          </div>

          {/* Step 2: Package Source */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              2. Choose your .softn package
            </p>
            <div className="mb-3 flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={sourceMode === 'upload' ? 'primary' : 'outline'}
                onClick={() => setSourceMode('upload')}
                leftIcon={<Upload className="h-4 w-4" />}
              >
                Upload .softn / .zip file
              </Button>
              <Button
                type="button"
                size="sm"
                variant={sourceMode === 'existing' ? 'primary' : 'outline'}
                onClick={() => setSourceMode('existing')}
                disabled={eligibleApps.length === 0}
                leftIcon={<Layers className="h-4 w-4" />}
              >
                Pick from My Hosted Apps ({eligibleApps.length})
              </Button>
            </div>

            {sourceMode === 'upload' ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center transition hover:border-primary-400 hover:bg-primary-50/40 dark:border-slate-700 dark:bg-slate-800/50 dark:hover:border-primary-500"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".softn,.zip,application/zip"
                  className="hidden"
                  onChange={(e) => handleFileChange(e.target.files?.[0])}
                />
                <FolderUp className="h-7 w-7 text-primary-600 dark:text-primary-400" />
                {file ? (
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">{file.name}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {(file.size / 1024).toFixed(1)} KB · Click to replace
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">
                      Click to choose a .softn or .zip file
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Supports classic .ui/.logic apps, web apps, and PHP/JS/Rust/Python backends
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <select
                value={sourceAppId}
                onChange={(e) => handleSelectExistingApp(e.target.value)}
                className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              >
                <option value="">Choose one of your hosted SoftN apps…</option>
                {eligibleApps.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} (/{a.slug})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Step 3: Source Protection & Sandbox Demo */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              3. Source protection &amp; live sandbox
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setSourceVisibility('private')}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3.5 text-left transition',
                  sourceVisibility === 'private'
                    ? 'border-emerald-500 bg-emerald-50/70 dark:bg-emerald-500/10'
                    : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'
                )}
              >
                <EyeOff className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div>
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white">
                    Private · Source Hidden
                    <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
                    Recommended for selling. Visitors demo only the sandboxed DOM + backend; raw code is never exposed or downloadable.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setSourceVisibility('open')}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3.5 text-left transition',
                  sourceVisibility === 'open'
                    ? 'border-primary-500 bg-primary-50/70 dark:bg-primary-500/10'
                    : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'
                )}
              >
                <Eye className="mt-0.5 h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" />
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">Open Source</p>
                  <p className="mt-0.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
                    Buyers get full editable source access in AI Studio &amp; Visual Builder after installing.
                  </p>
                </div>
              </button>
            </div>

            <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/60">
              <span className="flex items-center gap-2.5">
                <Sparkles className="h-4 w-4 text-primary-600 dark:text-primary-400" />
                <span>
                  <span className="block text-sm font-semibold text-slate-900 dark:text-white">
                    Enable interactive live sandbox demo
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    Let visitors test the live UI &amp; isolated backend right on your Marketplace page
                  </span>
                </span>
              </span>
              <input
                type="checkbox"
                checked={demoEnabled}
                onChange={(e) => setDemoEnabled(e.target.checked)}
                className="h-5 w-5 accent-primary-600"
              />
            </label>
          </div>

          {/* Step 4: Pricing */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              4. Pricing
            </p>
            <div className="grid grid-cols-3 gap-2">
              {([
                ['free', 'Free'],
                ['one_time', 'Paid · One-time'],
                ['subscription', 'Paid · Monthly'],
              ] as const).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setBillingModel(val)}
                  className={cn(
                    'flex h-11 cursor-pointer items-center justify-center gap-1.5 rounded-xl border-2 text-sm font-semibold transition',
                    billingModel === val
                      ? 'border-primary-500 bg-primary-50 text-primary-800 dark:bg-primary-500/15 dark:text-primary-200'
                      : 'border-slate-200 text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300'
                  )}
                >
                  {billingModel === val && <Check className="h-4 w-4" />}
                  {label}
                </button>
              ))}
            </div>
            {billingModel !== 'free' && (
              <div className="mt-3 flex items-center gap-2">
                <span className="inline-flex h-11 items-center rounded-xl border border-slate-300 bg-slate-50 px-3 text-sm font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  <DollarSign className="h-4 w-4" /> USD
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  max="100000"
                  value={priceDollars}
                  onChange={(e) => setPriceDollars(e.target.value)}
                  className="h-11 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  placeholder="19.00"
                />
              </div>
            )}
          </div>

          {/* Step 5: Details & Plugin Compatibility */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              5. Listing details
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                Name *
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Property Maintenance Pro"
                  className="mt-1 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </label>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                Category
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="mt-1 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Description
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what your app or plugin does, what database/features it includes, and who it is built for…"
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white p-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                Version
                <input
                  type="text"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="1.0.0"
                  className="mt-1 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </label>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                Tags (comma-separated)
                <input
                  type="text"
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  placeholder="crm, analytics, plugin"
                  className="mt-1 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </label>
            </div>

            {itemType === 'plugin' && (
              <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3.5 dark:border-indigo-500/30 dark:bg-indigo-500/10">
                <label className="block text-xs font-semibold text-indigo-900 dark:text-indigo-200">
                  Plugin Compatibility
                  <select
                    value={compatibleWith}
                    onChange={(e) => setCompatibleWith(e.target.value)}
                    className="mt-1.5 h-10 w-full rounded-lg border border-indigo-200 bg-white px-3 text-sm font-normal text-slate-900 dark:border-indigo-500/40 dark:bg-slate-900 dark:text-white"
                  >
                    <option value="any">Works with any FormLogic or SoftN app</option>
                    <option value="softn">Works with all SoftN apps</option>
                    <option value="forms">Works with FormLogic Forms apps</option>
                    <option value="specific">Built for a specific Marketplace app (by slug)</option>
                  </select>
                </label>
                {compatibleWith === 'specific' && (
                  <input
                    type="text"
                    value={customCompatSlug}
                    onChange={(e) => setCustomCompatSlug(e.target.value)}
                    placeholder="Target app marketplace slug (e.g. property-maintenance)"
                    className="mt-2 h-10 w-full rounded-lg border border-indigo-200 bg-white px-3 text-sm text-slate-900 dark:border-indigo-500/40 dark:bg-slate-900 dark:text-white"
                  />
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
            <p className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <Lock className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              {sourceVisibility === 'private' ? 'Source hidden · Private server sandbox' : 'Open source listing'}
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" isLoading={submitting}>
                {itemType === 'plugin' ? 'Publish Plugin' : 'Publish SoftN App'}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
