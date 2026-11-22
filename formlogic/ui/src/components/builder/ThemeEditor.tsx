import { useState, useRef, useEffect } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { X, RotateCcw, Upload, Image, Trash2, Check } from 'lucide-react';
import { Button } from '../ui/Button';
import { DIALOG_CLOSE, DIALOG_DESCRIPTION, DIALOG_FOOTER, DIALOG_HEADER, DIALOG_OVERLAY, DIALOG_PANEL, DIALOG_TITLE, GROUP_TITLE } from './builderDialog';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import { shrinkImageToDataUrl } from '../../lib/shrinkImage';
import {
  FORM_DENSITY_OPTIONS,
  FORM_FONT_OPTIONS,
  FORM_HEADER_OPTIONS,
  FORM_INPUT_OPTIONS,
  FORM_PATTERN_OPTIONS,
  FORM_STYLE_PRESETS,
  FORM_SURFACE_OPTIONS,
  getFormThemeTokens,
  resolveFormFontStack,
  type FormStylePreset,
} from '../../lib/formThemeStyles';
import type { FormTheme } from '../../types/form';

interface ThemeEditorProps {
  isOpen: boolean;
  onClose: () => void;
  theme: FormTheme;
  /** Optional live form title & section labels so the Theme Live Preview mirrors the designer's actual form. */
  formTitle?: string;
  sectionTitles?: string[];
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

const BORDER_RADIUS_OPTIONS = [
  { value: 'none', label: 'Sharp', class: 'rounded-none' },
  { value: 'small', label: 'Small', class: 'rounded-md' },
  { value: 'medium', label: 'Medium', class: 'rounded-lg' },
  { value: 'large', label: 'Large', class: 'rounded-xl' },
] as const;

function normalizeDraftTheme(theme: FormTheme): FormTheme {
  const font = !theme.fontFamily || theme.fontFamily === 'Inter' ? 'DM Sans' : theme.fontFamily;
  return {
    ...theme,
    fontFamily: font,
    borderRadius: theme.borderRadius || 'medium',
    surfaceStyle: theme.surfaceStyle || 'clean',
    inputStyle: theme.inputStyle || 'outlined',
    headerStyle: theme.headerStyle || 'minimal',
    density: theme.density || 'comfortable',
    backgroundPattern: theme.backgroundPattern || 'none',
  };
}

export function ThemeEditor({ isOpen, onClose, theme, formTitle, sectionTitles = [], onSave }: ThemeEditorProps) {
  const [editedTheme, setEditedTheme] = useState<FormTheme>(() => normalizeDraftTheme(theme));
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
      setEditedTheme(normalizeDraftTheme(theme));
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

  const applyPreset = (preset: FormStylePreset) => {
    setEditedTheme({
      ...preset.theme,
      logo: editedTheme.logo,
      backgroundImage: editedTheme.backgroundImage,
    });
    setActivePreset(preset.id);
  };

  const handleReset = () => {
    const defaultPreset = FORM_STYLE_PRESETS[0];
    setEditedTheme({
      ...defaultPreset.theme,
      logo: editedTheme.logo,
      backgroundImage: editedTheme.backgroundImage,
    });
    setActivePreset(defaultPreset.id);
  };

  const handleSave = async () => {
    // Validate color values before saving
    const colorKeys = ['primaryColor', 'backgroundColor', 'textColor', 'cardColor'] as const;
    for (const key of colorKeys) {
      const val = editedTheme[key];
      if (val && !isValidColor(val)) {
        toast.error('Invalid color', `${key} must be a valid hex color (e.g., #4f46e5)`);
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
    toast.success('Theme saved', 'Your form style changes have been applied');
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

  const tokens = getFormThemeTokens(editedTheme);
  const surfaceShowsCardColor = tokens.surfaceStyle !== 'clean';
  const safeColorPicker = (val: string | undefined, fallback: string) =>
    val && /^#[A-Fa-f0-9]{6}$/.test(val) ? val : fallback;

  return (
    <div className={DIALOG_OVERLAY}>
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="theme-editor-title" className={cn(DIALOG_PANEL, 'max-w-5xl')}>
        {/* Header */}
        <div className={DIALOG_HEADER}>
          <div className="min-w-0 flex-1 pr-2">
            <h2 id="theme-editor-title" className={DIALOG_TITLE}>Form style &amp; theme</h2>
            <p className={DIALOG_DESCRIPTION}>Pick a style preset or customize layout, inputs, headers, typography, colors, and branding.</p>
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

        {/* Two-column layout: scrollable controls on left, live sticky preview on right */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain lg:grid lg:grid-cols-[minmax(0,1fr)_25rem] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
          <div className="space-y-6 p-4 sm:p-6 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
            {/* Style Presets */}
            <div>
              <h3 className={cn(GROUP_TITLE, 'mb-3')}>Style presets</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {FORM_STYLE_PRESETS.map((preset) => {
                  const isSelected = activePreset === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      aria-pressed={isSelected}
                      className={cn(
                        'relative p-2 rounded-xl border text-left transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                        isSelected
                          ? 'border-primary-500 ring-1 ring-primary-500 bg-primary-50/50 dark:bg-primary-500/10'
                          : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
                      )}
                    >
                      <div
                        className="h-14 rounded-lg mb-2 p-1.5 relative overflow-hidden border border-black/10"
                        style={{ backgroundColor: preset.preview.canvas }}
                      >
                        <div
                          className={cn(
                            'h-full w-full overflow-hidden border',
                            preset.theme.borderRadius === 'none' ? 'rounded-none' : preset.theme.borderRadius === 'small' ? 'rounded-xs' : 'rounded-md',
                          )}
                          style={{
                            backgroundColor: preset.preview.surface,
                            borderColor: preset.preview.isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.12)',
                          }}
                        >
                          {preset.theme.headerStyle === 'hero' ? (
                            <div className="h-3.5 w-full" style={{ backgroundColor: preset.preview.primary }} />
                          ) : preset.theme.headerStyle === 'accent_bar' ? (
                            <div className="h-1.5 w-full" style={{ backgroundColor: preset.preview.primary }} />
                          ) : null}
                          <div className="p-1.5 space-y-1">
                            <div className="h-1.5 w-10 rounded-full opacity-75" style={{ backgroundColor: preset.preview.text }} />
                            <div
                              className={cn(
                                'h-2.5 w-full',
                                preset.theme.inputStyle === 'underline' ? 'border-b-2' : 'rounded-xs border',
                              )}
                              style={{
                                borderColor: preset.preview.primary,
                                backgroundColor: preset.theme.inputStyle === 'filled' ? preset.preview.accent : 'transparent',
                              }}
                            />
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate text-xs font-semibold text-gray-800 dark:text-slate-200">{preset.name}</span>
                        {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-primary-600 dark:text-primary-400" />}
                      </div>
                      <span className="block truncate text-[10px] text-gray-500 dark:text-slate-400 mt-0.5">
                        {preset.tagline}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Layout & Structure */}
            <div className="space-y-4">
              <h3 className={cn(GROUP_TITLE, 'mb-1')}>Layout &amp; structure</h3>

              {/* Surface Style */}
              <div>
                <p id="theme-surface" className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Page surface</p>
                <div role="group" aria-labelledby="theme-surface" className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {FORM_SURFACE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => updateTheme({ surfaceStyle: opt.value })}
                      aria-pressed={tokens.surfaceStyle === opt.value}
                      className={cn(
                        'p-2.5 rounded-xl border text-left transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                        tokens.surfaceStyle === opt.value
                          ? 'border-primary-500 ring-1 ring-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                          : 'border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:border-gray-300 dark:hover:border-slate-600'
                      )}
                    >
                      <span className="block text-xs font-semibold">{opt.label}</span>
                      <span className="block text-[11px] opacity-70">{opt.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Input Style */}
              <div>
                <p id="theme-inputs" className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Field inputs</p>
                <div role="group" aria-labelledby="theme-inputs" className="grid grid-cols-3 gap-2">
                  {FORM_INPUT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => updateTheme({ inputStyle: opt.value })}
                      aria-pressed={tokens.inputStyle === opt.value}
                      className={cn(
                        'p-2.5 rounded-xl border text-left transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                        tokens.inputStyle === opt.value
                          ? 'border-primary-500 ring-1 ring-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                          : 'border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:border-gray-300 dark:hover:border-slate-600'
                      )}
                    >
                      <span className="block text-xs font-semibold">{opt.label}</span>
                      <span className="block text-[11px] opacity-70">{opt.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Header Style + Density side-by-side */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p id="theme-header" className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Header banner</p>
                  <div role="group" aria-labelledby="theme-header" className="flex gap-1.5">
                    {FORM_HEADER_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => updateTheme({ headerStyle: opt.value })}
                        aria-pressed={tokens.headerStyle === opt.value}
                        className={cn(
                          'flex-1 py-2 px-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                          tokens.headerStyle === opt.value
                            ? 'border-primary-500 ring-1 ring-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                            : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p id="theme-density" className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Spacing density</p>
                  <div role="group" aria-labelledby="theme-density" className="flex gap-1.5">
                    {FORM_DENSITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => updateTheme({ density: opt.value })}
                        aria-pressed={tokens.density === opt.value}
                        className={cn(
                          'flex-1 py-2 px-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                          tokens.density === opt.value
                            ? 'border-primary-500 ring-1 ring-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                            : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Background Texture */}
              <div>
                <p id="theme-pattern" className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Background texture</p>
                <div role="group" aria-labelledby="theme-pattern" className="grid grid-cols-4 gap-2">
                  {FORM_PATTERN_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => updateTheme({ backgroundPattern: opt.value })}
                      aria-pressed={tokens.backgroundPattern === opt.value}
                      className={cn(
                        'py-2 px-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                        tokens.backgroundPattern === opt.value
                          ? 'border-primary-500 ring-1 ring-primary-500 bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                          : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Colors */}
            <div>
              <h3 className={cn(GROUP_TITLE, 'mb-3')}>Colors</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Primary Color */}
                <div>
                  <label className="block text-sm text-gray-600 dark:text-slate-400 mb-1.5">Primary accent</label>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <input
                        type="text"
                        value={editedTheme.primaryColor}
                        onChange={(e) => updateTheme({ primaryColor: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-gray-900 dark:text-white rounded-lg pl-10 focus:outline-none focus:ring-2 focus:ring-primary-500"
                        placeholder="#4f46e5"
                      />
                      <div
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded border border-gray-300 dark:border-slate-700"
                        style={{ backgroundColor: editedTheme.primaryColor }}
                      />
                    </div>
                    <input
                      type="color"
                      aria-label="Primary color picker"
                      value={safeColorPicker(editedTheme.primaryColor, '#4f46e5')}
                      onChange={(e) => updateTheme({ primaryColor: e.target.value })}
                      className="w-11 h-10 rounded-lg cursor-pointer border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 p-1"
                    />
                  </div>
                </div>

                {/* Page Background Color */}
                <div>
                  <label className="block text-sm text-gray-600 dark:text-slate-400 mb-1.5">Page background</label>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <input
                        type="text"
                        value={editedTheme.backgroundColor}
                        onChange={(e) => updateTheme({ backgroundColor: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-gray-900 dark:text-white rounded-lg pl-10 focus:outline-none focus:ring-2 focus:ring-primary-500"
                        placeholder="#ffffff"
                      />
                      <div
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded border border-gray-300 dark:border-slate-700"
                        style={{ backgroundColor: editedTheme.backgroundColor }}
                      />
                    </div>
                    <input
                      type="color"
                      aria-label="Background color picker"
                      value={safeColorPicker(editedTheme.backgroundColor, '#ffffff')}
                      onChange={(e) => updateTheme({ backgroundColor: e.target.value })}
                      className="w-11 h-10 rounded-lg cursor-pointer border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 p-1"
                    />
                  </div>
                </div>

                {/* Card / Sheet Color (when using Card, Paper, or Glass surface) */}
                {surfaceShowsCardColor && (
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-slate-400 mb-1.5">Card / sheet color</label>
                    <div className="flex gap-2">
                      <div className="flex-1 relative">
                        <input
                          type="text"
                          value={editedTheme.cardColor || tokens.surfaceBgColor}
                          onChange={(e) => updateTheme({ cardColor: e.target.value })}
                          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-gray-900 dark:text-white rounded-lg pl-10 focus:outline-none focus:ring-2 focus:ring-primary-500"
                          placeholder="#ffffff"
                        />
                        <div
                          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded border border-gray-300 dark:border-slate-700"
                          style={{ backgroundColor: editedTheme.cardColor || tokens.surfaceBgColor }}
                        />
                      </div>
                      <input
                        type="color"
                        aria-label="Card color picker"
                        value={safeColorPicker(editedTheme.cardColor || tokens.surfaceBgColor, '#ffffff')}
                        onChange={(e) => updateTheme({ cardColor: e.target.value })}
                        className="w-11 h-10 rounded-lg cursor-pointer border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 p-1"
                      />
                    </div>
                  </div>
                )}

                {/* Text Color */}
                <div>
                  <label className="block text-sm text-gray-600 dark:text-slate-400 mb-1.5">Text color</label>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <input
                        type="text"
                        value={editedTheme.textColor}
                        onChange={(e) => updateTheme({ textColor: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-gray-900 dark:text-white rounded-lg pl-10 focus:outline-none focus:ring-2 focus:ring-primary-500"
                        placeholder="#1f2937"
                      />
                      <div
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded border border-gray-300 dark:border-slate-700"
                        style={{ backgroundColor: editedTheme.textColor }}
                      />
                    </div>
                    <input
                      type="color"
                      aria-label="Text color picker"
                      value={safeColorPicker(editedTheme.textColor, '#1f2937')}
                      onChange={(e) => updateTheme({ textColor: e.target.value })}
                      className="w-11 h-10 rounded-lg cursor-pointer border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 p-1"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Typography & Corners */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <h3 className={cn(GROUP_TITLE, 'mb-2')}>Type</h3>
                <label htmlFor="theme-font" className="block text-sm text-gray-600 dark:text-slate-400 mb-1.5">Font family</label>
                <select
                  id="theme-font"
                  value={editedTheme.fontFamily}
                  onChange={(e) => updateTheme({ fontFamily: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-gray-900 dark:text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:min-h-11"
                  style={{ fontFamily: resolveFormFontStack(editedTheme.fontFamily) }}
                >
                  {FORM_FONT_OPTIONS.map((font) => (
                    <option key={font.value} value={font.value} style={{ fontFamily: resolveFormFontStack(font.value) }}>
                      {font.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <h3 className={cn(GROUP_TITLE, 'mb-2')}>Shape</h3>
                <p id="theme-corners" className="block text-sm text-gray-600 dark:text-slate-400 mb-1.5">Corners</p>
                <div role="group" aria-labelledby="theme-corners" className="flex gap-1.5">
                  {BORDER_RADIUS_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => updateTheme({ borderRadius: option.value })}
                      aria-pressed={editedTheme.borderRadius === option.value}
                      className={cn(
                        'flex-1 py-2 px-2 border transition-colors text-xs font-medium cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:min-h-11',
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

          {/* Live Preview */}
          <div className="border-t border-gray-200 bg-gray-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/40 sm:p-6 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0">
            <h3 className={cn(GROUP_TITLE, 'mb-3')}>Live preview</h3>
            <div
              className="fl-themed-form rounded-xl border border-gray-200 dark:border-slate-700 relative overflow-hidden p-4"
              style={tokens.pageStyle}
            >
              {tokens.hasBackgroundImage && (
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundColor: tokens.isPageDark ? 'rgba(15,23,42,0.45)' : 'rgba(255,255,255,0.45)',
                  }}
                />
              )}

              <div
                className={cn(
                  'relative overflow-hidden',
                  tokens.surfaceStyle === 'clean' && !tokens.hasBackgroundImage ? 'p-1' : tokens.sheetClass,
                  tokens.surfaceStyle !== 'clean' && 'p-0',
                )}
                style={tokens.surfaceStyle === 'clean' && !tokens.hasBackgroundImage ? { color: tokens.surfaceTextColor } : { ...tokens.sheetStyle, padding: 0 }}
              >
                {/* Header preview */}
                {tokens.headerStyle === 'accent_bar' && (
                  <div className="h-2 w-full" style={{ backgroundColor: editedTheme.primaryColor }} />
                )}
                <div
                  className={cn(
                    tokens.headerStyle === 'hero'
                      ? 'px-4 py-4'
                      : tokens.surfaceStyle === 'clean' && !tokens.hasBackgroundImage
                        ? 'pb-3'
                        : 'px-4 pt-4 pb-3 border-b',
                  )}
                  style={
                    tokens.headerStyle === 'hero'
                      ? { backgroundColor: editedTheme.primaryColor, color: tokens.onPrimaryColor }
                      : { borderColor: `${tokens.surfaceTextColor}14` }
                  }
                >
                  {editedTheme.logo && (
                    <img
                      src={editedTheme.logo}
                      alt="Logo preview"
                      className="h-7 mb-2 object-contain"
                    />
                  )}
                  <h4 className="text-base font-bold tracking-tight truncate">{formTitle?.trim() || 'Patient Intake'}</h4>
                  <p className="text-xs opacity-75 mt-0.5 truncate">
                    {sectionTitles.length > 0
                      ? `Section 1 of ${sectionTitles.length} · ${sectionTitles[0]}`
                      : 'Section 1 · Patient Identification'}
                  </p>
                </div>

                {/* Mini Section Outline strip when the form has sections */}
                {sectionTitles.length > 1 && (
                  <div
                    className={cn(
                      'flex flex-wrap gap-1 border-b px-4 py-2',
                      tokens.surfaceStyle === 'clean' && !tokens.hasBackgroundImage && 'px-0',
                    )}
                    style={{ borderColor: `${tokens.surfaceTextColor}14` }}
                  >
                    {sectionTitles.slice(0, 3).map((secTitle, idx) => (
                      <span
                        key={`${secTitle}-${idx}`}
                        className={cn('inline-flex items-center px-2 py-0.5 text-[10px] font-medium max-w-[115px] truncate', tokens.controlRadiusClass)}
                        style={
                          idx === 0
                            ? { backgroundColor: `${editedTheme.primaryColor}1c`, color: editedTheme.primaryColor }
                            : { backgroundColor: `${tokens.surfaceTextColor}0d`, color: tokens.surfaceTextColor, opacity: 0.72 }
                        }
                      >
                        {idx + 1}. {secTitle}
                      </span>
                    ))}
                    {sectionTitles.length > 3 && (
                      <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] opacity-60" style={{ color: tokens.surfaceTextColor }}>
                        +{sectionTitles.length - 3} more
                      </span>
                    )}
                  </div>
                )}

                {/* Body preview */}
                <div
                  className={cn(
                    tokens.surfaceStyle === 'clean' && !tokens.hasBackgroundImage ? 'pt-3' : 'p-4',
                    tokens.density === 'compact' ? 'space-y-3' : tokens.density === 'spacious' ? 'space-y-5' : 'space-y-4',
                  )}
                >
                  <div>
                    <p className="text-sm font-semibold mb-1.5" style={{ color: tokens.surfaceTextColor }}>
                      Full Legal Name <span className="text-red-500">*</span>
                    </p>
                    <input
                      type="text"
                      placeholder="Elena Rostova"
                      readOnly
                      tabIndex={-1}
                      className={cn(tokens.inputClass, 'text-sm! py-2!')}
                      style={{
                        ...tokens.inputStyleObj,
                        borderColor: tokens.inputStyle === 'filled' ? 'transparent' : editedTheme.primaryColor,
                      }}
                    />
                  </div>

                  <div>
                    <p className="text-sm font-semibold mb-1.5" style={{ color: tokens.surfaceTextColor }}>
                      Visit Type
                    </p>
                    <div className="space-y-1.5">
                      <div
                        className={cn('flex items-center gap-2 border-2 px-3 py-2 text-xs font-medium', tokens.controlRadiusClass)}
                        style={{
                          borderColor: editedTheme.primaryColor,
                          backgroundColor: `${editedTheme.primaryColor}14`,
                          color: tokens.surfaceTextColor,
                        }}
                      >
                        <span
                          className="h-4 w-4 rounded-full flex items-center justify-center text-[10px]"
                          style={{ backgroundColor: editedTheme.primaryColor, color: tokens.onPrimaryColor }}
                        >
                          ✓
                        </span>
                        Outpatient Consultation
                      </div>
                      <div
                        className={cn('flex items-center gap-2 border px-3 py-2 text-xs opacity-75', tokens.controlRadiusClass)}
                        style={{
                          borderColor: `${tokens.surfaceTextColor}25`,
                          color: tokens.surfaceTextColor,
                        }}
                      >
                        <span className="h-4 w-4 rounded-full border border-current/40" />
                        Scheduled Admission
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled
                    className={cn('w-full px-4 py-2 text-xs font-semibold', tokens.controlRadiusClass)}
                    style={{
                      backgroundColor: editedTheme.primaryColor,
                      color: tokens.onPrimaryColor,
                    }}
                  >
                    Continue to Section 2 →
                  </button>
                </div>
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
