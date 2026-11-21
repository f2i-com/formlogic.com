import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Database, Loader2, Play, RefreshCw, Sparkles } from 'lucide-react';
import { api, resolveFileUrl, type MarketplaceDemoSession } from '../../lib/api';

const LANDING_DEMO_SLUG = 'landing-pottery-studio';

/**
 * Real embedded FormLogic SoftN app (Kiln & Wheel Pottery Studio) backed by an isolated
 * per-visitor SQLite database via MarketplaceSandboxService. Visitors can browse the live
 * timetable, book spots, add classes, and cancel bookings against a real SQLite backend.
 */
export function HostedAppPreview() {
  const [session, setSession] = useState<MarketplaceDemoSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const startedRef = useRef(false);

  const launch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.startMarketplaceDemo(LANDING_DEMO_SLUG);
      if (res.error || !res.data) {
        setError(res.error || 'Could not connect to the live sandbox backend.');
        return;
      }
      setSession(res.data);
      setFrameKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to the live sandbox backend.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void launch();
  }, [launch]);

  const handleReset = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    setError(null);
    try {
      if (!session) {
        await launch();
        return;
      }
      const res = await api.resetMarketplaceDemo(LANDING_DEMO_SLUG, session.token);
      if (res.error) {
        await launch();
        return;
      }
      setFrameKey((k) => k + 1);
    } catch {
      await launch();
    } finally {
      setResetting(false);
    }
  }, [session, resetting, launch]);

  const frameUrl = session ? resolveFileUrl(session.framePath) : '';

  return (
    <figure className="lv2-hosted-example lv2-hosted-example--live">
      <div className="lv2-hosted-example__bar">
        <div className="lv2-hosted-example__badges">
          <span className="lv2-hosted-live-pill">
            <Sparkles size={12} aria-hidden="true" />
            Live FormLogic App
          </span>
          <span className="lv2-hosted-db-pill">
            <Database size={12} aria-hidden="true" />
            Real SQLite Backend
          </span>
        </div>
        <button
          type="button"
          className="lv2-hosted-reset-btn"
          onClick={() => void handleReset()}
          disabled={loading || resetting}
          title="Reset this visitor sandbox back to the initial SQLite seed"
        >
          <RefreshCw size={13} className={resetting ? 'animate-spin' : undefined} aria-hidden="true" />
          {resetting ? 'Resetting…' : 'Reset'}
        </button>
      </div>

      <div className="lv2-hosted-example__stage">
        {session ? (
          <iframe
            key={`${session.token}:${frameKey}`}
            title="Kiln & Wheel Pottery Studio — live FormLogic app backed by SQLite"
            src={frameUrl}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            className="lv2-hosted-example__frame"
          />
        ) : loading ? (
          <div className="lv2-hosted-example__fallback" role="status" aria-live="polite">
            <Loader2 size={24} className="animate-spin" aria-hidden="true" />
            <p>Starting your isolated SQLite sandbox…</p>
          </div>
        ) : (
          <div className="lv2-hosted-example__fallback">
            <p>{error || 'Launch the interactive Pottery Studio app to test real SQLite bookings.'}</p>
            <button type="button" className="lv2-hosted-launch-btn" onClick={() => void launch()}>
              <Play size={14} aria-hidden="true" />
              Launch live app
            </button>
          </div>
        )}
      </div>

      <figcaption>
        <div>
          <span>Interactive SoftN app · isolated per-visitor database</span>
          <strong>Pottery class bookings — try booking a spot live</strong>
        </div>
        <Link to="/docs#javascript-apps">
          Hosting guide <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </figcaption>
    </figure>
  );
}
