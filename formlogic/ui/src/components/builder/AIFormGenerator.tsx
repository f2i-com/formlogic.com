import { useState, useRef, useEffect } from 'react';
import { Sparkles, FileText, Image, Upload, AlertCircle, Wand2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/Tabs';
import { api } from '../../lib/api';
import type { AIFormGenerationResult } from '../../lib/api';
import { logger } from '../../lib/logger';
import { toast } from '../../stores/toastStore';
import type { FormField } from '../../types/form';
import { desktopClient } from '../../client-runtime/desktop/desktopClient';
import {
  eligibleDesktopFormProviders,
  generateFormWithDesktopProvider,
  type DesktopFormProvider,
} from './desktopFormGeneration';
import { v4 as uuidv4 } from 'uuid';

export interface AIGenerateResult {
  title: string;
  description: string;
  fields: FormField[];
  prompt?: string;
  logicScript?: string;
  logicPrompt?: string;
  /** Edit mode: replace the form's fields/script instead of appending. */
  replaceFields?: boolean;
}

interface AIFormGeneratorProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (result: AIGenerateResult) => void;
  /** Current form context — when present (and non-empty), a text prompt EDITS this form. */
  existingFields?: Array<{ id: string; label: string; type: string; required?: boolean }>;
  existingScript?: string;
}

type TabType = 'prompt' | 'document' | 'image';
type GenerationSource = 'hosted' | `desktop:${string}`;

export function AIFormGenerator({ isOpen, onClose, onGenerate, existingFields, existingScript }: AIFormGeneratorProps) {
  const [activeTab, setActiveTab] = useState<TabType>('prompt');
  const [prompt, setPrompt] = useState('');
  const [additionalPrompt, setAdditionalPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  // Two-stage generation: 'form' = fields, 'script' = the optional follow-up backend-logic call.
  const [genStage, setGenStage] = useState<'form' | 'script' | null>(null);
  // When on (default), also generate the backend script if the form needs logic. Opt out to get
  // fields only and write the script yourself in the Script section.
  const [autoScript, setAutoScript] = useState(true);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [aiMessage, setAiMessage] = useState('');
  // Session-only by design: never leave one account's provider choice in
  // persistent browser storage for a later authenticated user.
  const [generationSource, setGenerationSource] = useState<GenerationSource>('hosted');
  const [desktopProviders, setDesktopProviders] = useState<DesktopFormProvider[]>([]);
  const [desktopProvidersLoading, setDesktopProvidersLoading] = useState(false);
  const [desktopProvidersError, setDesktopProvidersError] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const generationAbortRef = useRef<AbortController | null>(null);

  // Check AI availability on mount
  useEffect(() => {
    if (isOpen) {
      checkAvailability().catch(() => setIsAvailable(false));
      let cancelled = false;
      setDesktopProvidersLoading(true);
      setDesktopProvidersError('');
      desktopClient.ai.sources().then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setDesktopProviders([]);
          setDesktopProvidersError(result.error.message || 'FormLogic Desktop is not reachable.');
          return;
        }
        try {
          setDesktopProviders(eligibleDesktopFormProviders(result.data));
        } catch (error) {
          setDesktopProviders([]);
          setDesktopProvidersError(error instanceof Error ? error.message : 'Desktop returned invalid provider details.');
        }
      }).catch(() => {
        if (!cancelled) {
          setDesktopProviders([]);
          setDesktopProvidersError('FormLogic Desktop is not reachable.');
        }
      }).finally(() => {
        if (!cancelled) setDesktopProvidersLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [isOpen]);

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => () => generationAbortRef.current?.abort(), []);

  const checkAvailability = async () => {
    const result = await api.getAIStatus();
    if (result.data) {
      setIsAvailable(result.data.available);
      setAiMessage(result.data.message || '');
    } else {
      setIsAvailable(false);
      setAiMessage('AI is unavailable right now.');
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, type: 'document' | 'image') => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFile(file);

    // Revoke previous URL to prevent memory leak
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    if (type === 'image' || file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
  };

  const handleDrop = (e: React.DragEvent, type: 'document' | 'image') => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;

    const validDocTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

    if (type === 'document' && !validDocTypes.includes(file.type) && !validImageTypes.includes(file.type)) {
      toast.error('Invalid File', 'Please upload a PDF, Word document, or image file');
      return;
    }

    if (type === 'image' && !validImageTypes.includes(file.type)) {
      toast.error('Invalid File', 'Please upload an image file (JPEG, PNG, GIF, or WebP)');
      return;
    }

    setSelectedFile(file);

    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
  };

  const handleGenerate = async () => {
    // Snapshot the route before any async work. A provider/model change in Desktop or a tab
    // click during the request cannot cause provider mixing part-way through this job.
    const tabAtStart = activeTab;
    const promptAtStart = prompt;
    const additionalPromptAtStart = additionalPrompt;
    const sourceAtStart: GenerationSource = tabAtStart === 'prompt' ? generationSource : 'hosted';
    const desktopProviderId = sourceAtStart.startsWith('desktop:')
      ? sourceAtStart.slice('desktop:'.length)
      : null;
    const desktopProvider = desktopProviderId
      ? desktopProviders.find((provider) => provider.id === desktopProviderId)
      : undefined;
    const editMode = tabAtStart === 'prompt' && (existingFields?.length ?? 0) > 0;

    if (tabAtStart === 'prompt' && !promptAtStart.trim()) {
      toast.error('Prompt Required', 'Please enter a description for your form');
      return;
    }

    if ((tabAtStart === 'document' || tabAtStart === 'image') && !selectedFile) {
      toast.error('File Required', 'Please select a file to analyze');
      return;
    }

    if (desktopProviderId && !desktopProvider) {
      toast.error('Desktop Provider Unavailable', 'Choose an enabled OpenAI-compatible provider from FormLogic Desktop.');
      return;
    }

    if (desktopProvider && editMode) {
      toast.error('Hosted Editing Required', 'Desktop providers can create a new form from text, but cannot safely edit an existing form yet. Select FormLogic Hosted.');
      return;
    }

    setIsGenerating(true);
    setGenStage('form');
    const generationAbort = new AbortController();
    generationAbortRef.current?.abort();
    generationAbortRef.current = generationAbort;

    try {
      let generated: AIFormGenerationResult | undefined;

      if (desktopProvider) {
        generated = await generateFormWithDesktopProvider({
          providerId: desktopProvider.id,
          model: desktopProvider.model,
          prompt: promptAtStart,
          signal: generationAbort.signal,
        });
      } else if (tabAtStart === 'prompt') {
        const result = await api.generateFormFromPrompt(
          promptAtStart,
          editMode ? existingFields : undefined,
          editMode ? existingScript : undefined,
        );
        if (generationAbort.signal.aborted) return;
        if (result.error) {
          toast.error('Generation Failed', result.error);
          return;
        }
        generated = result.data;
      } else {
        const result = await api.generateFormFromFile(selectedFile!, additionalPromptAtStart || undefined);
        if (generationAbort.signal.aborted) return;
        if (result.error) {
          toast.error('Generation Failed', result.error);
          return;
        }
        generated = result.data;
      }

      if (generationAbort.signal.aborted) return;
      if (!generated?.data) {
        toast.error('Generation Failed', 'No form data received');
        return;
      }

      const { title, description, fields, needsScript, suggestedScript } = generated.data;

      const formFields: FormField[] = fields.map((field, index) => ({
        id: field.id || uuidv4(),
        type: field.type as FormField['type'],
        label: field.label,
        description: field.description || '',
        placeholder: field.placeholder || '',
        required: field.required,
        order: index,
        properties: field.properties || {},
        validation: [],
        conditionalLogic: undefined,
      }));

      // Second, separate AI call — generate the backend onSubmit script ONLY when the form
      // genuinely needs logic (the form-gen flagged needsScript). Best-effort: if it fails, the
      // form is still created with its fields. The Script section remains available to refine it.
      let logicScript: string | undefined;
      const scriptDesc = (suggestedScript || '').trim();
      if (!desktopProvider && autoScript && needsScript && scriptDesc) {
        setGenStage('script');
        try {
          // Minimal field projection the script generator needs (matches ScriptEditor).
          const fieldProjection = formFields.map((f) => ({ id: f.id, label: f.label, type: f.type }));
          // Editing a form that already has a script → MODIFY it; otherwise generate a fresh one.
          const scriptRes = editMode && (existingScript || '').trim()
            ? await api.improveScript(existingScript as string, scriptDesc, fieldProjection)
            : await api.generateScript(scriptDesc, fieldProjection);
          if (generationAbort.signal.aborted) return;
          if (scriptRes.data?.data?.script) {
            logicScript = scriptRes.data.data.script;
          }
        } catch (e) {
          logger.error('AI script generation (post-form) failed:', e);
        }
      }

      if (generationAbort.signal.aborted) return;
      toast.success(
        editMode ? 'Form Updated' : 'Form Generated',
        editMode
          ? (logicScript ? `${formFields.length} fields + backend logic updated` : `${formFields.length} fields updated`)
          : (logicScript ? `Created ${formFields.length} fields + backend logic` : `Created ${formFields.length} fields`)
      );
      onGenerate({
        title,
        description: description || '',
        fields: formFields,
        prompt: tabAtStart === 'prompt' ? promptAtStart : additionalPromptAtStart,
        logicScript,
        logicPrompt: logicScript ? scriptDesc : undefined,
        replaceFields: editMode,
      });
      resetAndClose();
    } catch (error) {
      if (generationAbort.signal.aborted) return;
      logger.error('AI generation error:', error);
      toast.error('Generation Failed', error instanceof Error ? error.message : 'An unexpected error occurred');
    } finally {
      if (generationAbortRef.current === generationAbort) generationAbortRef.current = null;
      setIsGenerating(false);
      setGenStage(null);
    }
  };

  const resetAndClose = () => {
    generationAbortRef.current?.abort();
    generationAbortRef.current = null;
    setPrompt('');
    setAdditionalPrompt('');
    setSelectedFile(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setActiveTab('prompt');
    onClose();
  };

  const tabs: { key: TabType; label: string; icon: React.ElementType }[] = [
    { key: 'prompt', label: 'Prompt', icon: Wand2 },
    { key: 'document', label: 'Document · Hosted', icon: FileText },
    { key: 'image', label: 'Photo · Hosted', icon: Image },
  ];

  const editing = (existingFields?.length ?? 0) > 0;
  const selectedDesktopProviderId = generationSource.startsWith('desktop:')
    ? generationSource.slice('desktop:'.length)
    : null;
  const selectedDesktopProvider = selectedDesktopProviderId
    ? desktopProviders.find((provider) => provider.id === selectedDesktopProviderId)
    : undefined;
  const usesDesktopProvider = activeTab === 'prompt' && selectedDesktopProviderId !== null;
  const usesHostedGeneration = !usesDesktopProvider;
  const desktopSelectionUnavailable = usesDesktopProvider
    && !desktopProvidersLoading
    && !selectedDesktopProvider;
  const generationAvailable = usesDesktopProvider
    ? !!selectedDesktopProvider && !editing
    : isAvailable !== false;

  return (
    <Modal isOpen={isOpen} onClose={resetAndClose} title="Create with AI" size="lg">
      {/* Availability warning */}
      {usesHostedGeneration && isAvailable === false && (
        <div role="alert" className="mx-6 mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">AI generation isn't enabled</p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-0.5">
              AI form generation isn't enabled for this workspace. Contact your administrator to turn it on, or build your form manually.
            </p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabType)}>
        <TabsList variant="underline" aria-label="Generation source" className="px-6">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger key={tab.key} value={tab.key} variant="underline">
                <span className="flex items-center gap-2"><Icon className="h-4 w-4" />{tab.label}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>

        {/* Content — no own scroll: the Modal already wraps children in one
            scroll region, so a second one here caused a double scrollbar. A
            min-height keeps short tabs from collapsing. */}
        <div className="p-6 min-h-[280px]">
          <TabsContent value="prompt">{activeTab === 'prompt' && (
          <div className="space-y-4">
            <div>
              <label htmlFor="ai-form-generation-source" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                AI service
              </label>
              <select
                id="ai-form-generation-source"
                value={generationSource}
                onChange={(event) => setGenerationSource(event.target.value as GenerationSource)}
                disabled={isGenerating}
                className="w-full px-3 py-2.5 bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 text-gray-900 dark:text-white"
              >
                <option value="hosted">FormLogic Hosted</option>
                {desktopProviders.map((provider) => (
                  <option key={provider.id} value={`desktop:${provider.id}`} disabled={editing}>
                    Desktop · {provider.name}{provider.model ? ` (${provider.model})` : ''}{editing ? ' — new forms only' : ''}
                  </option>
                ))}
                {desktopSelectionUnavailable && (
                  <option value={generationSource} disabled>Desktop provider unavailable</option>
                )}
              </select>
              <p className="mt-1.5 text-xs text-gray-500 dark:text-slate-400">
                {usesDesktopProvider
                  ? 'Your prompt goes through the paired Desktop to this exact provider. Credentials never enter the website.'
                  : 'Uses FormLogic’s hosted form generator and validated logic-generation path.'}
              </p>
              {!usesDesktopProvider && !desktopProvidersLoading && desktopProviders.length === 0 && (
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                  {desktopProvidersError || 'Pair FormLogic Desktop and enable an OpenAI-compatible chat provider to use your own account.'}
                </p>
              )}
            </div>
            {usesDesktopProvider && editing && (
              <div role="alert" className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg text-sm text-amber-800 dark:text-amber-300">
                Desktop providers currently create new forms only. Select FormLogic Hosted to safely preserve this form’s field IDs while editing it.
              </div>
            )}
            {desktopSelectionUnavailable && (
              <div role="alert" className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg text-sm text-amber-800 dark:text-amber-300">
                That Desktop provider is no longer available. Choose another enabled OpenAI-compatible provider or select FormLogic Hosted.
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                {editing ? 'Describe the change' : 'Describe your form'}
              </label>
              {editing && (
                <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">
                  This form has {existingFields!.length} field{existingFields!.length === 1 ? '' : 's'}. The AI will modify the existing form{existingScript ? ' and its script' : ''} from your instructions — it won't start over.
                </p>
              )}
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={editing
                  ? 'Example: Add a phone number field, make email required, and reject submissions where guests is over 10.'
                  : 'Example: Create a customer feedback form with ratings for service quality, product satisfaction, and a text area for additional comments. Include fields for name and email.'}
                className="w-full h-36 px-3 py-2.5 bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
              />
            </div>
            <div className="bg-gray-50 dark:bg-slate-800/50 rounded-lg p-4 border border-gray-200 dark:border-slate-700">
              <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Tips for better results</h4>
              <ul className="text-sm text-gray-500 dark:text-slate-400 space-y-1">
                <li>Be specific about field types (email, phone, dropdown, etc.)</li>
                <li>Mention which fields should be required</li>
                <li>Include any specific validation needs</li>
                <li>Describe the purpose of your form</li>
              </ul>
            </div>
          </div>
        )}</TabsContent>

          <TabsContent value="document">{activeTab === 'document' && (
          <div className="space-y-4">
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Document analysis uses FormLogic Hosted. Desktop providers are available only on the Prompt tab.
            </p>
            <div
              onDrop={(e) => handleDrop(e, 'document')}
              onDragOver={(e) => e.preventDefault()}
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                selectedFile
                  ? 'border-primary-300 dark:border-primary-600 bg-primary-50/50 dark:bg-primary-500/5'
                  : 'border-gray-300 dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-600'
              }`}
            >
              {selectedFile ? (
                <div className="space-y-3">
                  {previewUrl ? (
                    <img src={previewUrl} alt="Preview" className="max-h-36 mx-auto rounded-lg" />
                  ) : (
                    <div className="w-12 h-12 mx-auto bg-gray-100 dark:bg-slate-800 rounded-lg flex items-center justify-center">
                      <FileText className="h-6 w-6 text-gray-400 dark:text-slate-500" />
                    </div>
                  )}
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{selectedFile.name}</p>
                  <p className="text-xs text-gray-500 dark:text-slate-400">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedFile(null);
                      if (previewUrl) {
                        URL.revokeObjectURL(previewUrl);
                        setPreviewUrl(null);
                      }
                    }}
                  >
                    Remove File
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="w-12 h-12 mx-auto bg-gray-100 dark:bg-slate-800 rounded-lg flex items-center justify-center">
                    <Upload className="h-6 w-6 text-gray-400 dark:text-slate-500" />
                  </div>
                  <p className="text-sm text-gray-600 dark:text-slate-400">
                    Drag and drop a file here, or{' '}
                    <button onClick={() => fileInputRef.current?.click()} className="text-primary-600 dark:text-primary-400 font-medium hover:underline cursor-pointer">
                      browse to upload
                    </button>
                  </p>
                  <p className="text-xs text-gray-400 dark:text-slate-500">PDF, Word documents, or images up to 10MB</p>
                </div>
              )}
              <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,image/*" onChange={(e) => handleFileSelect(e, 'document')} className="hidden" />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Additional instructions (optional)</label>
              <textarea
                value={additionalPrompt}
                onChange={(e) => setAdditionalPrompt(e.target.value)}
                placeholder="Any specific instructions for how to interpret the document..."
                className="w-full h-20 px-3 py-2.5 bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
              />
            </div>
          </div>
        )}</TabsContent>

          <TabsContent value="image">{activeTab === 'image' && (
          <div className="space-y-4">
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Photo analysis uses FormLogic Hosted. Desktop providers are available only on the Prompt tab.
            </p>
            <div
              onDrop={(e) => handleDrop(e, 'image')}
              onDragOver={(e) => e.preventDefault()}
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                selectedFile
                  ? 'border-primary-300 dark:border-primary-600 bg-primary-50/50 dark:bg-primary-500/5'
                  : 'border-gray-300 dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-600'
              }`}
            >
              {selectedFile && previewUrl ? (
                <div className="space-y-3">
                  <img src={previewUrl} alt="Preview" className="max-h-40 mx-auto rounded-lg" />
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{selectedFile.name}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedFile(null);
                      if (previewUrl) {
                        URL.revokeObjectURL(previewUrl);
                        setPreviewUrl(null);
                      }
                    }}
                  >
                    Remove Image
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="w-12 h-12 mx-auto bg-gray-100 dark:bg-slate-800 rounded-lg flex items-center justify-center">
                    <Image className="h-6 w-6 text-gray-400 dark:text-slate-500" />
                  </div>
                  <p className="text-sm text-gray-600 dark:text-slate-400">
                    Take a photo of a paper form or{' '}
                    <button onClick={() => imageInputRef.current?.click()} className="text-primary-600 dark:text-primary-400 font-medium hover:underline cursor-pointer">
                      upload an image
                    </button>
                  </p>
                  <p className="text-xs text-gray-400 dark:text-slate-500">JPEG, PNG, GIF, or WebP up to 10MB</p>
                </div>
              )}
              <input ref={imageInputRef} type="file" accept="image/*" onChange={(e) => handleFileSelect(e, 'image')} className="hidden" />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Additional instructions (optional)</label>
              <textarea
                value={additionalPrompt}
                onChange={(e) => setAdditionalPrompt(e.target.value)}
                placeholder="Any specific instructions for how to interpret the form image..."
                className="w-full h-20 px-3 py-2.5 bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
              />
            </div>

            <div className="bg-gray-50 dark:bg-slate-800/50 rounded-lg p-4 border border-gray-200 dark:border-slate-700">
              <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Tips for form photos</h4>
              <ul className="text-sm text-gray-500 dark:text-slate-400 space-y-1">
                <li>Ensure good lighting and clear focus</li>
                <li>Capture the entire form in frame</li>
                <li>Avoid glare and shadows</li>
              </ul>
            </div>
          </div>
        )}</TabsContent>
        </div>
      </Tabs>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-200 dark:border-slate-700">
        {usesHostedGeneration && isAvailable === false ? (
          <p className="text-xs text-amber-700 dark:text-amber-400 min-w-0 leading-snug">
            {aiMessage || 'AI isn’t configured on this instance.'} <span className="text-gray-400 dark:text-slate-500">You can still build forms manually.</span>
          </p>
        ) : usesDesktopProvider ? (
          <p className="text-xs text-gray-500 dark:text-slate-400 min-w-0 leading-snug">
            Fields only — Desktop output cannot create or run backend logic. Use FormLogic Hosted for validated auto-logic.
          </p>
        ) : (
          <Switch
            size="sm"
            checked={autoScript}
            onChange={setAutoScript}
            disabled={isGenerating}
            label="Auto-generate logic"
          />
        )}
        <div className="flex items-center gap-2 shrink-0">
        <Button variant="outline" size="sm" onClick={resetAndClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleGenerate}
          disabled={isGenerating || !generationAvailable}
          isLoading={isGenerating}
          leftIcon={!isGenerating ? <Sparkles className="h-4 w-4" /> : undefined}
        >
          {isGenerating ? (genStage === 'script' ? 'Adding logic…' : 'Generating…') : 'Generate Form'}
        </Button>
        </div>
      </div>
    </Modal>
  );
}
