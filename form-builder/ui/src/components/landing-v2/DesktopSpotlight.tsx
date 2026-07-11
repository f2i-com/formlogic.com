import { Link } from 'react-router-dom';
import {
  Code2,
  Database,
  Download,
  LayoutGrid,
  Monitor,
  PhoneCall,
  PlugZap,
  Puzzle,
  Server,
  Workflow,
} from 'lucide-react';
import { SectionLabel } from './shared';

/** FormLogic Desktop spotlight: mini control-centre mock + the capability copy. */
export function DesktopSpotlight() {
  return (
    <section id="desktop" className="lv2-section lv2-desktop">
      <div className="lv2-desktop__ring" aria-hidden="true" />
      <div className="lv2-container lv2-desktop__inner">
        <div className="lv2-desktop__visual" data-reveal="">
          <div className="lv2-minidesk" aria-hidden="true">
            <aside className="lv2-minidesk__rail">
              <span className="lv2-minidesk__logo">
                <i />
                <i />
                <i />
              </span>
              <i className="lv2-active">
                <LayoutGrid size={16} />
              </i>
              <i>
                <PhoneCall size={16} />
              </i>
              <i>
                <Server size={16} />
              </i>
              <i>
                <Puzzle size={16} />
              </i>
            </aside>
            <div className="lv2-minidesk__main">
              <div className="lv2-minidesk__top">
                <span>Control centre</span>
                <span>
                  <i /> All systems ready
                </span>
              </div>
              <div className="lv2-minidesk__hero">
                <span>
                  <PlugZap size={20} />
                </span>
                <div>
                  <small>FORMLOGIC CLOUD</small>
                  <strong>Linked and running headlessly</strong>
                  <p>18 flow runs · 24 records written</p>
                </div>
              </div>
              <div className="lv2-minidesk__cards">
                <span>
                  <PhoneCall size={17} />
                  <strong>Aokie</strong>
                  <small>Ready</small>
                </span>
                <span>
                  <Server size={17} />
                  <strong>Services</strong>
                  <small>3 running</small>
                </span>
                <span>
                  <Database size={17} />
                  <strong>Models</strong>
                  <small>6 available</small>
                </span>
                <span>
                  <Code2 size={17} />
                  <strong>Python</strong>
                  <small>Installed</small>
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="lv2-desktop__copy" data-reveal="">
          <SectionLabel light>FormLogic Desktop</SectionLabel>
          <h2>Local power. Cloud visibility.</h2>
          <p>
            Desktop is the local capability layer for FormLogic. It manages models, services,
            plugins and hardware — and keeps flows running headlessly while the web app gives you a
            remote view.
          </p>
          <div className="lv2-feature-rows">
            <span>
              <Server size={19} />
              <div>
                <strong>Run local AI services</strong>
                <small>Ollama, llama.cpp, voice, image, video and your own tools.</small>
              </div>
            </span>
            <span>
              <Puzzle size={19} />
              <div>
                <strong>Connect plugins and hardware</strong>
                <small>A supervised, permission-aware bridge between web apps and the real world.</small>
              </div>
            </span>
            <span>
              <Workflow size={19} />
              <div>
                <strong>Keep flows moving</strong>
                <small>Run local tasks and event-driven workflows even with the browser closed.</small>
              </div>
            </span>
          </div>
          <div className="lv2-inline-actions" style={{ marginTop: 26 }}>
            <Link to="/download" className="lv2-btn lv2-btn--primary">
              Get FormLogic Desktop <Download size={16} />
            </Link>
          </div>
          <span className="lv2-desktop__note">
            <Monitor size={15} /> Windows desktop UI today; a Linux headless runtime is also
            available. The web app works everywhere.
          </span>
        </div>
      </div>
    </section>
  );
}
