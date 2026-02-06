import { useState, useRef, useEffect } from 'react';
import { X, Sparkles, FileText, Image, Upload, Loader2, AlertCircle, Wand2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import type { FormField } from '../../types/form';
import { v4 as uuidv4 } from 'uuid';

interface AIFormGeneratorProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (title: string, description: string, fields: FormField[], prompt?: string) => void;
}

type TabType = 'prompt' | 'document' | 'image';

export function AIFormGenerator({ isOpen, onClose, onGenerate }: AIFormGeneratorProps) {
  const [activeTab, setActiveTab] = useState<TabType>('prompt');
  const [prompt, setPrompt] = useState('');
  const [additionalPrompt, setAdditionalPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Check AI availability on mount
  useEffect(() => {
    if (isOpen) {
      checkAvailability();
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

  const checkAvailability = async () => {
    const result = await api.getAIStatus();
    if (result.data) {
      setIsAvailable(result.data.available);
    } else {
      setIsAvailable(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, type: 'document' | 'image') => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFile(file);

    // Create preview for images
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

    // Validate file type
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
    if (activeTab === 'prompt' && !prompt.trim()) {
      toast.error('Prompt Required', 'Please enter a description for your form');
      return;
    }

    if ((activeTab === 'document' || activeTab === 'image') && !selectedFile) {
      toast.error('File Required', 'Please select a file to analyze');
      return;
    }

    setIsGenerating(true);

    try {
      let result;

      if (activeTab === 'prompt') {
        result = await api.generateFormFromPrompt(prompt);
      } else {
        result = await api.generateFormFromFile(selectedFile!, additionalPrompt || undefined);
      }

      if (result.error) {
        toast.error('Generation Failed', result.error);
        return;
      }

      if (!result.data?.data) {
        toast.error('Generation Failed', 'No form data received');
        return;
      }

      const { title, description, fields } = result.data.data;

      // Convert AI-generated fields to FormField format with proper IDs and order
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

      toast.success('Form Generated', `Created ${formFields.length} fields`);
      onGenerate(title, description || '', formFields, activeTab === 'prompt' ? prompt : additionalPrompt);
      resetAndClose();
    } catch (error) {
      console.error('AI generation error:', error);
      toast.error('Generation Failed', error instanceof Error ? error.message : 'An unexpected error occurred');
    } finally {
      setIsGenerating(false);
    }
  };

  const resetAndClose = () => {
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="absolute inset-0" onClick={resetAndClose} />
      <div className="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden flex flex-col border border-gray-200 dark:border-slate-800">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-slate-800 bg-gradient-to-r from-purple-50/50 via-violet-50/30 to-blue-50/50 dark:from-slate-900 dark:via-slate-800/50 dark:to-slate-900">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-br from-purple-400 to-blue-400 rounded-xl blur-md opacity-40" />
              <div className="relative p-3 bg-gradient-to-br from-purple-500 via-violet-500 to-blue-500 rounded-xl shadow-lg">
                <Sparkles className="h-6 w-6 text-white" />
              </div>
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Create with AI</h2>
              <p className="text-sm text-gray-500 dark:text-slate-400">Generate form fields automatically</p>
            </div>
          </div>
          <button
            onClick={resetAndClose}
            className="p-2 hover:bg-white/80 dark:hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="h-5 w-5 text-gray-500 dark:text-slate-400" />
          </button>
        </div>

        {/* Availability Check */}
        {isAvailable === false && (
          <div className="mx-6 mt-4 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">AI Service Unavailable</p>
              <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                The AI service is not configured. Please set the OPENAI_API_KEY environment variable on the server.
              </p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-slate-800 px-6 bg-gray-50/50 dark:bg-slate-900/50">
          <button
            onClick={() => setActiveTab('prompt')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-all ${activeTab === 'prompt'
              ? 'border-purple-500 text-purple-600 dark:text-purple-400 bg-white dark:bg-slate-800'
              : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50/50 dark:hover:bg-purple-900/20'
              }`}
          >
            <Wand2 className={`h-4 w-4 ${activeTab === 'prompt' ? 'text-purple-500 dark:text-purple-400' : ''}`} />
            Text Prompt
          </button>
          <button
            onClick={() => setActiveTab('document')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-all ${activeTab === 'document'
              ? 'border-purple-500 text-purple-600 dark:text-purple-400 bg-white dark:bg-slate-800'
              : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50/50 dark:hover:bg-purple-900/20'
              }`}
          >
            <FileText className={`h-4 w-4 ${activeTab === 'document' ? 'text-purple-500 dark:text-purple-400' : ''}`} />
            Upload Document
          </button>
          <button
            onClick={() => setActiveTab('image')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-all ${activeTab === 'image'
              ? 'border-purple-500 text-purple-600 dark:text-purple-400 bg-white dark:bg-slate-800'
              : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50/50 dark:hover:bg-purple-900/20'
              }`}
          >
            <Image className={`h-4 w-4 ${activeTab === 'image' ? 'text-purple-500 dark:text-purple-400' : ''}`} />
            Upload Photo
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'prompt' && (
            <div className="space-y-5">
              <div>
                <label className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-slate-200 mb-3">
                  <Sparkles className="h-4 w-4 text-purple-500" />
                  Describe your form
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Example: Create a customer feedback form with ratings for service quality, product satisfaction, and a text area for additional comments. Include fields for name and email."
                  className="w-full h-40 px-4 py-3 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-300 dark:focus:border-purple-500 focus:bg-white dark:focus:bg-slate-800 resize-none transition-all text-gray-700 dark:text-slate-200 placeholder:text-gray-400 dark:placeholder:text-slate-500"
                />
              </div>
              <div className="bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-900/20 dark:to-blue-900/20 rounded-xl p-5 border border-purple-100 dark:border-purple-900/30">
                <h4 className="text-sm font-semibold text-gray-800 dark:text-slate-200 mb-3 flex items-center gap-2">
                  <span className="w-5 h-5 bg-purple-100 dark:bg-purple-900/50 rounded-full flex items-center justify-center text-xs text-purple-700 dark:text-purple-300">?</span>
                  Tips for better results
                </h4>
                <ul className="text-sm text-gray-600 dark:text-slate-400 space-y-2">
                  <li className="flex items-start gap-2">
                    <span className="text-purple-400 mt-1">•</span>
                    <span>Be specific about field types (email, phone, dropdown, etc.)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-purple-400 mt-1">•</span>
                    <span>Mention which fields should be required</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-purple-400 mt-1">•</span>
                    <span>Include any specific validation needs</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-purple-400 mt-1">•</span>
                    <span>Describe the purpose of your form</span>
                  </li>
                </ul>
              </div>
            </div>
          )}

          {activeTab === 'document' && (
            <div className="space-y-5">
              <div
                onDrop={(e) => handleDrop(e, 'document')}
                onDragOver={(e) => e.preventDefault()}
                className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${selectedFile
                  ? 'border-purple-300 bg-gradient-to-b from-purple-50 to-white dark:from-purple-900/30 dark:to-slate-900'
                  : 'border-gray-300 dark:border-slate-700 hover:border-purple-300 dark:hover:border-purple-500 hover:bg-purple-50/30 dark:hover:bg-purple-900/10'
                  }`}
              >
                {selectedFile ? (
                  <div className="space-y-4">
                    {previewUrl ? (
                      <img src={previewUrl} alt="Preview" className="max-h-40 mx-auto rounded-lg shadow-md" />
                    ) : (
                      <div className="w-16 h-16 mx-auto bg-gradient-to-br from-purple-100 to-blue-100 dark:from-purple-900/30 dark:to-blue-900/30 rounded-xl flex items-center justify-center">
                        <FileText className="h-8 w-8 text-purple-500" />
                      </div>
                    )}
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{selectedFile.name}</p>
                    <p className="text-xs text-gray-500">
                      {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                    </p>
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
                      className="border-gray-300"
                    >
                      Remove File
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="w-16 h-16 mx-auto bg-gradient-to-br from-gray-100 to-gray-50 dark:from-slate-800 dark:to-slate-700/50 rounded-xl flex items-center justify-center">
                      <Upload className="h-8 w-8 text-gray-400 dark:text-slate-500" />
                    </div>
                    <div>
                      <p className="text-gray-600 dark:text-slate-400">Drag and drop a file here, or</p>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="text-purple-600 font-semibold hover:text-purple-700 transition-colors"
                      >
                        browse to upload
                      </button>
                    </div>
                    <p className="text-xs text-gray-500">PDF, Word documents, or images up to 10MB</p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,image/*"
                  onChange={(e) => handleFileSelect(e, 'document')}
                  className="hidden"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-800 dark:text-slate-200 mb-2">
                  Additional instructions (optional)
                </label>
                <textarea
                  value={additionalPrompt}
                  onChange={(e) => setAdditionalPrompt(e.target.value)}
                  placeholder="Any specific instructions for how to interpret the document..."
                  className="w-full h-24 px-4 py-3 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-300 dark:focus:border-purple-500 focus:bg-white dark:focus:bg-slate-800 resize-none transition-all text-gray-700 dark:text-slate-200 placeholder:text-gray-400 dark:placeholder:text-slate-500"
                />
              </div>
            </div>
          )}

          {activeTab === 'image' && (
            <div className="space-y-5">
              <div
                onDrop={(e) => handleDrop(e, 'image')}
                onDragOver={(e) => e.preventDefault()}
                className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${selectedFile
                  ? 'border-purple-300 bg-gradient-to-b from-purple-50 to-white dark:from-purple-900/30 dark:to-slate-900'
                  : 'border-gray-300 dark:border-slate-700 hover:border-purple-300 dark:hover:border-purple-500 hover:bg-purple-50/30 dark:hover:bg-purple-900/10'
                  }`}
              >
                {selectedFile && previewUrl ? (
                  <div className="space-y-4">
                    <img src={previewUrl} alt="Preview" className="max-h-48 mx-auto rounded-xl shadow-lg" />
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{selectedFile.name}</p>
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
                      className="border-gray-300"
                    >
                      Remove Image
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="w-16 h-16 mx-auto bg-gradient-to-br from-gray-100 to-gray-50 dark:from-slate-800 dark:to-slate-700/50 rounded-xl flex items-center justify-center">
                      <Image className="h-8 w-8 text-gray-400 dark:text-slate-500" />
                    </div>
                    <div>
                      <p className="text-gray-600 dark:text-slate-400">Take a photo of a paper form or</p>
                      <button
                        onClick={() => imageInputRef.current?.click()}
                        className="text-purple-600 font-semibold hover:text-purple-700 transition-colors"
                      >
                        upload an image
                      </button>
                    </div>
                    <p className="text-xs text-gray-500">JPEG, PNG, GIF, or WebP up to 10MB</p>
                  </div>
                )}
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleFileSelect(e, 'image')}
                  className="hidden"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-800 dark:text-slate-200 mb-2">
                  Additional instructions (optional)
                </label>
                <textarea
                  value={additionalPrompt}
                  onChange={(e) => setAdditionalPrompt(e.target.value)}
                  placeholder="Any specific instructions for how to interpret the form image..."
                  className="w-full h-24 px-4 py-3 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-300 dark:focus:border-purple-500 focus:bg-white dark:focus:bg-slate-800 resize-none transition-all text-gray-700 dark:text-slate-200 placeholder:text-gray-400 dark:placeholder:text-slate-500"
                />
              </div>

              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl p-5 border border-blue-100 dark:border-blue-900/30">
                <h4 className="text-sm font-semibold text-gray-800 dark:text-slate-200 mb-3 flex items-center gap-2">
                  <span className="w-5 h-5 bg-blue-100 dark:bg-blue-900/50 rounded-full flex items-center justify-center text-xs text-blue-600 dark:text-blue-300">i</span>
                  Best practices for form photos
                </h4>
                <ul className="text-sm text-gray-600 dark:text-slate-400 space-y-2">
                  <li className="flex items-start gap-2">
                    <span className="text-blue-400 mt-1">•</span>
                    <span>Ensure good lighting and clear focus</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-blue-400 mt-1">•</span>
                    <span>Capture the entire form in frame</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-blue-400 mt-1">•</span>
                    <span>Avoid glare and shadows</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-blue-400 mt-1">•</span>
                    <span>Use a flat surface for best results</span>
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 dark:border-slate-800 bg-gradient-to-r from-gray-50 to-slate-50 dark:from-slate-800 dark:to-slate-900/50">
          <Button variant="outline" onClick={resetAndClose} className="border-gray-300 dark:border-slate-700">
            Cancel
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={isGenerating || isAvailable === false}
            className="bg-gradient-to-r from-purple-600 via-violet-600 to-blue-600 hover:from-purple-700 hover:via-violet-700 hover:to-blue-700 shadow-md shadow-purple-500/20 hover:shadow-lg hover:shadow-purple-500/30 transition-all duration-200 px-6"
          >
            {isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-2" />
                Generate Form
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
