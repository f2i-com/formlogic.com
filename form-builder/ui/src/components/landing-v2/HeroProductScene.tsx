import { useEffect, useRef, useState } from 'react';
import {
  CalendarCheck,
  Check,
  CheckCircle2,
  Database,
  FileText,
  LockKeyhole,
  MessageSquareText,
  PhoneCall,
  Zap,
} from 'lucide-react';

type DemoView = 'call' | 'flow' | 'record';

const VIEW_ORDER: DemoView[] = ['call', 'flow', 'record'];
const ROTATE_MS = 5600;

// Deterministic bar heights for the "live audio" waveform.
const WAVE_HEIGHTS = [22, 14, 26, 12, 20, 27, 15, 23, 11, 19];

/**
 * The hero's interactive product window: Live call / Running flow / Customer
 * record views. Auto-rotates every few seconds (respecting reduced motion)
 * until the visitor picks a tab, after which it stays put.
 */
export function HeroProductScene() {
  const [view, setView] = useState<DemoView>('call');
  const lockedRef = useRef(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => {
      if (lockedRef.current) return;
      setView((v) => VIEW_ORDER[(VIEW_ORDER.indexOf(v) + 1) % VIEW_ORDER.length]);
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, []);

  const pick = (v: DemoView) => {
    lockedRef.current = true;
    setView(v);
  };

  return (
    <div className="lv2-scene" aria-label="Interactive FormLogic product example">
      <div className="lv2-scene__glow" aria-hidden="true" />
      <div className="lv2-scene__window">
        <div className="lv2-scene__bar">
          <div className="lv2-scene__brand">
            <span className="lv2-scene__logo">B</span>
            <span>
              <strong>Brightside Dental</strong>
              <small>Front desk workspace · built on FormLogic</small>
            </span>
          </div>
          <span className="lv2-live-pill">
            <i /> Aokie connected
          </span>
        </div>

        <div className="lv2-scene__tabs" role="tablist" aria-label="Product example views">
          {VIEW_ORDER.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={view === item}
              className={view === item ? 'lv2-active' : ''}
              onClick={() => pick(item)}
            >
              {item === 'call' ? 'Live call' : item === 'flow' ? 'Running flow' : 'Customer record'}
            </button>
          ))}
        </div>

        <div className="lv2-scene__body">
          {view === 'call' && (
            <div>
              <div className="lv2-caller">
                <span className="lv2-caller__avatar">JW</span>
                <span className="lv2-caller__details">
                  <small>Call in progress · 01:42</small>
                  <strong>Jordan Wells</strong>
                  <span>Returning customer · Mobile</span>
                </span>
                <span className="lv2-wave" aria-hidden="true">
                  {WAVE_HEIGHTS.map((h, i) => (
                    <i key={i} style={{ height: `${h}px`, animationDelay: `${(i % 7) * 0.06}s` }} />
                  ))}
                </span>
              </div>

              <div className="lv2-transcript">
                <div className="lv2-msg lv2-msg--aokie">
                  <span>A</span>
                  <p>Hi Jordan, welcome back. How can I help today?</p>
                </div>
                <div className="lv2-msg lv2-msg--caller">
                  <span>J</span>
                  <p>I&rsquo;d like a check-up next Tuesday afternoon, if possible.</p>
                </div>
                <div className="lv2-msg lv2-msg--aokie">
                  <span>A</span>
                  <p>I can take that request. Is 2:30&nbsp;pm your preferred time?</p>
                </div>
              </div>

              <div className="lv2-call-footer">
                <span>
                  <CheckCircle2 size={14} /> Caller recognised
                </span>
                <span>
                  <LockKeyhole size={14} /> Local voice services
                </span>
              </div>
            </div>
          )}

          {view === 'flow' && (
            <div className="lv2-flow">
              <p>Appointment request · running now</p>
              <div className="lv2-flow__track">
                <div className="lv2-flow__node lv2-flow__node--done">
                  <span>
                    <PhoneCall size={17} />
                  </span>
                  <div>
                    <strong>Call request captured</strong>
                    <small>Aokie · 1.2s ago</small>
                  </div>
                  <Check size={16} />
                </div>
                <div className="lv2-flow__line" />
                <div className="lv2-flow__node lv2-flow__node--done">
                  <span>
                    <Database size={17} />
                  </span>
                  <div>
                    <strong>Customer matched</strong>
                    <small>Customers · Jordan Wells</small>
                  </div>
                  <Check size={16} />
                </div>
                <div className="lv2-flow__line" />
                <div className="lv2-flow__node lv2-flow__node--running">
                  <span>
                    <CalendarCheck size={17} />
                  </span>
                  <div>
                    <strong>Create appointment request</strong>
                    <small>Appointments · Tuesday 2:30 pm</small>
                  </div>
                  <i className="lv2-spinner" />
                </div>
                <div className="lv2-flow__line" />
                <div className="lv2-flow__node">
                  <span>
                    <MessageSquareText size={17} />
                  </span>
                  <div>
                    <strong>Draft confirmation message</strong>
                    <small>Waits for staff approval</small>
                  </div>
                  <span />
                </div>
              </div>
            </div>
          )}

          {view === 'record' && (
            <div className="lv2-record">
              <div className="lv2-record__head">
                <span>
                  <FileText size={18} />
                </span>
                <div>
                  <strong>Appointment request</strong>
                  <small>Created from Aokie call</small>
                </div>
                <span className="lv2-record__status">Needs confirmation</span>
              </div>
              <dl className="lv2-record__grid">
                <div>
                  <dt>Customer</dt>
                  <dd>Jordan Wells</dd>
                </div>
                <div>
                  <dt>Service</dt>
                  <dd>General check-up</dd>
                </div>
                <div>
                  <dt>Preferred date</dt>
                  <dd>Tuesday, 14 July</dd>
                </div>
                <div>
                  <dt>Preferred time</dt>
                  <dd>2:30 pm</dd>
                </div>
                <div className="lv2-wide">
                  <dt>Call summary</dt>
                  <dd>
                    Returning customer requested an afternoon check-up. Prefers 2:30 pm; awaiting
                    staff confirmation.
                  </dd>
                </div>
              </dl>
              <div className="lv2-record__actions">
                <button type="button">Open record</button>
                <button type="button" className="lv2-primary">
                  Confirm request
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="lv2-scene__note lv2-scene__note--top">
        <span>
          <PhoneCall size={15} />
        </span>
        <div>
          <small>Capture</small>
          <strong>Every conversation</strong>
        </div>
      </div>
      <div className="lv2-scene__note lv2-scene__note--bottom">
        <span>
          <Zap size={15} />
        </span>
        <div>
          <small>Automate</small>
          <strong>The next action</strong>
        </div>
      </div>
    </div>
  );
}
