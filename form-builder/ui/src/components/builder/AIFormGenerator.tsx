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
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={resetAndClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-purple-500 to-blue-500 rounded-lg">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Create with AI</h2>
              <p className="text-sm text-gray-500">Generate form fields automatically</p>
            </div>
          </div>
          <button
            onClick={resetAndClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Availability Check */}
        {isAvailable === false && (
          <div className="mx-6 mt-4 p-4 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800">AI Service Unavailable</p>
              <p className="text-sm text-amber-700 mt-1">
                The AI service is not configured. Please set the OPENAI_API_KEY environment variable on the server.
              </p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-6">
          <button
            onClick={() => setActiveTab('prompt')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'prompt'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Wand2 className="h-4 w-4" />
            Text Prompt
          </button>
          <button
            onClick={() => setActiveTab('document')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'document'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <FileText className="h-4 w-4" />
            Upload Document
          </button>
          <button
            onClick={() => setActiveTab('image')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'image'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Image className="h-4 w-4" />
            Upload Photo
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'prompt' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Describe your form
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Example: Create a customer feedback form with ratings for service quality, product satisfaction, and a text area for additional comments. Include fields for name and email."
                  className="w-full h-40 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
                />
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-700 mb-2">Tips for better results</h4>
                <ul className="text-sm text-gray-600 space-y-1">
                  <li>• Be specific about field types (email, phone, dropdown, etc.)</li>
                  <li>• Mention which fields should be required</li>
                  <li>• Include any specific validation needs</li>
                  <li>• Describe the purpose of your form</li>
                </ul>
              </div>
            </div>
          )}

          {activeTab === 'document' && (
            <div className="space-y-4">
              <div
                onDrop={(e) => handleDrop(e, 'document')}
                onDragOver={(e) => e.preventDefault()}
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                  selectedFile ? 'border-primary-300 bg-primary-50' : 'border-gray-300 hover:border-gray-400'
                }`}
              >
                {selectedFile ? (
                  <div className="space-y-3">
                    {previewUrl ? (
                      <img src={previewUrl} alt="Preview" className="max-h-40 mx-auto rounded-lg" />
                    ) : (
                      <FileText className="h-12 w-12 mx-auto text-primary-500" />
                    )}
                    <p className="text-sm font-medium text-gray-900">{selectedFile.name}</p>
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
                    >
                      Remove
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Upload className="h-12 w-12 mx-auto text-gray-400" />
                    <div>
                      <p className="text-gray-600">Drag and drop a file here, or</p>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="text-primary-600 font-medium hover:text-primary-700"
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
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Additional instructions (optional)
                </label>
                <textarea
                  value={additionalPrompt}
                  onChange={(e) => setAdditionalPrompt(e.target.value)}
                  placeholder="Any specific instructions for how to interpret the document..."
                  className="w-full h-24 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
                />
              </div>
            </div>
          )}

          {activeTab === 'image' && (
            <div className="space-y-4">
              <div
                onDrop={(e) => handleDrop(e, 'image')}
                onDragOver={(e) => e.preventDefault()}
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                  selectedFile ? 'border-primary-300 bg-primary-50' : 'border-gray-300 hover:border-gray-400'
                }`}
              >
                {selectedFile && previewUrl ? (
                  <div className="space-y-3">
                    <img src={previewUrl} alt="Preview" className="max-h-48 mx-auto rounded-lg shadow-md" />
                    <p className="text-sm font-medium text-gray-900">{selectedFile.name}</p>
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
                      Remove
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Image className="h-12 w-12 mx-auto text-gray-400" />
                    <div>
                      <p className="text-gray-600">Take a photo of a paper form or</p>
                      <button
                        onClick={() => imageInputRef.current?.click()}
                        className="text-primary-600 font-medium hover:text-primary-700"
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
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Additional instructions (optional)
                </label>
                <textarea
                  value={additionalPrompt}
                  onChange={(e) => setAdditionalPrompt(e.target.value)}
                  placeholder="Any specific instructions for how to interpret the form image..."
                  className="w-full h-24 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
                />
              </div>

              <div className="bg-blue-50 rounded-lg p-4">
                <h4 className="text-sm font-medium text-blue-800 mb-2">Best practices for form photos</h4>
                <ul className="text-sm text-blue-700 space-y-1">
                  <li>• Ensure good lighting and clear focus</li>
                  <li>• Capture the entire form in frame</li>
                  <li>• Avoid glare and shadows</li>
                  <li>• Use a flat surface for best results</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 bg-gray-50">
          <Button variant="outline" onClick={resetAndClose}>
            Cancel
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={isGenerating || isAvailable === false}
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
