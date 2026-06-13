import { useState, useRef, useCallback } from 'react';
import {
  Upload,
  FileJson,
  ChevronRight,
  ChevronLeft,
  X,
  Globe,
  Lock,
  EyeOff,
  Package,
  Loader2,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Badge';
import { api, type PackData } from '../../lib/api';
import { toast } from '../../stores/toastStore';

interface PublishPackDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onPublished?: () => void;
  initialPack?: PackData | null;
}

type Step = 'upload' | 'metadata' | 'preview' | 'publish';

const CATEGORIES = [
  'Finance & Compliance',
  'Human Resources',
  'Safety & Quality',
  'Customer Service',
  'Event Management',
  'Operations',
  'Sales & Marketing',
  'IT & Development',
  'Education',
  'Healthcare',
  'Other',
];

export function PublishPackDialog({ isOpen, onClose, onPublished, initialPack }: PublishPackDialogProps) {
  const [step, setStep] = useState<Step>(initialPack ? 'metadata' : 'upload');
  const [packData, setPackData] = useState<PackData | null>(initialPack || null);
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  // Metadata
  const [name, setName] = useState(initialPack?.packMeta?.name || '');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState(initialPack?.packMeta?.description || '');
  const [icon, setIcon] = useState('');
  const [category, setCategory] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'unlisted' | 'private'>('public');
  const [version, setVersion] = useState(initialPack?.packMeta?.version || '1.0.0');
  const [changelog, setChangelog] = useState('Initial release');

  const [publishing, setPublishing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const generateSlug = (n: string) =>
    n.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-|-$/g, '');

  const resetState = useCallback(() => {
    setStep(initialPack ? 'metadata' : 'upload');
    setPackData(initialPack || null);
    setUploadFileName('');
    setUploadError('');
    setIsDragging(false);
    setName(initialPack?.packMeta?.name || '');
    setSlug('');
    setDescription(initialPack?.packMeta?.description || '');
    setIcon('');
    setCategory('');
    setTagsInput('');
    setVisibility('public');
    setVersion(initialPack?.packMeta?.version || '1.0.0');
    setChangelog('Initial release');
    setPublishing(false);
  }, [initialPack]);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  const parseFile = useCallback((file: File) => {
    setUploadError('');

    if (file.name.endsWith('.zip')) {
      // Upload to server for processing
      (async () => {
        try {
          const result = await api.uploadPackZip(file);
          if (result.data?.pack) {
            setPackData(result.data.pack);
            setUploadFileName(file.name);
            setName(result.data.pack.packMeta?.name || '');
            setDescription(result.data.pack.packMeta?.description || '');
            setVersion(result.data.pack.packMeta?.version || '1.0.0');
          } else {
            setUploadError(result.error || 'Failed to parse zip file');
          }
        } catch {
          setUploadError('Failed to upload file');
        }
      })();
      return;
    }

    if (!file.name.endsWith('.json')) {
      setUploadError('Only .json and .zip files are accepted.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string) as PackData;
        if (!data.formatVersion || !data.packMeta || !Array.isArray(data.forms)) {
          setUploadError('Invalid pack format.');
          return;
        }
        setPackData(data);
        setUploadFileName(file.name);
        setName(data.packMeta.name || '');
        setDescription(data.packMeta.description || '');
        setVersion(data.packMeta.version || '1.0.0');
      } catch {
        setUploadError('Failed to parse JSON file.');
      }
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  }, [parseFile]);

  const handlePublish = useCallback(async () => {
    if (!packData || !name || publishing) return;
    setPublishing(true);

    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
    const finalSlug = slug || generateSlug(name);

    try {
      const result = await api.publishPack({
        pack: packData,
        name,
        description,
        icon,
        tags,
        category,
        visibility,
        version,
        changelog,
        slug: finalSlug,
      });

      if (result.data?.success) {
        toast.success('Pack published!', `Your pack is now available at /packs/${result.data.slug}`);
        onPublished?.();
        handleClose();
      } else {
        toast.error('Publish failed', result.error || 'Unknown error');
      }
    } catch (err) {
      toast.error('Publish failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPublishing(false);
    }
  }, [packData, name, slug, description, icon, tagsInput, category, visibility, version, changelog, publishing, handleClose, onPublished]);

  const steps: Step[] = ['upload', 'metadata', 'preview', 'publish'];
  const stepIndex = steps.indexOf(step);
  const stepLabels: Record<Step, string> = {
    upload: 'Upload',
    metadata: 'Details',
    preview: 'Preview',
    publish: 'Publish',
  };

  const canProceed = () => {
    if (step === 'upload') return !!packData;
    if (step === 'metadata') return !!name;
    return true;
  };

  const formCount = packData?.forms?.length ?? 0;
  const appCount = packData?.apps?.length ?? 0;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Publish Pack" size="lg">
      <div className="p-4 sm:p-6 space-y-4">
        {/* Step indicator */}
        <div className="flex items-center gap-2 justify-center">
          {steps.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold transition-colors ${
                  i <= stepIndex
                    ? 'bg-primary-600 text-primary-foreground'
                    : 'bg-gray-200 dark:bg-slate-700 text-gray-500 dark:text-slate-400'
                }`}
              >
                {i + 1}
              </div>
              <span className={`text-xs font-medium ${
                i <= stepIndex ? 'text-gray-900 dark:text-white' : 'text-gray-400 dark:text-slate-500'
              }`}>
                {stepLabels[s]}
              </span>
              {i < steps.length - 1 && (
                <div className={`w-8 h-0.5 ${i < stepIndex ? 'bg-primary-600' : 'bg-gray-200 dark:bg-slate-700'}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <div className="space-y-4">
            <div
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
              onClick={() => fileInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                isDragging
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10'
                  : packData
                    ? 'border-green-400 bg-green-50 dark:bg-green-500/10'
                    : 'border-gray-300 dark:border-slate-700 hover:border-gray-400 bg-gray-50 dark:bg-slate-800/50'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.zip"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); e.target.value = ''; }}
                className="hidden"
              />
              {packData ? (
                <>
                  <FileJson className="h-8 w-8 text-green-500 mb-2" />
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{uploadFileName}</p>
                  <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                    {formCount} form{formCount !== 1 ? 's' : ''}, {appCount} app{appCount !== 1 ? 's' : ''}
                  </p>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setPackData(null); setUploadFileName(''); }}
                    className="mt-2 text-xs text-gray-500 hover:text-red-500 underline cursor-pointer"
                  >
                    Remove
                  </button>
                </>
              ) : (
                <>
                  <Upload className="h-8 w-8 text-gray-400 dark:text-slate-500 mb-2" />
                  <p className="text-sm font-medium text-gray-700 dark:text-slate-300">
                    Drop a .json or .zip pack file
                  </p>
                  <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">or click to browse</p>
                </>
              )}
            </div>
            {uploadError && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 p-3 rounded-lg border border-red-200 dark:border-red-500/30">
                <X className="h-4 w-4 flex-shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Metadata */}
        {step === 'metadata' && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); if (!slug) setSlug(generateSlug(e.target.value)); }}
                placeholder="My Awesome Pack"
                className="w-full rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:ring-1 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Slug</label>
              <input
                type="text"
                value={slug || generateSlug(name)}
                onChange={(e) => setSlug(e.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:ring-1 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Describe what this pack includes..."
                className="w-full rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white px-3 py-2 text-sm resize-none focus:ring-1 focus:ring-primary-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Icon (emoji)</label>
                <input
                  type="text"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="📦"
                  className="w-full rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:ring-1 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:ring-1 focus:ring-primary-500"
                >
                  <option value="">Select...</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Tags (comma separated)</label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="finance, compliance, onboarding"
                className="w-full rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:ring-1 focus:ring-primary-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Version</label>
                <input
                  type="text"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="1.0.0"
                  className="w-full rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white px-3 py-2 text-sm focus:ring-1 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1">Visibility</label>
                <div className="flex gap-2">
                  {([['public', Globe, 'Public'], ['unlisted', EyeOff, 'Unlisted'], ['private', Lock, 'Private']] as const).map(([val, Icon, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setVisibility(val)}
                      className={`flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
                        visibility === val
                          ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                          : 'border-gray-300 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:border-gray-400'
                      }`}
                    >
                      <Icon className="h-3 w-3" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Preview */}
        {step === 'preview' && packData && (
          <div className="space-y-3">
            <div className="p-4 rounded-lg border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-3xl">{icon || '📦'}</span>
                <div>
                  <h3 className="text-sm font-bold text-gray-900 dark:text-white">{name}</h3>
                  <p className="text-xs text-gray-500 dark:text-slate-400">v{version} &middot; {visibility}</p>
                </div>
              </div>
              {description && (
                <p className="text-xs text-gray-600 dark:text-slate-400 mb-2">{description}</p>
              )}
              {tagsInput && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {tagsInput.split(',').map((t) => t.trim()).filter(Boolean).map((tag) => (
                    <Badge key={tag} variant="default" size="sm">{tag}</Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="text-sm font-medium text-gray-700 dark:text-slate-300">
              Contents: {formCount} form{formCount !== 1 ? 's' : ''}, {appCount} app{appCount !== 1 ? 's' : ''}
            </div>

            <div className="max-h-32 overflow-y-auto space-y-1">
              {packData.forms.map((form, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-400">
                  <FileJson className="h-3.5 w-3.5 text-gray-400" />
                  <span>{(form as Record<string, unknown>).title as string || `Form ${i + 1}`}</span>
                </div>
              ))}
              {(packData.apps ?? []).map((app, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-400">
                  <Globe className="h-3.5 w-3.5 text-gray-400" />
                  <span>{(app as Record<string, unknown>).name as string || `App ${i + 1}`}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 4: Confirm */}
        {step === 'publish' && (
          <div className="text-center py-6 space-y-4">
            {publishing ? (
              <>
                <Loader2 className="h-10 w-10 animate-spin text-primary-600 mx-auto" />
                <p className="text-sm text-gray-600 dark:text-slate-400">Publishing your pack...</p>
              </>
            ) : (
              <>
                <Package className="h-10 w-10 text-primary-600 mx-auto" />
                <div>
                  <h3 className="text-lg font-bold text-gray-900 dark:text-white">Ready to publish</h3>
                  <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
                    Your pack "{name}" will be {visibility === 'public' ? 'visible to everyone' : visibility === 'unlisted' ? 'accessible via direct link' : 'only visible to you'}.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-slate-300 mb-1 text-left">Changelog</label>
                  <textarea
                    value={changelog}
                    onChange={(e) => setChangelog(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-white px-3 py-2 text-sm resize-none focus:ring-1 focus:ring-primary-500"
                  />
                </div>
              </>
            )}
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex items-center justify-between border-t border-gray-200 dark:border-slate-800 pt-4">
          <div>
            {stepIndex > 0 && step !== 'publish' && (
              <Button variant="outline" onClick={() => setStep(steps[stepIndex - 1])}>
                <ChevronLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={handleClose}>Cancel</Button>
            {step === 'publish' ? (
              <Button variant="primary" onClick={handlePublish} isLoading={publishing} disabled={publishing}>
                {publishing ? 'Publishing...' : 'Publish'}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => setStep(steps[stepIndex + 1])}
                disabled={!canProceed()}
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
