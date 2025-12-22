import { useState, useRef } from 'react';
import { X, Palette, RotateCcw, Upload, Image, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import type { FormTheme } from '../../types/form';

interface ThemeEditorProps {
  isOpen: boolean;
  onClose: () => void;
  theme: FormTheme;
  onSave: (theme: FormTheme) => void;
}

interface ThemePreset {
  id: string;
  name: string;
  theme: FormTheme;
  preview: {
    primary: string;
    background: string;
    accent: string;
  };
}

const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'default',
    name: 'Default',
    theme: {
      primaryColor: '#6366f1',
      backgroundColor: '#ffffff',
      textColor: '#1f2937',
      fontFamily: 'Inter',
      borderRadius: 'medium',
    },
    preview: {
      primary: '#6366f1',
      background: '#ffffff',
      accent: '#e0e7ff',
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    theme: {
      primaryColor: '#8b5cf6',
      backgroundColor: '#1f2937',
      textColor: '#f9fafb',
      fontFamily: 'Inter',
      borderRadius: 'medium',
    },
    preview: {
      primary: '#8b5cf6',
      background: '#1f2937',
      accent: '#374151',
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    theme: {
      primaryColor: '#0ea5e9',
      backgroundColor: '#f0f9ff',
      textColor: '#0c4a6e',
      fontFamily: 'Inter',
      borderRadius: 'large',
    },
    preview: {
      primary: '#0ea5e9',
      background: '#f0f9ff',
      accent: '#bae6fd',
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    theme: {
      primaryColor: '#f97316',
      backgroundColor: '#fffbeb',
      textColor: '#78350f',
      fontFamily: 'Inter',
      borderRadius: 'medium',
    },
    preview: {
      primary: '#f97316',
      background: '#fffbeb',
      accent: '#fed7aa',
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    theme: {
      primaryColor: '#22c55e',
      backgroundColor: '#f0fdf4',
      textColor: '#14532d',
      fontFamily: 'Inter',
      borderRadius: 'medium',
    },
    preview: {
      primary: '#22c55e',
      background: '#f0fdf4',
      accent: '#bbf7d0',
    },
  },
  {
    id: 'rose',
    name: 'Rose',
    theme: {
      primaryColor: '#f43f5e',
      backgroundColor: '#fff1f2',
      textColor: '#881337',
      fontFamily: 'Inter',
      borderRadius: 'large',
    },
    preview: {
      primary: '#f43f5e',
      background: '#fff1f2',
      accent: '#fecdd3',
    },
  },
];

const FONT_OPTIONS = [
  { value: 'Inter', label: 'Inter' },
  { value: 'Roboto', label: 'Roboto' },
  { value: 'Open Sans', label: 'Open Sans' },
  { value: 'Lato', label: 'Lato' },
  { value: 'Montserrat', label: 'Montserrat' },
  { value: 'Poppins', label: 'Poppins' },
  { value: 'Playfair Display', label: 'Playfair Display' },
  { value: 'Source Sans Pro', label: 'Source Sans Pro' },
  { value: 'system-ui', label: 'System Default' },
];

const BORDER_RADIUS_OPTIONS = [
  { value: 'none', label: 'None', class: 'rounded-none' },
  { value: 'small', label: 'Small', class: 'rounded' },
  { value: 'medium', label: 'Medium', class: 'rounded-lg' },
  { value: 'large', label: 'Large', class: 'rounded-xl' },
] as const;

export function ThemeEditor({ isOpen, onClose, theme, onSave }: ThemeEditorProps) {
  const [editedTheme, setEditedTheme] = useState<FormTheme>(theme);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const updateTheme = (updates: Partial<FormTheme>) => {
    setEditedTheme((prev) => ({ ...prev, ...updates }));
    setActivePreset(null); // Clear active preset when manually changing
  };

  const applyPreset = (preset: ThemePreset) => {
    setEditedTheme({ ...preset.theme, logo: editedTheme.logo, backgroundImage: editedTheme.backgroundImage });
    setActivePreset(preset.id);
  };

  const handleReset = () => {
    const defaultPreset = THEME_PRESETS.find((p) => p.id === 'default');
    if (defaultPreset) {
      setEditedTheme({ ...defaultPreset.theme });
      setActivePreset('default');
    }
  };

  const handleSave = () => {
    onSave(editedTheme);
    toast.success('Theme saved', 'Your theme changes have been applied');
    onClose();
  };

  const handleImageUpload = (
    e: React.ChangeEvent<HTMLInputElement>,
    type: 'logo' | 'backgroundImage'
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast.error('Invalid file', 'Please select an image file');
      return;
    }

    // Validate file size (max 2MB)
    if (file.size > 2 * 1024 * 1024) {
      toast.error('File too large', 'Image must be less than 2MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      updateTheme({ [type]: dataUrl });
    };
    reader.readAsDataURL(file);
  };

  const removeImage = (type: 'logo' | 'backgroundImage') => {
    updateTheme({ [type]: undefined });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <Palette className="h-5 w-5 text-primary-600" />
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Theme Customization</h2>
              <p className="text-sm text-gray-500">Customize your form's appearance</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Presets */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">Presets</h3>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
              {THEME_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => applyPreset(preset)}
                  className={cn(
                    'relative p-2 rounded-lg border-2 transition-all',
                    activePreset === preset.id
                      ? 'border-primary-500 ring-2 ring-primary-200'
                      : 'border-gray-200 hover:border-gray-300'
                  )}
                >
                  <div
                    className="h-12 rounded-md mb-2 relative overflow-hidden"
                    style={{ backgroundColor: preset.preview.background }}
                  >
                    <div
                      className="absolute bottom-0 left-0 right-0 h-4"
                      style={{ backgroundColor: preset.preview.accent }}
                    />
                    <div
                      className="absolute top-2 left-2 w-4 h-4 rounded-full"
                      style={{ backgroundColor: preset.preview.primary }}
                    />
                  </div>
                  <span className="text-xs font-medium text-gray-700">{preset.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Colors */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">Colors</h3>
            <div className="space-y-4">
              {/* Primary Color */}
              <div>
                <label className="block text-sm text-gray-600 mb-2">Primary Color</label>
                <div className="flex gap-3">
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={editedTheme.primaryColor}
                      onChange={(e) => updateTheme({ primaryColor: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg pl-12 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="#6366f1"
                    />
                    <div
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded border border-gray-300"
                      style={{ backgroundColor: editedTheme.primaryColor }}
                    />
                  </div>
                  <input
                    type="color"
                    value={editedTheme.primaryColor}
                    onChange={(e) => updateTheme({ primaryColor: e.target.value })}
                    className="w-12 h-10 rounded-lg cursor-pointer border border-gray-300"
                  />
                </div>
              </div>

              {/* Background Color */}
              <div>
                <label className="block text-sm text-gray-600 mb-2">Background Color</label>
                <div className="flex gap-3">
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={editedTheme.backgroundColor}
                      onChange={(e) => updateTheme({ backgroundColor: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg pl-12 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="#ffffff"
                    />
                    <div
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded border border-gray-300"
                      style={{ backgroundColor: editedTheme.backgroundColor }}
                    />
                  </div>
                  <input
                    type="color"
                    value={editedTheme.backgroundColor}
                    onChange={(e) => updateTheme({ backgroundColor: e.target.value })}
                    className="w-12 h-10 rounded-lg cursor-pointer border border-gray-300"
                  />
                </div>
              </div>

              {/* Text Color */}
              <div>
                <label className="block text-sm text-gray-600 mb-2">Text Color</label>
                <div className="flex gap-3">
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={editedTheme.textColor}
                      onChange={(e) => updateTheme({ textColor: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg pl-12 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="#1f2937"
                    />
                    <div
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded border border-gray-300"
                      style={{ backgroundColor: editedTheme.textColor }}
                    />
                  </div>
                  <input
                    type="color"
                    value={editedTheme.textColor}
                    onChange={(e) => updateTheme({ textColor: e.target.value })}
                    className="w-12 h-10 rounded-lg cursor-pointer border border-gray-300"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Typography */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">Typography</h3>
            <div>
              <label className="block text-sm text-gray-600 mb-2">Font Family</label>
              <select
                value={editedTheme.fontFamily}
                onChange={(e) => updateTheme({ fontFamily: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                style={{ fontFamily: editedTheme.fontFamily }}
              >
                {FONT_OPTIONS.map((font) => (
                  <option key={font.value} value={font.value} style={{ fontFamily: font.value }}>
                    {font.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Appearance */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">Appearance</h3>
            <div>
              <label className="block text-sm text-gray-600 mb-2">Border Radius</label>
              <div className="flex gap-3">
                {BORDER_RADIUS_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => updateTheme({ borderRadius: option.value })}
                    className={cn(
                      'flex-1 py-2 px-3 border-2 transition-all text-sm',
                      option.class,
                      editedTheme.borderRadius === option.value
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-200 hover:border-gray-300'
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Background Image */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">Background Image</h3>
            {editedTheme.backgroundImage ? (
              <div className="relative rounded-lg overflow-hidden border border-gray-200">
                <img
                  src={editedTheme.backgroundImage}
                  alt="Background"
                  className="w-full h-32 object-cover"
                />
                <button
                  onClick={() => removeImage('backgroundImage')}
                  className="absolute top-2 right-2 p-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => bgInputRef.current?.click()}
                className="w-full p-6 border-2 border-dashed border-gray-300 rounded-lg hover:border-gray-400 transition-colors flex flex-col items-center gap-2"
              >
                <Image className="h-8 w-8 text-gray-400" />
                <span className="text-sm text-gray-500">Upload Background Image</span>
                <span className="text-xs text-gray-400">PNG, JPG up to 2MB</span>
              </button>
            )}
            <input
              ref={bgInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => handleImageUpload(e, 'backgroundImage')}
              className="hidden"
            />
          </div>

          {/* Logo */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">Logo</h3>
            {editedTheme.logo ? (
              <div className="relative inline-block">
                <div className="p-4 bg-gray-100 rounded-lg border border-gray-200">
                  <img
                    src={editedTheme.logo}
                    alt="Logo"
                    className="h-16 max-w-[200px] object-contain"
                  />
                </div>
                <button
                  onClick={() => removeImage('logo')}
                  className="absolute -top-2 -right-2 p-1.5 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => logoInputRef.current?.click()}
                className="p-4 border-2 border-dashed border-gray-300 rounded-lg hover:border-gray-400 transition-colors flex items-center gap-3"
              >
                <Upload className="h-6 w-6 text-gray-400" />
                <div className="text-left">
                  <span className="text-sm text-gray-600 block">Upload Logo</span>
                  <span className="text-xs text-gray-400">PNG, JPG up to 2MB</span>
                </div>
              </button>
            )}
            <input
              ref={logoInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => handleImageUpload(e, 'logo')}
              className="hidden"
            />
          </div>

          {/* Preview */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 mb-3">Preview</h3>
            <div
              className="p-6 rounded-lg border border-gray-200 relative overflow-hidden"
              style={{
                backgroundColor: editedTheme.backgroundColor,
                fontFamily: editedTheme.fontFamily,
                backgroundImage: editedTheme.backgroundImage
                  ? `url(${editedTheme.backgroundImage})`
                  : undefined,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            >
              {editedTheme.backgroundImage && (
                <div
                  className="absolute inset-0 bg-black/20"
                  style={{ backgroundColor: `${editedTheme.backgroundColor}cc` }}
                />
              )}
              <div className="relative">
                {editedTheme.logo && (
                  <img
                    src={editedTheme.logo}
                    alt="Logo preview"
                    className="h-8 mb-4 object-contain"
                  />
                )}
                <h4
                  className="text-lg font-semibold mb-2"
                  style={{ color: editedTheme.textColor }}
                >
                  Sample Question
                </h4>
                <p className="text-sm mb-4" style={{ color: editedTheme.textColor, opacity: 0.7 }}>
                  What is your email address?
                </p>
                <input
                  type="text"
                  placeholder="your@email.com"
                  disabled
                  className={cn(
                    'w-full px-4 py-2 border-2 mb-4',
                    editedTheme.borderRadius === 'none' && 'rounded-none',
                    editedTheme.borderRadius === 'small' && 'rounded',
                    editedTheme.borderRadius === 'medium' && 'rounded-lg',
                    editedTheme.borderRadius === 'large' && 'rounded-xl'
                  )}
                  style={{
                    borderColor: editedTheme.primaryColor,
                    backgroundColor: editedTheme.backgroundColor,
                    color: editedTheme.textColor,
                  }}
                />
                <button
                  disabled
                  className={cn(
                    'px-6 py-2 text-white font-medium',
                    editedTheme.borderRadius === 'none' && 'rounded-none',
                    editedTheme.borderRadius === 'small' && 'rounded',
                    editedTheme.borderRadius === 'medium' && 'rounded-lg',
                    editedTheme.borderRadius === 'large' && 'rounded-xl'
                  )}
                  style={{ backgroundColor: editedTheme.primaryColor }}
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-between">
          <Button variant="ghost" onClick={handleReset}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave}>
              Apply Theme
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
