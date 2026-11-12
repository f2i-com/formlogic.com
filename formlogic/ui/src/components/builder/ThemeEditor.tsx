import { useState, useRef, useEffect } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { X, RotateCcw, Upload, Image, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { DIALOG_CLOSE, DIALOG_DESCRIPTION, DIALOG_FOOTER, DIALOG_HEADER, DIALOG_OVERLAY, DIALOG_PANEL, DIALOG_TITLE, GROUP_TITLE } from './builderDialog';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import { readableForegroundColor } from '../../lib/color';
import { shrinkImageToDataUrl } from '../../lib/shrinkImage';
import type { FormTheme } from '../../types/form';

interface ThemeEditorProps {
  isOpen: boolean;
  onClose: () => void;
  theme: FormTheme;
  /** Resolves false when the theme did not reach the server (the store says why). */
  onSave: (theme: FormTheme) => Promise<boolean>;
}

type ThemeImage = 'logo' | 'backgroundImage';

// Each image travels inside the theme as a data URL, and the theme goes out with every list of
// forms and every app's load, so these are kept small. The server takes 256KB of theme
// (FormService::MAX_THEME_BYTES): both images together leave well over 30KB of that for the rest.
// It counts a little more than JSON.stringify does: PHP writes every / in the base64 as \/.
const THEME_IMAGE_LIMITS: Record<ThemeImage, { maxPx: number; maxChars: number }> = {
  logo: { maxPx: 512, maxChars: 64 * 1024 },
  backgroundImage: { maxPx: 1280, maxChars: 150 * 1024 },
};
const THEME_MAX_CHARS = 250 * 1024;

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
      primaryColor: '#4f46e5',
      backgroundColor: '#ffffff',
      textColor: '#1f2937',
      fontFamily: 'DM Sans',
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
      primaryColor: '#7c3aed',
      backgroundColor: '#1f2937',
      textColor: '#f9fafb',
      fontFamily: 'DM Sans',
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
      fontFamily: 'DM Sans',
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
      fontFamily: 'DM Sans',
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
      fontFamily: 'DM Sans',
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
      fontFamily: 'DM Sans',
      borderRadius: 'large',
    },
    preview: {
      primary: '#f43f5e',
      background: '#fff1f2',
      accent: '#fecdd3',
    },
  },
];

// Only fonts that are actually loaded (DM Sans / Plus Jakarta Sans via
// index.html) or universally web-safe — anything else silently falls back.
const FONT_OPTIONS = [
  { value: 'DM Sans', label: 'DM Sans' },
  { value: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans' },
  { value: 'system-ui', label: 'System default' },
  { value: 'Georgia', label: 'Georgia (serif)' },
  { value: 'monospace', label: 'Monospace' },
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
  // Why the last picked image was not taken, shown beside its upload control.
  const [imageErrors, setImageErrors] = useState<Partial<Record<ThemeImage, string>>>({});
  const [imagesShrinking, setImagesShrinking] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);

  // Re-seed from props on open (the modal stays mounted) so it never edits/saves
  // stale theme data after the form's theme changed underneath it.
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- prop->draft re-sync: reset edited theme when modal opens or theme prop changes underneath
      setEditedTheme(theme);
      setActivePreset(null);
      setImageErrors({});
      setSaveError(null);
    }
  }, [isOpen, theme]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isOpen);

  if (!isOpen) return null;

  const isValidColor = (color: string) => /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color);

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
      setEditedTheme({ ...defaultPreset.theme, logo: editedTheme.logo, backgroundImage: editedTheme.backgroundImage });
      setActivePreset('default');
    }
  };

  const handleSave = async () => {
    // Validate color values before saving
    const colorKeys = ['primaryColor', 'backgroundColor', 'textColor'] as const;
    for (const key of colorKeys) {
      if (editedTheme[key] && !isValidColor(editedTheme[key])) {
        toast.error('Invalid color', `${key} must be a valid hex color (e.g., #6366f1)`);
        return;
      }
    }

    // The theme goes out in the same save as the title, status, settings and script, so one
    // the server refuses would hold all of those back as well. Refused here, nothing is lost.
    if (JSON.stringify(editedTheme).length > THEME_MAX_CHARS) {
      setSaveError('This theme is too large to save. Remove the logo or the background image and upload it again.');
      return;
    }

    setSaveError(null);
    setSaving(true);
    const saved = await onSave(editedTheme);
    setSaving(false);
    if (!saved) {
      setSaveError('The theme was not saved. Try again, or check your connection.');
      return;
    }
    toast.success('Theme saved', 'Your theme changes have been applied');
    onClose();
  };

  const setImageError = (type: ThemeImage, message: string | null) => {
    setImageErrors((current) => ({ ...current, [type]: message ?? undefined }));
  };

  const handleImageUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    type: ThemeImage
  ) => {
    const file = e.target.files?.[0];
    // Cleared at once, or picking the same file after removing it fires no change event.
    e.target.value = '';
    if (!file) return;
    setImageError(type, null);

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setImageError(type, 'That file is not an image. Choose a PNG or JPG.');
      return;
    }

    // What is stored is the shrunk copy, so this only has to spare the browser from decoding
    // something huge. A phone photo is several MB, and a fine background once shrunk.
    if (file.size > 20 * 1024 * 1024) {
      setImageError(type, 'That image is over 20MB. Choose a smaller one.');
      return;
    }

    setImagesShrinking((n) => n + 1);
    const shrunk = await shrinkImageToDataUrl(file, THEME_IMAGE_LIMITS[type]);
    setImagesShrinking((n) => n - 1);
    if (shrunk.ok) {
      updateTheme({ [type]: shrunk.dataUrl });
      if (shrunk.firstFrameOnly) toast.warning('This GIF will not move', 'A theme image is a still picture, so only its first frame is kept.');
    } else {
      setImageError(type, shrunk.reason === 'unreadable'
        ? 'That image could not be read. Try a PNG or JPG.'
        : 'That image is too detailed to fit, even made smaller. Try a simpler image.');
    }
  };

  const removeImage = (type: ThemeImage) => {
    updateTheme({ [type]: undefined });
  };

  const imageError = (type: ThemeImage) => imageErrors[type] && (
    <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{imageErrors[type]}</p>
  );

  return (
    <div className={DIALOG_OVERLAY}>
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="theme-editor-title" className={cn(DIALOG_PANEL, 'max-w-5xl')}>
        {/* Header */}
        <div className={DIALOG_HEADER}>
          <div className="min-w-0 flex-1 pr-2">
            <h2 id="theme-editor-title" className={DIALOG_TITLE}>Theme</h2>
            <p className={DIALOG_DESCRIPTION}>The colors, type and pictures of the form people fill in.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={DIALOG_CLOSE}
            aria-label="Close"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content. With room, the settings scroll at the left and the preview stays in sight at
            the right: at one column the preview was under everything, and a color was changed
            without seeing what it did. On a narrow screen it follows the settings as before. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
         <div className="space-y-6 p-4 sm:p-6 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
          {/* Presets */}
          <div>
            <h3 className={cn(GROUP_TITLE, 'mb-3')}>Presets</h3>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 sm:gap-3">
              {THEME_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  aria-pressed={activePreset === preset.id}
                  className={cn(
                    'relative p-2 rounded-xl border transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                    activePreset === preset.id
                      ? 'border-primary-500 ring-1 ring-primary-500'
                      : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
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
                  <span className="text-xs font-medium text-gray-700 dark:text-slate-300">{preset.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Colors */}
          <div>
            <h3 className={cn(GROUP_TITLE, 'mb-3')}>Colors</h3>
            <div className="space-y-4">
              {/* Primary Color */}
              <div>
                <label className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Primary color</label>
                <div className="flex gap-3">
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={editedTheme.primaryColor}
                      onChange={(e) => updateTheme({ primaryColor: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-gray-900 dark:text-white rounded-lg pl-12 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="#6366f1"
                    />
                    <div
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded border border-gray-300 dark:border-slate-700"
                      style={{ backgroundColor: editedTheme.primaryColor }}
                    />
                  </div>
                  <input
                    type="color"
                    aria-label="Primary color picker"
                    value={editedTheme.primaryColor}
                    onChange={(e) => updateTheme({ primaryColor: e.target.value })}
                    className="w-12 h-10 rounded-lg cursor-pointer border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 p-1"
                  />
                </div>
              </div>

              {/* Background Color */}
              <div>
                <label className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Background color</label>
                <div className="flex gap-3">
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={editedTheme.backgroundColor}
                      onChange={(e) => updateTheme({ backgroundColor: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-gray-900 dark:text-white rounded-lg pl-12 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="#ffffff"
                    />
                    <div
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded border border-gray-300 dark:border-slate-700"
                      style={{ backgroundColor: editedTheme.backgroundColor }}
                    />
                  </div>
                  <input
                    type="color"
                    aria-label="Background color picker"
                    value={editedTheme.backgroundColor}
                    onChange={(e) => updateTheme({ backgroundColor: e.target.value })}
                    className="w-12 h-10 rounded-lg cursor-pointer border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 p-1"
                  />
                </div>
              </div>

              {/* Text Color */}
              <div>
                <label className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Text color</label>
                <div className="flex gap-3">
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={editedTheme.textColor}
                      onChange={(e) => updateTheme({ textColor: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-gray-900 dark:text-white rounded-lg pl-12 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="#1f2937"
                    />
                    <div
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded border border-gray-300 dark:border-slate-700"
                      style={{ backgroundColor: editedTheme.textColor }}
                    />
                  </div>
                  <input
                    type="color"
                    aria-label="Text color picker"
                    value={editedTheme.textColor}
                    onChange={(e) => updateTheme({ textColor: e.target.value })}
                    className="w-12 h-10 rounded-lg cursor-pointer border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 p-1"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Typography */}
          <div>
            <h3 className={cn(GROUP_TITLE, 'mb-3')}>Type</h3>
            <div>
              <label htmlFor="theme-font" className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Font</label>
              <select
                id="theme-font"
                value={editedTheme.fontFamily}
                onChange={(e) => updateTheme({ fontFamily: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-gray-900 dark:text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:min-h-11"
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
            <h3 className={cn(GROUP_TITLE, 'mb-3')}>Shape</h3>
            <div>
              <p id="theme-corners" className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Corners</p>
              <div role="group" aria-labelledby="theme-corners" className="flex gap-2 sm:gap-3">
                {BORDER_RADIUS_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => updateTheme({ borderRadius: option.value })}
                    aria-pressed={editedTheme.borderRadius === option.value}
                    className={cn(
                      'flex-1 py-2 px-2 border transition-colors text-sm cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:min-h-11',
                      option.class,
                      editedTheme.borderRadius === option.value
                        ? 'border-primary-500 ring-1 ring-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-400'
                        : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'
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
            <h3 className={cn(GROUP_TITLE, 'mb-3')}>Background image</h3>
            {editedTheme.backgroundImage ? (
              <div className="relative rounded-xl overflow-hidden border border-gray-200 dark:border-slate-700">
                <img
                  src={editedTheme.backgroundImage}
                  alt="Background"
                  className="w-full h-32 object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage('backgroundImage')}
                  className="absolute top-2 right-2 inline-flex items-center justify-center p-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 max-sm:min-h-11 max-sm:min-w-11"
                  aria-label="Remove background image"
                  title="Remove background image"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => bgInputRef.current?.click()}
                className="w-full px-4 py-3 border border-dashed border-gray-300 dark:border-slate-700 rounded-xl hover:border-gray-400 dark:hover:border-slate-600 transition-colors flex items-center gap-3 text-left group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <Image className="h-6 w-6 flex-none text-gray-400 dark:text-slate-500 group-hover:text-gray-500 dark:group-hover:text-slate-400" />
                <span className="min-w-0">
                  <span className="block text-sm text-gray-600 dark:text-slate-300">Upload a background image</span>
                  <span className="block text-xs text-gray-500 dark:text-slate-400">PNG, JPG up to 20MB, made smaller to fit</span>
                </span>
              </button>
            )}
            <input
              ref={bgInputRef}
              type="file"
              accept="image/*"
              aria-label="Background image file"
              onChange={(e) => void handleImageUpload(e, 'backgroundImage')}
              className="hidden"
            />
            {imageError('backgroundImage')}
          </div>

          {/* Logo */}
          <div>
            <h3 className={cn(GROUP_TITLE, 'mb-3')}>Logo</h3>
            {editedTheme.logo ? (
              <div className="relative inline-block">
                <div className="p-4 bg-gray-100 dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700">
                  <img
                    src={editedTheme.logo}
                    alt="Logo"
                    className="h-16 max-w-[200px] object-contain"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeImage('logo')}
                  className="absolute -top-2 -right-2 inline-flex items-center justify-center p-1.5 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 max-sm:-right-3 max-sm:-top-3 max-sm:min-h-11 max-sm:min-w-11"
                  aria-label="Remove logo"
                  title="Remove logo"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => logoInputRef.current?.click()}
                className="w-full px-4 py-3 border border-dashed border-gray-300 dark:border-slate-700 rounded-xl hover:border-gray-400 dark:hover:border-slate-600 transition-colors flex items-center gap-3 text-left group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <Upload className="h-6 w-6 flex-none text-gray-400 dark:text-slate-500 group-hover:text-gray-500 dark:group-hover:text-slate-400" />
                <span className="min-w-0">
                  <span className="block text-sm text-gray-600 dark:text-slate-300">Upload a logo</span>
                  <span className="block text-xs text-gray-500 dark:text-slate-400">PNG, JPG up to 20MB, made smaller to fit</span>
                </span>
              </button>
            )}
            <input
              ref={logoInputRef}
              type="file"
              accept="image/*"
              aria-label="Logo file"
              onChange={(e) => void handleImageUpload(e, 'logo')}
              className="hidden"
            />
            {imageError('logo')}
          </div>
         </div>

          {/* Preview */}
          <div className="border-t border-gray-200 bg-gray-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/40 sm:p-6 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0">
            <h3 className={cn(GROUP_TITLE, 'mb-3')}>Preview</h3>
            <div
              className="p-6 rounded-xl border border-gray-200 dark:border-slate-700 relative overflow-hidden"
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
                  style={{ backgroundColor: `color-mix(in srgb, ${editedTheme.backgroundColor} 80%, transparent)` }}
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
                  Sample question
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
                    'px-6 py-2 font-medium',
                    editedTheme.borderRadius === 'none' && 'rounded-none',
                    editedTheme.borderRadius === 'small' && 'rounded',
                    editedTheme.borderRadius === 'medium' && 'rounded-lg',
                    editedTheme.borderRadius === 'large' && 'rounded-xl'
                  )}
                  style={{ backgroundColor: editedTheme.primaryColor, color: readableForegroundColor(editedTheme.primaryColor) }}
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        {saveError && (
          <p role="alert" className="px-4 pt-3 text-sm text-red-600 dark:text-red-400 border-t border-gray-200 dark:border-slate-800 sm:px-6">{saveError}</p>
        )}
        <div className={cn(DIALOG_FOOTER, 'flex justify-between gap-2', saveError && 'border-t-0')}>
          <Button variant="ghost" onClick={handleReset} className="max-sm:min-h-11">
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="max-sm:min-h-11">
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} isLoading={saving} disabled={saving || imagesShrinking > 0} className="max-sm:min-h-11">
              Apply theme
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
