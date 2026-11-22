import { useState } from 'react';
import { Bot, Compass, ExternalLink, RotateCcw, Sliders, Sparkles, Volume2, VolumeX } from 'lucide-react';
import {
  BOT_GUIDE_PERSONAS,
  BOT_GUIDE_PRESETS,
  DEFAULT_BOT_SCRIPT_URL,
  DEFAULT_BOT_WASM_URL,
  useBotGuideStore,
  type BotGuideFraming,
  type BotGuidePersonaId,
  type BotGuidePosition,
  type BotGuideRenderMode,
  type BotGuideSize,
} from '../../stores/botGuideStore';
import { Switch } from '../ui/Switch';
import { Button } from '../ui/Button';
import { Dropdown } from '../ui/Dropdown';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';

const HELP = 'text-xs leading-5 text-gray-500 dark:text-slate-400';
const FIELD =
  'block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-slate-700 dark:bg-slate-900/60 dark:text-white dark:placeholder:text-slate-500';

/**
 * Workspace settings panel for the optional `bot.computer` interactive guide.
 * Everything persists locally in `useBotGuideStore`; nothing loads until enabled.
 */
export function BotGuideSettingsPanel() {
  const {
    enabled,
    preset,
    persona,
    renderMode,
    framing,
    speechEnabled,
    position,
    customPosition,
    size,
    allowVisitorCustomization,
    scriptUrl,
    wasmUrl,
    customAiml,
    status,
    lastError,
    setEnabled,
    setPreset,
    setPersona,
    setRenderMode,
    setFraming,
    setSpeechEnabled,
    setPosition,
    setCustomPosition,
    setSize,
    setAllowVisitorCustomization,
    setScriptUrl,
    setWasmUrl,
    setCustomAiml,
    requestAsk,
    requestCustomize,
    resetDefaults,
  } = useBotGuideStore();

  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white">
            Enable interactive guide
          </p>
          <p className={HELP}>
            Adds an optional speaking 2D/3D companion powered by{' '}
            <a
              href="https://bot.computer"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 font-medium text-primary-700 underline-offset-2 hover:underline dark:text-primary-300"
            >
              bot.computer
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>{' '}
            that walks through FormLogic pages and answers questions locally in your browser. Zero assets load while off.
          </p>
        </div>
        <Switch
          checked={enabled}
          onChange={(checked) => {
            setEnabled(checked);
            toast.success(
              checked ? 'Interactive guide enabled' : 'Interactive guide hidden',
              checked ? 'Your bot.computer companion is loading.' : 'The companion has been dismissed.',
            );
          }}
          ariaLabel="Enable bot.computer interactive guide"
        />
      </div>

      {lastError && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {lastError}
        </p>
      )}

      {enabled && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary-200/70 bg-primary-50/60 p-3 dark:border-primary-500/25 dark:bg-primary-500/10">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-800 dark:text-primary-200">
            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
            {status === 'loading' ? 'Loading companion…' : 'Companion active'}
          </span>
          <div className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => requestAsk('Take me on a tour')}
            leftIcon={<Compass className="h-3.5 w-3.5" />}
          >
            Start page tour
          </Button>
          {allowVisitorCustomization && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => requestCustomize()}
              leftIcon={<Sparkles className="h-3.5 w-3.5" />}
            >
              Customize look
            </Button>
          )}
        </div>
      )}

      {/* Character preset */}
      <div>
        <p className="mb-1.5 text-sm font-medium text-gray-700 dark:text-slate-300">Character</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Guide character">
          {BOT_GUIDE_PRESETS.map((item) => {
            const active = preset === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setPreset(item.id)}
                className={cn(
                  'cursor-pointer rounded-xl border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                  active
                    ? 'border-primary-500 bg-primary-50/70 dark:border-primary-500/60 dark:bg-primary-500/15'
                    : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-900/40 dark:hover:border-slate-600 dark:hover:bg-slate-800/60',
                )}
              >
                <span className={cn('block text-sm font-semibold', active ? 'text-primary-800 dark:text-primary-200' : 'text-gray-900 dark:text-white')}>
                  {item.name}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-gray-500 dark:text-slate-400">
                  {item.role}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Avatar style + Framing */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-sm font-medium text-gray-700 dark:text-slate-300">Avatar style</p>
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Avatar style">
            {([
              ['3d', '3D Avatar'],
              ['2d', '2D Style'],
            ] as readonly [BotGuideRenderMode, string][]).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={renderMode === mode}
                onClick={() => setRenderMode(mode)}
                className={cn(
                  'h-10 cursor-pointer whitespace-nowrap rounded-lg border px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                  renderMode === mode
                    ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-500/60 dark:bg-primary-500/15 dark:text-primary-300'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium text-gray-700 dark:text-slate-300">Framing</p>
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Avatar framing">
            {([
              ['full', 'Full body'],
              ['half', 'Upper body'],
            ] as readonly [BotGuideFraming, string][]).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={framing === mode}
                onClick={() => setFraming(mode)}
                className={cn(
                  'h-10 cursor-pointer whitespace-nowrap rounded-lg border px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                  framing === mode
                    ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-500/60 dark:bg-primary-500/15 dark:text-primary-300'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Personality + Default corner + Widget size (portaled Dropdown avoids multi-column native select glitches) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Dropdown
          label="Personality"
          value={persona}
          onChange={(v) => setPersona(v as BotGuidePersonaId)}
          options={BOT_GUIDE_PERSONAS.map((p) => ({ value: p.id, label: p.label }))}
        />
        <Dropdown
          label="Default corner"
          value={position}
          onChange={(v) => setPosition(v as BotGuidePosition)}
          options={[
            { value: 'auto', label: 'Auto (avoids chat)' },
            { value: 'bottom-left', label: 'Bottom left' },
            { value: 'bottom-right', label: 'Bottom right' },
          ]}
        />
      </div>

      <div>
        <p className="mb-1.5 text-sm font-medium text-gray-700 dark:text-slate-300">Widget size</p>
        <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Widget size">
          {([
            ['compact', 'Compact'],
            ['standard', 'Standard'],
          ] as readonly [BotGuideSize, string][]).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={size === mode}
              onClick={() => setSize(mode)}
              className={cn(
                'h-10 cursor-pointer whitespace-nowrap rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                size === mode
                  ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-500/60 dark:bg-primary-500/15 dark:text-primary-300'
                  : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className={HELP}>
        Drag the avatar anywhere on screen to move it out of your way, or click its × button to hide it anytime.
        {customPosition && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => setCustomPosition(null)}
              className="cursor-pointer font-medium text-primary-700 underline-offset-2 hover:underline dark:text-primary-300"
            >
              Reset screen position
            </button>
          </>
        )}
      </p>

      {/* Voice + Customizer toggles */}
      <div className="divide-y divide-gray-100 rounded-xl border border-gray-200/80 px-3 dark:divide-white/[0.06] dark:border-slate-700/70">
        <div className="flex items-center justify-between gap-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {speechEnabled ? (
              <Volume2 className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
            ) : (
              <VolumeX className="h-4 w-4 shrink-0 text-gray-400 dark:text-slate-500" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white">Spoken voice (local WASM)</p>
              <p className={HELP}>200 Hz lip-synced speech via tts.wasm; turn off for silent captions only.</p>
            </div>
          </div>
          <Switch
            checked={speechEnabled}
            onChange={setSpeechEnabled}
            ariaLabel="Enable spoken voice for interactive guide"
          />
        </div>
        <div className="flex items-center justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-white">Allow avatar customizer</p>
            <p className={HELP}>Let visitors customize hair, outfit, and glasses directly in the widget.</p>
          </div>
          <Switch
            checked={allowVisitorCustomization}
            onChange={setAllowVisitorCustomization}
            ariaLabel="Allow avatar customization in interactive guide"
          />
        </div>
      </div>

      {/* Collapsible Advanced: Self-hosted URLs + Custom AIML */}
      <div className="border-t border-gray-100 pt-3 dark:border-white/[0.06]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-gray-900 dark:text-slate-300 dark:hover:text-white"
          >
            <Sliders className="h-3.5 w-3.5" aria-hidden="true" />
            {showAdvanced ? 'Hide advanced options' : 'Self-hosted URLs & custom AIML'}
          </button>
          <button
            type="button"
            onClick={() => {
              resetDefaults();
              toast.success('Interactive guide reset', 'Default bot.computer settings restored.');
            }}
            className="inline-flex cursor-pointer items-center gap-1 text-xs text-gray-500 hover:text-gray-800 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Reset defaults
          </button>
        </div>

        {showAdvanced && (
          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor="bot-guide-script-url" className="mb-1 block text-xs font-medium text-gray-700 dark:text-slate-300">
                Embed script URL (optional)
              </label>
              <input
                id="bot-guide-script-url"
                type="text"
                value={scriptUrl}
                onChange={(e) => setScriptUrl(e.target.value)}
                placeholder={DEFAULT_BOT_SCRIPT_URL}
                className={cn(FIELD, 'font-mono text-xs')}
              />
              <p className={cn('mt-1', HELP)}>
                Leave blank for the pinned bot.computer release, or set a self-hosted path like <code className="font-mono">/bot/bot-embed.js</code>.
              </p>
            </div>
            <div>
              <label htmlFor="bot-guide-wasm-url" className="mb-1 block text-xs font-medium text-gray-700 dark:text-slate-300">
                Voice WASM URL (optional)
              </label>
              <input
                id="bot-guide-wasm-url"
                type="text"
                value={wasmUrl}
                onChange={(e) => setWasmUrl(e.target.value)}
                placeholder={DEFAULT_BOT_WASM_URL}
                className={cn(FIELD, 'font-mono text-xs')}
              />
            </div>
            <div>
              <label htmlFor="bot-guide-custom-aiml" className="mb-1 block text-xs font-medium text-gray-700 dark:text-slate-300">
                Extra AIML 2.0 categories (optional)
              </label>
              <textarea
                id="bot-guide-custom-aiml"
                rows={4}
                value={customAiml}
                onChange={(e) => setCustomAiml(e.target.value)}
                placeholder={'<category>\n  <pattern># SUPPORT HOURS #</pattern>\n  <template>[smile] Our team is online Monday to Friday, 9am to 5pm.</template>\n</category>'}
                className={cn(FIELD, 'font-mono text-xs')}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
