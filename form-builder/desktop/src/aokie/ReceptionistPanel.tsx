import { useEffect, useState, type ReactElement } from 'react';
import { isTauri, plugins, formlogic, type PluginSnapshot } from '../api';
import {
  CircleCheckIcon,
  AlertTriangleIcon,
  CloudIcon,
  PhoneCallIcon,
  PuzzleIcon,
  RadioIcon,
  SmartphoneIcon,
} from '../Icons';
import { AokieCard } from './AokieCard';
import { DeliveryDiagnostics } from './DeliveryDiagnostics';
import { LiveCallConsole } from './LiveCallConsole';

/** `phone.status` response data (aokie connector) — readiness subset. */
interface PhoneStatus {
  paired?: boolean;
  connected?: boolean;
  initialized?: boolean;
  device?: { name?: string; address?: string } | null;
  error?: string | null;
}

interface ReadinessItem {
  icon: (props: { size?: number }) => ReactElement;
  label: string;
  value: string;
  note: string;
  ok: boolean | null; // null = unknown
}

/**
 * The AI Receptionist workspace (redesign 2026-07).
 *
 * Readiness is built from INDEPENDENT states — plugin process, Bluetooth
 * radio, paired phone, plugin health, cloud delivery — because a "running"
 * plugin alone does not mean the receptionist can take a call. The live
 * status/settings/simulate card below is the same single implementation the
 * Plugins page uses (src/aokie/AokieCard.tsx).
 */
export default function ReceptionistPanel() {
  const [plugin, setPlugin] = useState<PluginSnapshot | null | undefined>(undefined);
  const [devMode, setDevMode] = useState(false);
  const [phone, setPhone] = useState<PhoneStatus | null>(null);
  const [cloudLinked, setCloudLinked] = useState<boolean | null>(null);
  const [deliveryNote, setDeliveryNote] = useState<string>('');
  // Whether the built-in AI receptionist owns call replies (settings bag) —
  // drives the live console's speak-to-caller gating.
  const [aiReceptionist, setAiReceptionist] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let id: number | undefined;

    const tick = async () => {
      const [plg, cloud] = await Promise.allSettled([
        plugins.list(),
        isTauri() ? formlogic.status() : Promise.reject(new Error('not tauri')),
      ]);
      if (cancelled) return;
      let aokieRunning = false;
      if (plg.status === 'fulfilled') {
        const aokie = plg.value.plugins.find((p) => p.id === 'aokie') ?? null;
        setPlugin(aokie);
        setDevMode(plg.value.devMode);
        aokieRunning = aokie?.state === 'running';
      }
      if (cloud.status === 'fulfilled') {
        setCloudLinked(cloud.value.linked);
        setDeliveryNote(
          cloud.value.lastError
            ? cloud.value.lastError
            : cloud.value.linked
              ? `${cloud.value.recordsWritten} records written`
              : 'link an account to deliver records'
        );
      }
      // Radio/phone state only makes sense while the plugin runs.
      if (aokieRunning) {
        try {
          const res = await plugins.command('aokie', 'phone.status');
          if (!cancelled) setPhone((res.data ?? null) as PhoneStatus | null);
        } catch {
          if (!cancelled) setPhone(null);
        }
        try {
          const res = await plugins.command('aokie', 'settings.get');
          const bag = (res.data as { settings?: Record<string, unknown> } | undefined)?.settings;
          if (!cancelled && bag) setAiReceptionist(Boolean(bag.aiReceptionist));
        } catch {
          /* keep the last known flag */
        }
      } else {
        setPhone(null);
      }
    };

    const start = () => {
      if (id !== undefined) return;
      void tick();
      id = window.setInterval(tick, 5000);
    };
    const stop = () => {
      if (id !== undefined) {
        window.clearInterval(id);
        id = undefined;
      }
    };
    const onVis = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const running = plugin?.state === 'running';
  const health = plugin?.lastHealth ?? null;

  const items: ReadinessItem[] = [
    {
      icon: PuzzleIcon,
      label: 'Plugin',
      value: plugin === undefined ? '…' : plugin === null ? 'Not installed' : plugin.state,
      note: plugin?.version ? `Aokie v${plugin.version}` : 'install from Plugins',
      ok: plugin === undefined ? null : running,
    },
    {
      icon: RadioIcon,
      label: 'Bluetooth radio',
      value: !running ? '—' : phone == null ? '…' : phone.initialized ? 'Ready' : 'Not initialised',
      note: !running
        ? 'plugin not running'
        : phone?.error
          ? phone.error
          : phone?.initialized
            ? 'radio up'
            : 'connect a supported dongle',
      ok: !running ? null : phone == null ? null : Boolean(phone.initialized),
    },
    {
      icon: SmartphoneIcon,
      label: 'Paired phone',
      value: !running
        ? '—'
        : phone == null
          ? '…'
          : phone.connected
            ? 'Connected'
            : phone.paired
              ? 'Paired, offline'
              : 'Not paired',
      note:
        phone?.device?.name ??
        phone?.device?.address ??
        'pair from the card below — choose “Aokie AI Assistant”',
      ok: !running ? null : phone == null ? null : Boolean(phone.connected),
    },
    {
      icon: PhoneCallIcon,
      label: 'Plugin health',
      value: health ? health.status : running ? '…' : '—',
      note: health?.detail ?? (running ? 'no health report yet' : 'plugin not running'),
      ok: health ? health.ok : null,
    },
    {
      icon: CloudIcon,
      label: 'Data delivery',
      value: cloudLinked == null ? '…' : cloudLinked ? 'Linked' : 'Not linked',
      note: deliveryNote || '—',
      ok: cloudLinked,
    },
  ];

  const allOk = items.every((i) => i.ok === true);

  return (
    <div className="panel desktop-receptionist">
      <section className="desktop-receptionist-hero">
        <div>
          <span className="desktop-card-eyebrow">CURRENT STATUS</span>
          <h2>
            {plugin === undefined
              ? 'Checking Aokie…'
              : plugin === null
                ? 'Aokie is not installed'
                : allOk
                  ? 'Ready for calls'
                  : running
                    ? 'Running — check readiness below'
                    : 'Not running'}
          </h2>
          <p>
            {plugin === null
              ? 'Install the Aokie phone bridge from the Plugins workspace to get started.'
              : allOk
                ? 'The plugin, phone and delivery pipeline are healthy.'
                : 'Each readiness item must be green before Aokie can take a call.'}
          </p>
        </div>
        <span className={`desktop-status-pill ${allOk ? 'is-ok' : running ? 'is-warn' : 'is-neutral'}`}>
          <i />
          {plugin === undefined
            ? 'Checking'
            : allOk
              ? 'Ready'
              : running
                ? 'Degraded'
                : plugin === null
                  ? 'Not installed'
                  : 'Stopped'}
        </span>
      </section>

      <div className="desktop-readiness-grid">
        {items.map(({ icon: Icon, label, value, note, ok }) => (
          <div className="desktop-readiness-card" key={label}>
            <span className="desktop-readiness-card__icon">
              <Icon size={15} />
            </span>
            <small>{label}</small>
            <strong>{value}</strong>
            <p title={note}>{note}</p>
            <span className={`desktop-readiness-card__state ${ok == null ? 'is-unknown' : ok ? 'is-ok' : 'is-bad'}`}>
              {ok == null ? null : ok ? <CircleCheckIcon size={14} /> : <AlertTriangleIcon size={14} />}
            </span>
          </div>
        ))}
      </div>

      {/* Live-call controls + delivery diagnostics — only meaningful while
          the plugin process is up. */}
      {running && (
        <div className="desktop-receptionist-cards">
          <LiveCallConsole aiReceptionist={aiReceptionist} />
          <DeliveryDiagnostics />
        </div>
      )}

      {/* The status/settings console: phone status, pairing, dev simulate +
          settings — the ONE shared Aokie implementation. */}
      {plugin ? (
        <AokieCard running={running} devMode={devMode} />
      ) : plugin === null ? (
        <p className="hint">
          No Aokie plugin found. Open <strong>Plugins</strong> and install the bundled Aokie phone
          bridge, then come back here.
        </p>
      ) : null}
    </div>
  );
}
