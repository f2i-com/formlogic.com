/**
 * Route-aware AIML 2.0 knowledge base for FormLogic's optional bot.computer interactive guide.
 *
 * Uses bot.computer's native `<tour><stop target="...">`, `<showcase target="...">`,
 * `<chips>`, `<reply>`, `<srai>`, and gesture tags (`[wave]`, `[nod]`, `[smile]`,
 * `[thumbsup]`, `[cheerful]`, `[wink]`) to walk visitors and builders through every
 * part of FormLogic and answer deep questions across all platform capabilities.
 */

export type GuideRouteSection =
  | 'landing'
  | 'marketplace'
  | 'dashboard'
  | 'apps'
  | 'app-settings'
  | 'app-studio'
  | 'softn-workspace'
  | 'form-builder'
  | 'responses'
  | 'forms'
  | 'flows'
  | 'settings'
  | 'docs'
  | 'db-import'
  | 'workspace';

export interface FormLogicGuideContext {
  section: GuideRouteSection;
  greeting: string;
  aimlXml: string;
  facts: Record<string, string>;
}

export function classifyGuideRoute(pathname: string, signedIn: boolean): GuideRouteSection {
  if (pathname === '/' && !signedIn) return 'landing';
  if (pathname.startsWith('/packs')) return 'marketplace';
  if (pathname.startsWith('/docs') || pathname.startsWith('/aokie') || pathname.startsWith('/ai-setup')) return 'docs';
  if (pathname === '/dashboard' || (pathname === '/' && signedIn)) return 'dashboard';
  if (/^\/apps\/[^/]+\/settings/.test(pathname)) return 'app-settings';
  if (/^\/apps\/[^/]+\/studio/.test(pathname)) return 'app-studio';
  if (/^\/apps\/[^/]+\/web/.test(pathname)) return 'softn-workspace';
  if (pathname.startsWith('/apps')) return 'apps';
  if (pathname.startsWith('/builder') || pathname.startsWith('/admin/builder')) return 'form-builder';
  if (pathname.startsWith('/responses') || pathname.startsWith('/analytics')) return 'responses';
  if (pathname.startsWith('/forms')) return 'forms';
  if (pathname.startsWith('/import')) return 'db-import';
  if (pathname.startsWith('/flows') || pathname.startsWith('/diagrams')) return 'flows';
  if (pathname.startsWith('/settings')) return 'settings';
  return 'workspace';
}

/** Customer-facing public forms & live hosted apps stay distraction-free without the platform guide. */
export function isGuideHiddenPath(pathname: string): boolean {
  return (
    pathname.startsWith('/form/') ||
    pathname.startsWith('/app/') ||
    pathname.startsWith('/open/app/') ||
    pathname.startsWith('/preview/') ||
    pathname.startsWith('/oauth/') ||
    pathname.startsWith('/sign-in/')
  );
}

function chipsForSection(section: GuideRouteSection): string[] {
  switch (section) {
    case 'landing':
      return [
        'Take me on a tour',
        'How do SoftN apps and forms work together?',
        'Show me the live demos',
        'What can you teach me?',
      ];
    case 'marketplace':
      return [
        'Take me on a tour',
        'How do live sandboxes work?',
        'How do modular plugins work?',
        'Can I sell my own apps?',
      ];
    case 'form-builder':
      return [
        'Take me on a tour',
        'What field types exist?',
        'How do scripts and conditional logic work?',
        'How do SQLite bindings work?',
      ];
    case 'responses':
      return [
        'How do I export CSV, JSON, or SQLite?',
        'How do private encrypted forms work?',
        'How do dashboards and charts work?',
        'How do linked records work?',
      ];
    case 'app-settings':
      return [
        'Take me on a tour',
        'How do I customize my app icon and theme?',
        'How do roles and custom domains work?',
        'How do I connect a shared SQLite database?',
      ];
    case 'app-studio':
      return [
        'Take me on a tour',
        'How do I build an app in Studio?',
        'How do custom screens work?',
        'How do I publish my app?',
      ];
    case 'softn-workspace':
      return [
        'How do SoftN apps and forms work together?',
        'Which backend languages are supported?',
        'How do external API keys work?',
        'How do I share SQLite with forms?',
      ];
    case 'forms':
      return [
        'How do forms and apps connect?',
        'How do linked records work?',
        'How do private encrypted forms work?',
        'How do I import or export data?',
      ];
    case 'flows':
      return [
        'Take me on a tour',
        'What can Flows automate?',
        'How do Blueprints and Diagrams work?',
        'What are OAIY Desktop and Aokie?',
      ];
    case 'settings':
      return [
        'Take me on a tour',
        'How do API keys and MCP work?',
        'How do backups and encryption work?',
        'How do I customize or move you?',
      ];
    case 'docs':
      return [
        'Take me on a tour',
        'How do I import an existing database?',
        'How do API keys and MCP work?',
        'How do I self-host FormLogic?',
      ];
    case 'db-import':
      return [
        'Take me on a tour',
        'How do I import an existing database?',
        'How do foreign keys and batch imports work?',
        'How does the local 127.0.0.1 bridge stay private?',
      ];
    default:
      return [
        'Take me on a tour',
        'What can you teach me?',
        'How do SoftN apps and forms work together?',
        'How do Flows and AI work?',
      ];
  }
}

function greetingForSection(section: GuideRouteSection, botName: string): string {
  switch (section) {
    case 'landing':
      return `[wave] Hi, I'm ${botName}! Ask me anything about FormLogic — forms, SoftN apps, shared SQLite, flows, MCP, or self-hosting — or click Take me on a tour.`;
    case 'marketplace':
      return `[wave] Welcome to the Marketplace! I'm ${botName}. Every demo runs in its own live SQLite sandbox — ask how sandboxes, plugins, or publishing work.`;
    case 'form-builder':
      return `[cheerful] Welcome to the Form Builder! I'm ${botName}. Ask for a tour of the palette, canvas, field settings, ZIPP scripts, SQLite bindings, or publishing.`;
    case 'responses':
      return `[smile] Viewing responses and analytics! Ask me about CSV, JSON, or SQLite exports, chart drill-downs, or decrypting private E2EE forms.`;
    case 'app-settings':
      return `[smile] You're in App Settings! Ask me about icons, WCAG-checked themes, menu links, roles, custom domains, modular plugins, or shared SQLite.`;
    case 'app-studio':
      return `[thumbsup] Welcome to App Studio! Ask for a tour or ask about data forms, custom screens, member roles, and publishing.`;
    case 'softn-workspace':
      return `[nod] You're in the SoftN App Workspace! Ask me about PHP, Rust, JS, or Python backends, shared SQLite tables, AI Studio editing, or external API keys.`;
    case 'flows':
      return `[nod] Welcome to Automations and Flows! Ask for a tour or ask about triggers, ZIPP code nodes, webhooks, AI nodes, OAIY Desktop, or Aokie.`;
    case 'settings':
      return `[smile] Welcome to Settings! You can customize my avatar, framing, voice, and AIML right here — or ask about API keys, MCP, vaults, and backups.`;
    case 'docs':
      return `[wave] Welcome to the FormLogic Docs! I'm ${botName}. Search sections on the left or ask me directly about forms, database import, SoftN apps, API keys, MCP, Flows, or self-hosting.`;
    case 'db-import':
      return `[cheerful] Welcome to Database Import! I'm ${botName}. Drop or paste MySQL, PostgreSQL, MSSQL, SQLite, Oracle, or Prisma schemas — or connect strictly locally on 127.0.0.1 — to generate linked CRUD forms and batch-import your data.`;
    default:
      return `[wave] Hi, I'm ${botName}, your FormLogic guide. Drag me anywhere if I'm in your way, or ask for a guided tour and I'll walk you through this page!`;
  }
}

function tourStopsForSection(section: GuideRouteSection): string {
  switch (section) {
    case 'landing':
      return `
      <stop target="hero">[wave] Welcome to FormLogic! Everything starts here: structured forms, live charts, hosted SoftN apps, and visual flows sharing one SQLite database.</stop>
      <stop target="preview">[nod] Try adding a job note in this live Field Ops preview — watch it update the app list, the Shared SQLite table, and the KPI charts instantly.</stop>
      <stop target="live-demo">[thumbsup] Launch any of our live demos here! Each demo pairs a custom SoftN app with a full FormLogic Forms workspace sharing the exact same private SQLite sandbox.</stop>
      <stop target="portable-apps">[smile] Build portable apps in SoftN, PHP, Rust, JavaScript, or Python — all wired straight into your forms, auth roles, and APIs.</stop>
      <stop target="platform">[nod] Under the hood you get linked records, ZIPP sandboxed scripts, end-to-end encrypted forms, webhooks, API keys, and OAuth MCP for Claude and ChatGPT.</stop>
      <stop target="aokie">[wave] Meet Aokie — your local AI phone receptionist that answers calls, writes structured notes into forms, and triggers follow-up flows.</stop>
      <stop target="pricing">[thumbsup] Start free in the cloud or self-host the entire platform on your own PHP, MySQL, and Node server with zero per-seat lock-in.</stop>
      `;
    case 'form-builder':
      return `
      <stop target="builder-header">[wave] Up here is your form header: rename the form, pick a custom Lucide icon, check your save state, and see if this form is live-bound to a shared SQLite table.</stop>
      <stop target="builder-palette">[nod] This left panel is your Field Palette! Click any of the 23 field types — from text, phone, and choices to linked records, calculated and hidden fields, file uploads, signatures, and GPS location.</stop>
      <stop target="builder-canvas">[thumbsup] Here is your drag-and-drop canvas! Reorder questions smoothly, duplicate or delete fields, and use Undo or Redo anytime.</stop>
      <stop target="builder-properties">[smile] Selecting any field opens Field Settings on the right: configure labels, placeholders, validation rules, and conditional show-or-hide logic.</stop>
      <stop target="builder-toolbar">[cheerful] Finish up on the top toolbar: customize your Theme, design Custom Screens or Dashboards, write ZIPP Scripts, wire Flows, Preview, Share, and hit Publish!</stop>
      `;
    case 'app-studio':
      return `
      <stop target="studio-nav">[wave] This is your App Studio navigation bar! Move step-by-step from Overview to Data and Forms, Screens, Members, and Review and Publish.</stop>
      <stop target="sidebar-nav">[nod] Your left workspace sidebar lets you jump straight into Records, Reports, App Settings, Automations, or any other app in your account.</stop>
      <stop target="create-app">[thumbsup] Need another app? Create a new Forms app or hosted SoftN app from here anytime.</stop>
      `;
    case 'app-settings':
      return `
      <stop target="app-settings-tabs">[wave] Use these sections to organize General details, Appearance, Navigation menus, Access control, and Manage tools like SQLite databases and modular plugins.</stop>
      <stop target="app-icon-picker">[smile] Right here you can pick an app icon, set a logo, check WCAG accent color contrast in light and dark mode, and brand your sign-in page.</stop>
      <stop target="sidebar-nav">[thumbsup] Use the sidebar anytime to jump back to App Studio, Manage Forms, Roles, Relations, or Deploy.</stop>
      `;
    case 'flows':
      return `
      <stop target="flows-nav">[wave] Switch here between creating a new automation from scratch or templates, and managing all your existing cloud and desktop flows.</stop>
      <stop target="flows-canvas">[thumbsup] Pick a flow template or open any flow to build visual node graphs with form triggers, webhooks, schedules, ZIPP JS or Python code, AI prompts, and desktop actions.</stop>
      <stop target="sidebar-nav">[nod] You can also explore Diagrams to sketch a whole system blueprint and materialize forms, apps, and flows together.</stop>
      `;
    case 'marketplace':
      return `
      <stop target="marketplace-catalog">[wave] Welcome to the Marketplace! Filter by SoftN Apps, Modular Plugins, or Form Packs — and launch any live sandbox to test both the frontend and backend safely before installing.</stop>
      <stop target="sidebar-nav">[thumbsup] Installed apps appear right in your workspace sidebar, ready to customize or link with your forms and flows.</stop>
      `;
    case 'settings':
      return `
      <stop target="settings-sections">[wave] Settings are organized into five clean sections: Account, Workspace, AI and devices, Security, and Your data.</stop>
      <stop target="settings-search">[nod] Looking for something specific like API keys, 2FA, backups, or OAIY pairing? Type in Find a setting to jump straight to that panel.</stop>
      <stop target="settings-guide">[cheerful] And right here is my own panel! Switch my character, pick 3D or 2D, choose Full body or Upper body, toggle spoken voice, or add your own custom AIML rules.</stop>
      `;
    case 'apps':
      return `
      <stop target="apps-toolbar">[wave] Search across all your Forms and SoftN apps, filter by type or publish status, and switch between Table and Card views here.</stop>
      <stop target="create-app">[thumbsup] Click Create app to start a fresh Classic Forms app, install a SoftN starter in PHP, Rust, JS, or Python, or import from the Marketplace.</stop>
      <stop target="sidebar-nav">[nod] Your pinned apps, Forms, Automations, Marketplace, and Settings are always one click away on the sidebar.</stop>
      `;
    case 'docs':
      return `
      <stop target="docs-toc">[wave] Use this table of contents and quick search filter to jump to any guide — from Quick Start and Backend Scripts to Database Import, External APIs, MCP, and Self-Hosting.</stop>
      <stop target="docs-content">[thumbsup] Every guide includes real copy-paste code examples, visual walkthroughs, and links to deeper developer references in the repository.</stop>
      `;
    case 'db-import':
      return `
      <stop target="db-import-steps">[wave] Follow these four steps: connect locally or upload your schema, customize table and field mappings, generate linked CRUD forms or a full App, and then batch-import your existing rows.</stop>
      <stop target="db-import-workspace">[thumbsup] Everything parses right inside your browser — MySQL, PostgreSQL, SQL Server, SQLite files, Oracle, Prisma, CSV, or a strictly local 127.0.0.1 bridge so credentials never touch the server!</stop>
      `;
    default:
      return `
      <stop target="sidebar-nav">[wave] Here is your workspace navigation! Jump effortlessly between Home, Apps, Forms, Automations, Marketplace, and Settings — or drag the dock to any edge of the screen.</stop>
      <stop target="create-app">[thumbsup] Click Create app whenever you want to launch a new Classic Forms app or hosted SoftN app backed by SQLite.</stop>
      <stop target="dashboard-quick-search">[smile] Press slash or use Quick Find to search all your forms and jump directly into records or analytics.</stop>
      `;
  }
}

/**
 * Sanitizes user-supplied custom AIML so it cannot break the surrounding `<aiml>` wrapper.
 * If the user pastes a full `<aiml>...</aiml>` document, extracts its inner `<category>` blocks.
 */
function extractCustomCategories(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const inner = trimmed
    .replace(/^<\?xml[\s\S]*?\?>\s*/i, '')
    .replace(/^<aiml\b[^>]*>/i, '')
    .replace(/<\/aiml>\s*$/i, '')
    .trim();
  if (/<script\b/i.test(inner)) return '';
  return inner;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildFormLogicGuideContext(
  pathname: string,
  signedIn: boolean,
  botName: string,
  customAiml?: string,
): FormLogicGuideContext {
  const section = classifyGuideRoute(pathname, signedIn);
  const chips = chipsForSection(section);
  const tourStops = tourStopsForSection(section);
  const extraCategories = extractCustomCategories(customAiml);

  const chipXml = chips
    .map((c) => `    <chip>${escapeXmlText(c)}</chip>`)
    .join('\n');

  const aimlXml = `<aiml version="2.0">
  <chips>
${chipXml}
  </chips>

  <!-- 1. Guided Tours & Topic Directory -->
  <category>
    <pattern>TAKE ME ON A TOUR | GIVE ME A TOUR | SHOW ME AROUND | TOUR | TOUR THIS PAGE | WALKTHROUGH | GUIDE ME | START TOUR</pattern>
    <template>
      <tour>
${tourStops}
      </tour>
    </template>
  </category>

  <category>
    <pattern># WHAT CAN YOU TEACH ME # | # WHAT CAN YOU DO # | # TOPICS # | # HELP # | # MENU # | # WHAT DO YOU KNOW #</pattern>
    <template>
      [cheerful] I know FormLogic inside and out! Ask me about the Form Builder, field types, ZIPP scripts, SoftN apps, shared SQLite, linked records, charts and exports, Flows, Site AI chat, MCP, OAIY Desktop, Aokie, E2EE private forms, API keys, or self-hosting — or ask me to take you on a live tour of this page!
      <reply>Take me on a tour</reply>
      <reply>What field types exist?</reply>
      <reply>How do SoftN apps and forms work together?</reply>
      <reply>What can Flows automate?</reply>
    </template>
  </category>

  <!-- 2. Core Platform & Unified SoftN + Forms Architecture -->
  <category>
    <pattern># WHAT IS FORMLOGIC # | # HOW DOES FORMLOGIC WORK # | # EXPLAIN FORMLOGIC # | # ABOUT FORMLOGIC # | # OVERVIEW #</pattern>
    <template>
      <showcase target="hero"/>[smile] FormLogic turns structured forms into complete connected apps, live dashboards, and visual automations. Every app can pair classic FormLogic forms with custom hosted SoftN web apps in PHP, Rust, JavaScript, or Python — all reading and writing one shared SQLite database!
      <reply>Take me on a tour</reply>
      <reply>How do SoftN apps and forms work together?</reply>
      <reply>Can I self-host FormLogic?</reply>
    </template>
  </category>

  <category>
    <pattern># SOFTN # | # SHARED SQLITE # | # SQLITE # | # WORK TOGETHER # | # SQLITE BINDING # | # SQLITE BINDINGS # | # TABLE BINDING #</pattern>
    <template>
      <showcase target="live-demo"/>[nod] FormLogic lets a custom SoftN app and a Classic Form App share the exact same SQLite database live! Any form can bind directly to a SQLite table — you'll see the SQLite badge in the Form Builder — so submitting a form updates your SoftN app immediately, and edits in your SoftN app show up right away in FormLogic tables, charts, and saved reports.
      <reply>Which backend languages are supported?</reply>
      <reply>How do live sandboxes work?</reply>
      <reply>How do external API keys work?</reply>
    </template>
  </category>

  <category>
    <pattern># BACKEND LANGUAGE # | # BACKEND LANGUAGES # | # PHP # | # RUST # | # PYTHON # | # NODE # | # JAVASCRIPT # | # PORTABLE APP # | # PORTABLE APPS #</pattern>
    <template>
      <showcase target="portable-apps"/>[thumbsup] FormLogic hosts portable SoftN apps across multiple runtimes: native SoftN apps, PHP Slim 4 backends, Rust, JavaScript or Node.js, and Python! Each hosted app runs in an isolated sandbox with its own SQLite database, clean API endpoints, and optional linked FormLogic CRUD forms.
      <reply>How do SoftN apps and forms work together?</reply>
      <reply>How do modular plugins work?</reply>
    </template>
  </category>

  <!-- 3. Live Demos, Sandboxes & Marketplace -->
  <category>
    <pattern># LIVE DEMO # | # LIVE DEMOS # | # SANDBOX # | # SANDBOXES # | # TRY DEMO # | # MARKETPLACE DEMO # | # RESET SANDBOX #</pattern>
    <template>
      <showcase target="live-demo"/>[thumbsup] Every live demo spins up a private, ephemeral SQLite sandbox tied to your browser session — no signup required! You can add, edit, and delete records in the SoftN app, switch straight into the connected FormLogic Forms view to see the exact same records live, and click Reset sandbox anytime to start fresh.
      <reply>How do modular plugins work?</reply>
      <reply>Can I sell my own apps?</reply>
    </template>
  </category>

  <category>
    <pattern># PLUGIN # | # PLUGINS # | # MODULAR PLUGIN # | # MODULAR PLUGINS # | # EXTENSIONS #</pattern>
    <template>
      <showcase target="marketplace-catalog"/>[smile] Modular SoftN plugins extend your workspace and hosted apps with extra screens, services, and APIs. Browse plugins in the Marketplace, test them in a source-hidden sandbox, install them to your account, and attach them to any app from App Settings under Manage.
      <reply>Can I sell my own apps?</reply>
      <reply>How do live sandboxes work?</reply>
    </template>
  </category>

  <category>
    <pattern># SELL # | # PUBLISH TO MARKETPLACE # | # LISTING # | # LICENSE # | # LICENSES # | # MARKETPLACE # | # PACK # | # PACKS #</pattern>
    <template>
      <showcase target="marketplace-catalog"/>[cheerful] The Marketplace hosts Form Packs, SoftN Apps, and Modular Plugins! You can publish free or paid listings, enable private source-hidden hosting with live sandboxes so buyers can test before installing, and track licenses and sales from the Seller tab.
      <reply>How do modular plugins work?</reply>
      <reply>How do I build an app in Studio?</reply>
    </template>
  </category>

  <!-- 4. Form Builder Deep Dive -->
  <category>
    <pattern># FORM BUILDER # | # BUILD A FORM # | # CREATE A FORM # | # EDIT A FORM # | # BUILDER #</pattern>
    <template>
      <showcase target="builder-canvas"/>[cheerful] The Form Builder has three main zones: the Field Palette on the left to add questions, the drag-and-drop Canvas in the middle with full Undo and Redo, and Field Settings on the right for validation and conditional logic — plus Theme, Custom Screens, ZIPP Scripts, Flows, and Publish along the top bar!
      <reply>Take me on a tour</reply>
      <reply>What field types exist?</reply>
      <reply>How do scripts and conditional logic work?</reply>
    </template>
  </category>

  <category>
    <pattern># FIELD TYPE # | # FIELD TYPES # | # PALETTE # | # QUESTIONS # | # SIGNATURE # | # HIDDEN FIELD # | # LOCATION # | # GPS # | # FILE UPLOAD # | # PHONE FIELD #</pattern>
    <template>
      <showcase target="builder-palette"/>[nod] FormLogic includes 23 field types for every workflow: Short and Long Text, Email, international E.164 Phone with country picker, Number, URL, Dropdown, Multiple Choice, Checkboxes, Rating, Scale, Date, Time, Date and Time, Linked Records, Calculated fields, Hidden fields, File Uploads, Signatures, GPS Location, plus Welcome, Statement, and Thank-You screens!
      <reply>How do linked records work?</reply>
      <reply>How do calculated fields work?</reply>
      <reply>How do scripts and conditional logic work?</reply>
    </template>
  </category>

  <category>
    <pattern># CALCULATED # | # FORMULA # | # FORMULAS # | # EXPRESSION # | # EXPRESSIONS #</pattern>
    <template>
      <showcase target="builder-properties"/>[smile] Calculated fields compute live totals, scores, dates, or formatted strings as respondents type — running safely inside FormLogic's deterministic ZIPP WebAssembly sandbox both in the browser and on the server!
      <reply>How do scripts and conditional logic work?</reply>
      <reply>What is ZIPP?</reply>
    </template>
  </category>

  <category>
    <pattern># CONDITIONAL # | # LOGIC # | # BRANCHING # | # SKIP LOGIC # | # VALIDATION # | # SCRIPT # | # SCRIPTS # | # ONSUBMIT # | # ZIPP #</pattern>
    <template>
      <showcase target="builder-properties"/>[thumbsup] You can add conditional show-or-hide rules and validation directly in Field Settings, or write custom form scripts in JavaScript or Python! Every expression and script runs inside ZIPP — a fast, sandboxed WebAssembly VM with strict instruction budgets so untrusted code can never escape or hang the browser.
      <reply>How do calculated fields work?</reply>
      <reply>What can Flows automate?</reply>
    </template>
  </category>

  <category>
    <pattern># FOCUSED MODE # | # CLASSIC MODE # | # PROGRESS BAR # | # SINGLETON # | # SINGLE RECORD # | # FORM SETTINGS # | # KEYBOARD SHORTCUT # | # SHORTCUTS # | # VERSION HISTORY #</pattern>
    <template>
      <showcase target="builder-toolbar"/>[nod] Open Settings in the Form Builder toolbar to toggle between Focused one-question-at-a-time mode and Classic single-page mode, configure progress bars, notifications, or singleton single-record forms. You also get full Undo and Redo with Ctrl+Z, Version History snapshots, and keyboard shortcuts!
      <reply>How do I publish or share a form?</reply>
      <reply>How do custom screens work?</reply>
    </template>
  </category>

  <category>
    <pattern># PUBLISH # | # SHARE # | # EMBED # | # IFRAME # | # PUBLIC LINK # | # QR #</pattern>
    <template>
      <showcase target="builder-toolbar"/>[cheerful] Click Publish in the top bar to make your form or app live! Then click Share to copy its public link, generate an embeddable iframe snippet for any website, or restrict access strictly to signed-in app members and roles.
      <reply>How do roles and custom domains work?</reply>
      <reply>How do I export CSV, JSON, or SQLite?</reply>
    </template>
  </category>

  <!-- 5. App Studio, Custom Screens, Themes, Roles & Domains -->
  <category>
    <pattern># CREATE AN APP # | # BUILD AN APP # | # BUILD MY OWN APP # | # APP STUDIO # | # BUILD AN APP IN STUDIO #</pattern>
    <template>
      <showcase target="create-app"/>[smile] Click Create app to start a Forms app or a hosted SoftN app. App Studio walks you cleanly through five steps: Overview, Data and Forms, Screens and Home Dashboard, Access and Members, and Review and Publish!
      <reply>How do custom screens work?</reply>
      <reply>How do I customize my app icon and theme?</reply>
      <reply>How do roles and custom domains work?</reply>
    </template>
  </category>

  <category>
    <pattern># CUSTOM SCREEN # | # CUSTOM SCREENS # | # HOME STUDIO # | # APP HOME # | # SCREEN STUDIO #</pattern>
    <template>
      <showcase target="studio-nav"/>[thumbsup] Custom Screens let you craft bespoke React interfaces, interactive calculators, or app home pages right inside FormLogic! They compile in-browser with esbuild-wasm and run inside zero-egress sandboxed iframes wired securely to your form records via the FormLogic SDK.
      <reply>How do dashboards and charts work?</reply>
      <reply>How do SoftN apps and forms work together?</reply>
    </template>
  </category>

  <category>
    <pattern># ICON # | # THEME # | # APPEARANCE # | # CUSTOMIZE MY APP # | # BRANDING # | # ACCENT COLOR # | # FONT # | # DARK MODE # | # LIGHT MODE #</pattern>
    <template>
      <showcase target="app-icon-picker"/>[nod] In App Settings under Appearance, pick a custom Lucide icon, upload or link a logo, choose your accent color with a live WCAG light-and-dark contrast checker, select typography, and customize the sign-in screen. You can also switch FormLogic itself between Light and Dark mode anytime from the header or Workspace Settings!
      <reply>How do menu links and navigation work?</reply>
      <reply>How do roles and custom domains work?</reply>
    </template>
  </category>

  <category>
    <pattern># MENU # | # MENU LINK # | # MENU LINKS # | # NAVIGATION # | # HIDE NAV # | # STARTING SCREEN # | # SIDEBAR #</pattern>
    <template>
      <showcase target="app-settings-tabs"/>[smile] Under App Settings then Navigation, choose your app's starting screen, hide the sidebar for full-screen custom apps, or add custom Menu Links pointing to internal routes like records, reports, or form IDs — or external HTTPS URLs. You can even drag the workspace sidebar dock to the left, right, top, bottom, or floating mode!
      <reply>How do I customize my app icon and theme?</reply>
      <reply>How do roles and custom domains work?</reply>
    </template>
  </category>

  <category>
    <pattern># ROLE # | # ROLES # | # PERMISSION # | # PERMISSIONS # | # MEMBERS # | # INVITE # | # CUSTOM DOMAIN # | # CUSTOM DOMAINS # | # PWA # | # OFFLINE #</pattern>
    <template>
      [nod] Every app has fine-grained role permissions — control who can submit forms, view only their own submissions, edit all records, or export spreadsheets. Invite members by link or email, point a custom domain straight to your app with its own white-label sign-in and PWA manifest, and even queue form submissions offline with automatic Background Sync!
      <reply>How do I connect a shared SQLite database?</reply>
      <reply>How do external API keys work?</reply>
    </template>
  </category>

  <!-- 6. Data, Linked Records, Charts, Reports & Exports -->
  <category>
    <pattern># LINKED RECORD # | # LINKED RECORDS # | # RELATIONS # | # RELATIONSHIPS # | # FOREIGN KEY # | # LOOKUP #</pattern>
    <template>
      [nod] Linked Record fields create real relationships between forms — like connecting Invoices to Customers, Jobs to Technicians, or Bookings to Spaces. FormLogic automatically renders searchable pickers, resolves display names across tables, and lets you drill into related records!
      <reply>How do dashboards and charts work?</reply>
      <reply>How do I export CSV, JSON, or SQLite?</reply>
    </template>
  </category>

  <category>
    <pattern># DASHBOARD # | # DASHBOARDS # | # CHART # | # CHARTS # | # REPORT # | # REPORTS # | # ANALYTICS # | # WIDGET # | # WIDGETS #</pattern>
    <template>
      [thumbsup] Every Form App and Form comes with live interactive Recharts analytics, KPI counters, bar and breakdown charts, and Saved Reports! Clicking any bar or slice drills directly down into the filtered records table for that exact category or date bucket.
      <reply>How do I export CSV, JSON, or SQLite?</reply>
      <reply>How do linked records work?</reply>
    </template>
  </category>

  <category>
    <pattern># EXPORT # | # IMPORT # | # CSV # | # JSON # | # DOWNLOAD SQLITE # | # SPREADSHEET #</pattern>
    <template>
      [thumbsup] From any form's Responses or Analytics view, click Export to download a CSV spreadsheet (either all rows or just your currently filtered view!), developer JSON, or the complete portable SQLite database file. You can also bulk-import CSV rows straight into any form!
      <reply>How do private encrypted forms work?</reply>
      <reply>How do backups and encryption work?</reply>
    </template>
  </category>

  <!-- 7. Flows, Automations, Diagrams & Blueprints -->
  <category>
    <pattern># FLOW # | # FLOWS # | # AUTOMATION # | # AUTOMATIONS # | # TRIGGER # | # TRIGGERS # | # WEBHOOK # | # WEBHOOKS # | # SCHEDULE # | # CRON #</pattern>
    <template>
      <showcase target="flows-canvas"/>[cheerful] Visual Flows connect form submissions, incoming webhooks, schedules, HTTP requests, ZIPP JavaScript or Python code nodes, AI prompts, cross-app calls, and sub-flows! Flows can run in the cloud or locally on OAIY Desktop, with full run history and automatic webhook retries.
      <reply>How do Blueprints and Diagrams work?</reply>
      <reply>What are OAIY Desktop and Aokie?</reply>
      <reply>How do external API keys work?</reply>
    </template>
  </category>

  <category>
    <pattern># DIAGRAM # | # DIAGRAMS # | # BLUEPRINT # | # BLUEPRINTS # | # SKETCH #</pattern>
    <template>
      [smile] Blueprints and Diagrams let you visually sketch your forms, apps, relationships, and automations on an interactive canvas — and then materialize that architecture directly into working FormLogic resources!
      <reply>What can Flows automate?</reply>
      <reply>How does Site AI chat work?</reply>
    </template>
  </category>

  <!-- 8. Site AI Chat, MCP, OAIY Desktop & Aokie -->
  <category>
    <pattern># SITE AI # | # AI CHAT # | # CHAT WIDGET # | # FOLLOW AI # | # CO-CREATION # | # AI ASSISTANT #</pattern>
    <template>
      [cheerful] Click the round AI Chat icon (you can drag it anywhere on screen too!) to chat with FormLogic's AI builder! It can create forms, add fields, design dashboards, build SoftN apps, and wire flows — with optional Follow AI navigation, a docked side-by-side co-creation rail, image attachments, and your choice of Site AI, OAIY local AI, or custom providers.
      <reply>How do API keys and MCP work?</reply>
      <reply>What are OAIY Desktop and Aokie?</reply>
    </template>
  </category>

  <category>
    <pattern># API # | # API KEY # | # API KEYS # | # MCP # | # CLAUDE # | # CHATGPT # | # EXTERNAL API # | # BEARER # | # OAUTH #</pattern>
    <template>
      [thumbsup] Open Settings then Security to mint scoped Bearer API keys — like apps:invoke to call hosted SoftN backends, flows:run to trigger automations, and forms or responses scopes. For AI tools like Claude or ChatGPT, connect straight to FormLogic's OAuth 2.1 MCP endpoint at /api/mcp so your AI assistant can inspect and build safely with your approval!
      <reply>How does Site AI chat work?</reply>
      <reply>What can Flows automate?</reply>
    </template>
  </category>

  <category>
    <pattern># AOKIE # | # PHONE RECEPTIONIST # | # RECEPTIONIST # | # CALLS # | # VOICE CALL #</pattern>
    <template>
      <showcase target="aokie"/>[wave] Aokie is FormLogic's local AI phone receptionist! It answers incoming calls using your local OAIY Desktop setup, logs structured call records straight into FormLogic forms, and triggers follow-up flows like SMS confirmations or appointment scheduling automatically.
      <reply>What is OAIY Desktop?</reply>
      <reply>What can Flows automate?</reply>
    </template>
  </category>

  <category>
    <pattern># OAIY # | # DESKTOP # | # LOCAL AI # | # OLLAMA # | # TUNNEL # | # PAIRED # | # LINKED DESKTOP #</pattern>
    <template>
      <showcase target="desktop"/>[nod] OAIY Desktop pairs your computer with your FormLogic account over an encrypted bridge! It lets your workspace run local LLMs privately, access local files or hardware connectors, power Aokie, and execute headless background flows right on your own machine.
      <reply>What is Aokie?</reply>
      <reply>How do API keys and MCP work?</reply>
    </template>
  </category>

  <!-- 9. Security, Privacy, E2EE, Backups & Self-Hosting -->
  <category>
    <pattern># ENCRYPT # | # ENCRYPTED # | # ENCRYPTION # | # PRIVATE FORM # | # PRIVATE FORMS # | # VAULT # | # E2EE # | # LIBSODIUM #</pattern>
    <template>
      [nod] Private Forms use client-side libsodium end-to-end encryption! Answers are sealed in the respondent's browser before upload so the server only ever sees ciphertext, and only your unlocked Encryption Vault can decrypt records or decrypted CSV exports. On the server side, FormLogic also encrypts stored records, 2FA, and webhook secrets at rest!
      <reply>How do backups and encryption work?</reply>
      <reply>Can I self-host FormLogic?</reply>
    </template>
  </category>

  <category>
    <pattern># BACKUP # | # BACKUPS # | # RESTORE # | # RECYCLE BIN # | # TRASH # | # AUDIT # | # 2FA # | # TWO FACTOR # | # SECURITY #</pattern>
    <template>
      [thumbsup] FormLogic includes full-workspace account Backup and Restore zips (with optional passphrase sealing), sealed nightly server backups, a 30-day Recycle Bin for deleted apps, forms, and flows, a cryptographic tamper-evident Audit Trail verifier, and Two-Factor Authentication — all managed right in Settings!
      <reply>How do private encrypted forms work?</reply>
      <reply>Can I self-host FormLogic?</reply>
    </template>
  </category>

  <category>
    <pattern># SELF HOST # | # SELF-HOST # | # SELF HOSTING # | # PRICING # | # COST # | # FREE # | # INSTALL # | # DOCKER # | # UBUNTU # | # APACHE # | # NGINX # | # DOCTOR #</pattern>
    <template>
      <showcase target="pricing"/>[thumbsup] FormLogic is free to start in the cloud and completely self-hostable on standard Linux servers with PHP 8.2+, MySQL, and Node.js 24+ behind Apache or Nginx! Platform admins get a built-in Doctor health dashboard checking encryption, sealed backups, LibreOffice conversion, cron workers, and dual-store SQLite consistency.
      <reply>How do backups and encryption work?</reply>
      <reply>Take me on a tour</reply>
    </template>
  </category>

  <!-- 9b. Database Schema & Batch Data Import -->
  <category>
    <pattern># IMPORT DATABASE # | # IMPORT AN EXISTING DATABASE # | # MIGRATE DATABASE # | # MYSQL # | # POSTGRES # | # POSTGRESQL # | # MSSQL # | # SQL SERVER # | # PRISMA # | # LOCAL BRIDGE # | # BATCH IMPORT # | # BRING DATA #</pattern>
    <template>
      <showcase target="db-import-workspace"/>[thumbsup] Open Import database under More tools in the sidebar to bring existing MySQL, PostgreSQL, SQL Server (MSSQL), SQLite, Oracle, or Prisma schemas into FormLogic CRUD forms! Paste or drop SQL dumps, .sqlite/.db files, CSVs, or ZIPs parsed 100 percent in your browser — or run our tiny 127.0.0.1 local bridge to browse local databases right on your computer without sending credentials to FormLogic. Both explicit and auto-matched foreign keys become searchable linked_record select boxes, and rows upload in pauseable batches with automatic parent-first ID remapping!
      <reply>How do linked records work?</reply>
      <reply>Take me on a tour</reply>
    </template>
  </category>

  <!-- 9c. Large Multi-Section Forms, Portable .json Save/Resume & Zero-Account AI MCP Filling -->
  <category>
    <pattern># BIG FORM # | # LARGE FORM # | # MEDICAL FORM # | # HOSPITAL # | # PATIENT INTAKE # | # SECTIONS # | # SECTION # | # SAVE PROGRESS # | # RESUME # | # SAVE JSON # | # LOAD JSON # | # FILL WITH AI # | # PUBLIC MCP # | # DEVICE LOGIN # | # WITHOUT ACCOUNT #</pattern>
    <template>
      [thumbsup] FormLogic supports large multi-section forms up to 500 fields — including a ready-made 6-section Hospital Patient Intake template! Add Section dividers in the Form Builder to get an automatic sticky section outline, Previous/Next section paging, browser auto-save, and portable Save .json / Load .json progress files you can pause and re-import anytime. Even better, respondents can click Fill with AI (MCP) on any published public form to let an AI inspect sections, save a reviewable draft link, or submit on their behalf with zero account required — and the AI can even sign in to a FormLogic account via start_mcp_login and /oauth/device approval!
      <reply>How does MCP work?</reply>
      <reply>What field types exist?</reply>
    </template>
  </category>

  <!-- 10. Interactive Guide (bot.computer) Controls, Moving, Hiding & Fun -->
  <category>
    <pattern># MOVE YOU # | # DRAG YOU # | # HIDE YOU # | # TURN OFF # | # DISMISS # | # IN THE WAY # | # CLOSE YOU #</pattern>
    <template>
      [smile] You're always in charge! Drag me — or drag my chat box — anywhere on the screen with your mouse or finger to move us out of your way, and I'll remember where you put me. To hide me completely, click the X button right below me or the bot icon in the top header. You can drag the round AI Chat icon anywhere on screen too!
      <reply>How do I customize you?</reply>
      <reply>Take me on a tour</reply>
    </template>
  </category>

  <category>
    <pattern># BOT.COMPUTER # | # WHO ARE YOU # | # CUSTOMIZE YOU # | # CHANGE YOUR LOOK # | # CHANGE VOICE # | # AVATAR # | # 3D # | # 2D # | # FULL BODY #</pattern>
    <template>
      <showcase target="settings-guide"/>[wave] I'm powered by bot.computer — an open-source 2D and 3D speaking companion with browser-local 200 Hz WebAssembly lip-synced voice and AIML 2.0 rules! Click my Customize button to change my hair, outfit, or glasses, or open Settings then Workspace to pick from six characters, switch 3D or 2D, choose Full body or Upper body, mute speech, or add your own AIML rules!
      <reply>How do I move or hide you?</reply>
      <reply>Take me on a tour</reply>
    </template>
  </category>

  <category>
    <pattern># THANK # | # THANKS # | # AWESOME # | # COOL # | # NICE #</pattern>
    <template>
      <random>
        <li>[cheerful] You're so welcome! Let me know whenever you want a tour or have another FormLogic question.</li>
        <li>[smile] Happy to help! Drag me aside anytime, or ask me about any feature you're exploring.</li>
        <li>[thumbsup] Anytime! Have fun building with FormLogic!</li>
      </random>
    </template>
  </category>

  <!-- Helpful synonym shortcuts via SRAI -->
  <category>
    <pattern>HOW DO FORMS AND APPS CONNECT</pattern>
    <template><srai>HOW DO SOFTN APPS AND FORMS WORK TOGETHER</srai></template>
  </category>
  <category>
    <pattern>HOW DO I CONNECT A SHARED SQLITE DATABASE</pattern>
    <template><srai>SHARED SQLITE</srai></template>
  </category>
  <category>
    <pattern>HOW DO I SHARE SQLITE WITH FORMS</pattern>
    <template><srai>SHARED SQLITE</srai></template>
  </category>
  <category>
    <pattern>WHAT ARE OAIY DESKTOP AND AOKIE</pattern>
    <template><srai>OAIY DESKTOP</srai></template>
  </category>
  <category>
    <pattern>HOW DO I IMPORT OR EXPORT DATA</pattern>
    <template><srai>EXPORT CSV JSON SQLITE</srai></template>
  </category>
  <category>
    <pattern>HOW DO I CUSTOMIZE OR MOVE YOU</pattern>
    <template><srai>MOVE YOU</srai></template>
  </category>

  <!-- Friendly FormLogic-aware fallback when no specific pattern matches -->
  <category>
    <pattern>*</pattern>
    <template>
      [hmm] Great question! I might not have a specific rule for that phrasing yet, but I can walk you around this page or explain FormLogic's Form Builder, SoftN apps, shared SQLite, Flows, MCP, encryption, or self-hosting. Pick a topic below or ask another way!
      <reply>Take me on a tour</reply>
      <reply>What can you teach me?</reply>
      <reply>How do SoftN apps and forms work together?</reply>
      <reply>What can Flows automate?</reply>
    </template>
  </category>
${extraCategories ? `\n${extraCategories}\n` : ''}
</aiml>`;

  return {
    section,
    greeting: greetingForSection(section, botName),
    aimlXml,
    facts: {
      about: 'FormLogic turns structured forms into connected apps, hosted SoftN backends, shared SQLite databases, dashboards, and visual flows.',
      pricing: 'Free to start in the cloud and open to self-host on your own PHP, MySQL, and Node.js server.',
      website: typeof window !== 'undefined' ? window.location.origin : 'https://formlogic.com',
    },
  };
}
