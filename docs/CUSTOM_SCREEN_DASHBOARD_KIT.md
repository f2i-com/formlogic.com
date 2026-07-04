# Custom-Screen Dashboard Kit (LEGACY — sandboxed HTML/CSS/JS screens)

> ⚠️ **This is the legacy custom-code screen kit, not the current dashboard system.** App and form
> dashboards are now **no-code, host-rendered `recharts` widget grids** (`customScreen.kind:
> 'dashboard'`) — see **[WIDGET_DASHBOARD_DESIGN.md](WIDGET_DASHBOARD_DESIGN.md)**. This document
> covers the *sandboxed HTML/CSS/JS* custom screens (`customScreen.kind: 'code'`), which still exist
> as an advanced escape hatch (edited in the Studio, run in the SDK iframe). Reach for widget
> dashboards first; only use this kit for genuinely bespoke screens.
>
> **Editing agents:** if the task is a normal app dashboard/section screen, edit the widget dashboard,
> NOT this kit. Only touch a `kind: 'code'` screen when the design truly can't be a widget grid.
>
> Screen-kit CSP rule: custom screens are no-egress — **no remote images/fonts/media** (only
> `data:`/`blob:`), enforced by `SCREEN_CSP` in `ui/src/components/custom-screen/sdkRuntime.ts`.

> How the original pack dashboards (+ sample apps) were designed and verified. The kit below is
> duplicated verbatim into every code-screen pack's customScreen — edit a screen by editing its pack
> .ts, then: `node scripts/emit-marketplace.mjs` → `php scripts/provision-demo.php` (see below).

# FormLogic Default-App Dashboard Design Language — v2 (FINAL)

> Implementation kit: `screen-kit.ts.txt` in this directory — paste its CSS/JS lines VERBATIM at the
> top of the customScreen css/js arrays, then write app code in the same TS-string style. The kit is
> the single source of visual consistency across all 16 dashboards; do not fork or "improve" it.

## SDK quick reference (app screens)

- `await FL.context()` → `{appName, appSlug, forms:[{formId, displayName, fields}], colorScheme, accent}`
- `await FL.records(formId, {limit})` → `[{id, answers, submittedAt}]`, newest first, limit ≤ 500.
  `answers` keyed by field id; choice fields hold option VALUES (map via `optionMap`); linked_record
  answers hold the target response id (may be an array) — resolve via `nameMap`+`refName`.
- `await FL.currentUser()` → `{id,name,email}` or null.
- `FL.navigate(target)`: a formId → opens that form to fill; `'form/<formId>/responses'` → that
  form's records table (USE THIS for every "View all" link); `'records'` → records browser;
  `'reports'` → reports page. Wire via `data-nav` attributes + the kit's `wire()`.
- Rate limit: 60 `records` calls/min — fetch each form ONCE, reuse arrays. Use
  `Promise.all([recs(fA),recs(fB),…])` to load in parallel.
- Demo data: ~9–14 records/form; date fields span −30..+20 days, datetimes −20..+5 days, submittedAt
  spread over recent weeks. So: "Today" sections MUST fall back ("Today & upcoming", then latest N);
  weekly sparklines will have data; never render an empty centerpiece.

The 16 pack dashboards are the product's shop window: a visitor lands in the demo and the app home
screen must read instantly as "a real business app, professionally designed". Today every screen is
the same template (eyebrow → title → 5 equal stat boxes → two panels → emoji quick actions). The
redesign keeps one coherent system but gives every app an operational identity.

## Design thesis

**Lead with what needs attention now, not vanity stats.** Each dashboard opens with the domain's
operational centerpiece (today's schedule, the priority queue, the money ledger, the low-stock
list…), supported by a compact KPI lede and quiet secondary panels.

**Signature element — the Briefing.** Directly under the title, every dashboard composes a short,
human-readable status sentence from live data, e.g.
`3 open work orders · 2 due this week · $12,400 invoiced this month`.
One glance = the state of the business. This is FormLogic's recognizable device across all apps.

## Hard constraints (do not violate)

- All colors from the `--fl-*` palette (light/dark auto). NEVER hardcode dark/light colors.
  Accent tints via `color-mix(in srgb, var(--fl-accent) N%, transparent)`. Status = `--fl-good/warn/bad`.
- CSP: no external stylesheets, no fetch. Inline SVG OK. No webfonts — system stack only.
- Everything through the FL SDK; escape ALL data with `FL.escapeHtml` (alias `h()`).
- Mobile 360px+ without horizontal scroll; `prefers-reduced-motion` respected.
- Keep total css+js per screen lean (aim < 14KB each; pack cap applies).

## Type system (no webfonts — character from scale + spacing)

- Stack: `font-family:ui-sans-serif,-apple-system,"Segoe UI Variable Display","Segoe UI",Inter,Roboto,sans-serif;`
- Numerals: `font-variant-numeric:tabular-nums lining-nums;` on every stat/amount/count.
- Scale: hero value 30/800/-0.03em · page title 24/750/-0.02em · panel value 22/750
  · body 13.5/450 · secondary 12.5 · micro-label 11/650/+0.08em UPPERCASE (color --fl-muted).
- Section headers are micro-labels with a hairline rule filling the remaining width:
  `.sec{display:flex;align-items:center;gap:10px;margin:26px 0 12px;font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--fl-muted);}`
  `.sec::after{content:'';flex:1;height:1px;background:var(--fl-border);}`

## Layout grammar

1. **Header row** — accent glyph tile (36px, inline SVG domain icon on `color-mix(accent 14%)` bg,
   radius 10) + title + briefing line; primary CTA button right.
   Briefing: `.brief{margin-top:8px;font-size:13px;color:var(--fl-muted);}` clauses joined by
   `<span class="dot">·</span>` (`.dot{margin:0 7px;color:var(--fl-faint);}`), key numbers wrapped in
   `<b>` (`.brief b{color:var(--fl-text);font-weight:650;font-variant-numeric:tabular-nums;}`).
2. **KPI lede** — NOT five equal boxes. One hero KPI (larger, with 8-week sparkline or delta) +
   2–3 compact tiles: `grid-template-columns:1.55fr 1fr 1fr 1fr` (→2col ≤900px, →1/2col ≤620px).
3. **Operational centerpiece** — the domain module (see menu below), full-width or 2/3 + 1/3.
4. **Secondary panels** — breakdown bars, recent rows.
5. **Quick actions** — compact row of pill buttons with inline SVG icons (NO emoji anywhere).

## Surfaces & components

- Panel: `background:var(--fl-surface);border:1px solid var(--fl-border);border-radius:16px;box-shadow:var(--fl-shadow);padding:18px 20px;`
- Inset/track: `--fl-surface-2` / `--fl-track`. Hairline dividers only (`--fl-border`), no double borders.
- Badge pills: 10.5/700, padding 3px 9px, radius 999; tint = `color-mix(in srgb, <status> 15%, transparent)`, text = status color.
- Bars: 8px track radius 6; fill animates width 800ms cubic-bezier(.22,1,.36,1); value right-aligned tabular.
- Sparkline helper (JS): inline SVG polyline + area fill `color-mix(accent 12%)`, stroke accent 1.75.
- Icons: inline SVG, 24 viewBox, stroke=currentColor 1.75, round caps/joins, no fill. One glyph per
  domain for the header tile + small set for actions (plus, list, doc, calendar, user, chart…).
- Buttons: `.btn-primary` accent bg + `--fl-accent-contrast` text, radius 11, shadow
  `0 8px 22px -8px color-mix(accent 65%)`; `.btn-ghost` transparent, 1px border, text color.

## Motion (subtle, once, on load)

- Staggered reveal: sections `.reveal` fade-up 12px 480ms cubic-bezier(.22,1,.36,1), delay 40ms×n
  (inline `animation-delay`). Bars/sparklines draw after reveal.
- Stat count-up 600ms eased (JS), skipped under reduced motion.
- `@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}` and
  JS guard `matchMedia('(prefers-reduced-motion: reduce)').matches`.

## Domain module menu (pick per app)

- **Schedule strip / Today & upcoming** (clinic, salon, events, plumbing, workshop): date-grouped list
  with time, client, status pill. MUST degrade: if nothing today/upcoming, show latest N with dates —
  never an empty centerpiece.
- **Priority queue** (customer service, OHS incidents, property maintenance): rows ranked by
  severity/age, left 3px accent bar colored by severity, age chip ("3d").
- **Ledger** (finance, job/invoice): amount-first rows, tabular amounts right, status pill
  (paid/overdue), running total footer.
- **Stock watch** (inventory): items below reorder point, level vs reorder bar, "reorder" chip.
- **Pipeline** (HR, onboarding): stage columns/rows with counts + mini bar.
- **Days-since + ring** (safety): big counter with SVG progress ring vs target streak.

## Empty states

Warm, directive, never blank: icon (24 SVG, faint), one sentence of what will appear here, one
`+ Add …` link-button wired via `data-nav`. Hero KPI empty → show "—" + "No data yet · add your first X".

## Copy rules

Sentence case everywhere except micro-labels. Buttons name the action ("New invoice", not "Submit").
Numbers formatted with `toLocaleString`; currency via the app's own currency field conventions ($).
Briefing clauses are facts, not marketing.

## Per-app personality

Accent color stays from app theme. Personality comes from: choice of centerpiece module, the header
glyph, briefing clause selection, and section naming in the domain's vernacular ("Book of business",
"Bay schedule", "Days without incident"). NOT from divergent chrome.

## Pack-file integration rules (hard requirements)

1. Edit ONLY the `customScreen` blocks (html/css/js) of the assigned app(s). Never touch forms,
   roles, reports, theme, or any other pack content.
2. Keep the exact TS shape: `customScreen: { enabled: true, html: '…', css: [ …strings… ].join('\n'),
   js: [ …strings… ].join('\n') }`. CSS lines = single-quoted TS strings (double quotes inside);
   JS lines = double-quoted TS strings (single-quoted JS strings; HTML attributes as `\"`).
3. Kit lines first and VERBATIM (css + js), then app-specific lines. The html shell is the kit's.
4. Escape EVERY piece of record data with `h()` before it enters HTML. Numbers you computed are safe.
5. No emoji anywhere. No hex colors in app CSS/JS except the kit's `#fff` inside `--ax`
   (status colors = `var(--fl-good/warn/bad)`, accent = `var(--fl-accent)` / text-accent `var(--ax)`).
6. Section labels via `sec()`; panels via `panel(title, body, navTarget?)` — give every data panel a
   "View all" nav (`'form/'+f.formId+'/responses'`) when its form exists.
7. Quick actions: 4–6 `acts([{nav, label, icon}])` entries with kit icons (or new icons authored with
   `icoSvg` in the same 24-viewBox/1.75-stroke grammar). Labels name the action: "New invoice".
8. Every panel body must have an `emptyBlock(icon, message, navTarget, '+ Add …')` fallback when it
   has no data. The hero KPI shows 0 gracefully (sub: "No records yet").
9. Fetch all forms once via `Promise.all`, compute, build one `html` string, `root.innerHTML=html;
   wire(root);`. Keep total JS per screen under ~16KB, CSS additions under ~3KB.
10. The screen must look right at 360px wide (kit handles most; test your custom modules mentally),
    and in BOTH light and dark (only `--fl-*`/`--ax` colors guarantees this).

---

## The kit (paste-ready TS string lines)

```
// ═══════════════════════════════════════════════════════════════════════════
// FormLogic dashboard KIT v1 — paste these lines VERBATIM at the top of each
// customScreen's css/js arrays. Lines are already in pack-file TS string form
// (css lines single-quoted with double quotes inside; js lines double-quoted
// with single-quoted JS strings and \" for HTML attributes). Do NOT reformat.
// App-specific lines follow the kit in the same style.
// ═══════════════════════════════════════════════════════════════════════════

// ─── KIT CSS — the first entries of the `css: [ ... ].join('\n')` array ───
// NO @font-face — the kit is system-stack only (see the "No webfonts" CSP + Type-system rules
// above). A sandboxed screen's CSP blocks external font/stylesheet fetches anyway, so a webfont
// here would silently fail AND contradict the rules — don't add one.
':root{--ax:var(--fl-accent);}',
'html.fl-dark{--ax:color-mix(in srgb,var(--fl-accent) 62%,#fff);}',
'*{box-sizing:border-box;}html,body{margin:0;padding:0;}',
'body{font-family:ui-sans-serif,-apple-system,"Segoe UI Variable Display","Segoe UI",Inter,Roboto,sans-serif;-webkit-font-smoothing:antialiased;background:radial-gradient(1000px 320px at 12% -100px,color-mix(in srgb,var(--fl-accent) 7%,transparent),transparent) var(--fl-bg);}',
'.wrap{max-width:1120px;margin:0 auto;padding:28px 24px 64px;}',
'.num{font-variant-numeric:tabular-nums lining-nums;}',
':focus-visible{outline:2px solid var(--fl-accent);outline-offset:2px;border-radius:4px;}',
'.load{padding:90px 20px;text-align:center;color:var(--fl-muted);font-size:13.5px;}',
'.hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px;}',
'.hdr-l{display:flex;gap:14px;min-width:0;align-items:flex-start;flex:1;}',
'.glyph{width:40px;height:40px;flex:none;display:grid;place-items:center;border-radius:12px;color:var(--ax);background:color-mix(in srgb,var(--fl-accent) 12%,transparent);border:1px solid color-mix(in srgb,var(--fl-accent) 22%,transparent);}',
'.glyph svg{width:22px;height:22px;}',
'.title{margin:1px 0 0;font-size:24px;line-height:1.12;font-weight:750;letter-spacing:-0.02em;color:var(--fl-text);}',
'.brief{margin-top:7px;font-size:13px;line-height:1.55;color:var(--fl-muted);}',
'.brief b{color:var(--fl-text);font-weight:650;font-variant-numeric:tabular-nums;}',
'.brief .dot{margin:0 7px;color:var(--fl-faint);}',
'.hdr-r{display:flex;gap:10px;flex:none;align-items:center;padding-top:2px;}',
'.btn{appearance:none;cursor:pointer;border-radius:11px;padding:10px 16px;font-weight:650;font-size:13.5px;font-family:inherit;display:inline-flex;align-items:center;gap:8px;white-space:nowrap;transition:filter .15s ease,transform .06s ease,border-color .15s ease;}',
'.btn:active{transform:translateY(1px);}.btn svg{width:16px;height:16px;}',
'.btn-primary{border:0;background:var(--fl-accent);color:var(--fl-accent-contrast);box-shadow:0 8px 20px -10px color-mix(in srgb,var(--fl-accent) 70%,transparent);}.btn-primary:hover{filter:brightness(1.07);}',
'.btn-ghost{background:transparent;border:1px solid var(--fl-border);color:var(--fl-text);}.btn-ghost:hover{border-color:color-mix(in srgb,var(--fl-accent) 45%,transparent);}',
'.kpis{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;gap:14px;}',
'.kpi{background:var(--fl-surface);border:1px solid var(--fl-border);border-radius:16px;padding:16px 18px;box-shadow:var(--fl-shadow);min-width:0;display:flex;flex-direction:column;}.kpi:not(.kpi-hero){justify-content:center;}',
'.kpi-label{font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--fl-muted);}',
'.kpi-val{margin-top:7px;font-size:25px;font-weight:800;letter-spacing:-0.02em;line-height:1.05;color:var(--fl-text);font-variant-numeric:tabular-nums;}',
'.kpi-hero .kpi-val{font-size:33px;}',
'.kpi-sub{margin-top:5px;font-size:12px;color:var(--fl-faint);}.kpi-sub b{color:var(--fl-muted);font-weight:650;}',
'.kpi-spark{margin-top:auto;padding-top:10px;}.kpi-spark svg{display:block;width:100%;height:42px;}',
'.sec{display:flex;align-items:center;gap:10px;margin:24px 0 12px;font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--fl-muted);}',
'.sec::after{content:"";flex:1;height:1px;background:var(--fl-border);}',
'.grid{display:grid;gap:14px;align-items:start;}.g21{grid-template-columns:2fr 1fr;}.g12{grid-template-columns:1fr 2fr;}.g11{grid-template-columns:1fr 1fr;}.g111{grid-template-columns:1fr 1fr 1fr;}',
'.panel{background:var(--fl-surface);border:1px solid var(--fl-border);border-radius:16px;box-shadow:var(--fl-shadow);padding:16px 18px;min-width:0;}',
'.panel-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px;}',
'.panel-t{font-size:13.5px;font-weight:700;color:var(--fl-text);}',
'.panel-link{background:none;border:0;padding:0;cursor:pointer;font-family:inherit;font-size:12px;font-weight:650;color:var(--ax);}.panel-link:hover{text-decoration:underline;}',
'.rows{display:flex;flex-direction:column;}',
'.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--fl-border);}.row:first-child{border-top:0;padding-top:2px;}.rows .row:last-child{padding-bottom:2px;}',
'.row-main{min-width:0;flex:1;}',
'.row-title{font-size:13.5px;font-weight:600;color:var(--fl-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
'.row-sub{margin-top:2px;font-size:12px;color:var(--fl-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
'.row-r{text-align:right;flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:4px;}',
'.amt{font-size:13.5px;font-weight:700;color:var(--fl-text);font-variant-numeric:tabular-nums;}',
'.pill{display:inline-flex;align-items:center;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap;}',
'.chip{font-size:11.5px;font-weight:650;color:var(--fl-faint);white-space:nowrap;font-variant-numeric:tabular-nums;}',
'.bar-row{display:grid;grid-template-columns:minmax(90px,150px) 1fr 46px;align-items:center;gap:10px;padding:5px 0;}',
'.bar-name{font-size:12.5px;color:var(--fl-muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}',
'.bar-track{height:8px;border-radius:5px;background:var(--fl-track);overflow:hidden;}',
'.bar-fill{height:100%;width:0;border-radius:5px;background:var(--fl-accent);transition:width .9s cubic-bezier(.22,1,.36,1);}',
'.bar-val{font-size:12.5px;font-weight:700;color:var(--fl-text);text-align:right;font-variant-numeric:tabular-nums;}',
'.q-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;border:1px solid var(--fl-border);background:var(--fl-surface-2);margin-top:8px;position:relative;overflow:hidden;}',
'.q-row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--q,var(--fl-accent));}',
'.day{margin-top:14px;}.day:first-child{margin-top:0;}',
'.day-h{font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--fl-faint);padding-bottom:4px;}',
'.sch{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--fl-border);}',
'.sch-t{flex:none;width:58px;font-size:12.5px;font-weight:700;color:var(--ax);font-variant-numeric:tabular-nums;}',
'.acts{display:flex;flex-wrap:wrap;gap:10px;}',
'.act{display:inline-flex;align-items:center;gap:9px;background:var(--fl-surface);border:1px solid var(--fl-border);color:var(--fl-text);border-radius:12px;padding:10px 14px;cursor:pointer;font-family:inherit;font-weight:600;font-size:13px;transition:border-color .15s ease,transform .06s ease,box-shadow .15s ease;}',
'.act:hover{border-color:color-mix(in srgb,var(--fl-accent) 50%,transparent);box-shadow:var(--fl-shadow);}.act:active{transform:translateY(1px);}',
'.act svg{width:16px;height:16px;color:var(--ax);}',
'.empty{padding:22px 12px;text-align:center;color:var(--fl-muted);font-size:13px;line-height:1.5;}',
'.empty svg{width:22px;height:22px;color:var(--fl-faint);display:block;margin:0 auto 8px;}',
'.link-btn{background:none;border:0;padding:4px 0;color:var(--ax);cursor:pointer;font-family:inherit;font-weight:650;font-size:13px;}.link-btn:hover{text-decoration:underline;}',
'.reveal{opacity:0;transform:translateY(10px);animation:flin .55s cubic-bezier(.22,1,.36,1) forwards;}',
'@keyframes flin{to{opacity:1;transform:none;}}',
'@media (prefers-reduced-motion:reduce){.reveal{animation:none;opacity:1;transform:none;}.bar-fill{transition:none;}}',
'@media(max-width:960px){.kpis{grid-template-columns:1fr 1fr;}.g21,.g12,.g11,.g111{grid-template-columns:1fr;}}',
'@media(max-width:600px){.wrap{padding:20px 14px 48px;}.kpi-hero{grid-column:1/-1;}.kpis .kpi:last-child:nth-child(even){grid-column:1/-1;}.hdr-r{width:100%;flex-wrap:wrap;}.hdr-r .btn{flex:1;justify-content:center;}.bar-row{grid-template-columns:minmax(76px,110px) 1fr 40px;}.title{font-size:21px;}}',

// ─── KIT JS — the first entries of the `js: [ ... ].join('\n')` array ───
"var FL=window.FormLogic;",
"var RM=false;try{RM=window.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}",
"function h(v){return FL.escapeHtml(v==null?'':String(v));}",
"function num(v){var x=parseFloat(v);return isNaN(x)?0:x;}",
"function fmtInt(v){return num(v).toLocaleString();}",
"function mny(v,c){return (c||'$')+num(v).toLocaleString(undefined,{maximumFractionDigits:0});}",
"function mnyC(v,c){var x=num(v);if(Math.abs(x)>=1000000)return (c||'$')+(x/1000000).toFixed(1).replace(/\\.0$/,'')+'M';if(Math.abs(x)>=10000)return (c||'$')+Math.round(x/1000)+'k';return mny(x,c);}",
"function pd(s){if(!s)return null;var d=new Date(s);return isNaN(d.getTime())?null:d;}",
"function fmtDate(s){var d=pd(s);return d?d.toLocaleDateString(undefined,{month:'short',day:'numeric'}):'\\u2014';}",
"function fmtDateY(s){var d=pd(s);return d?d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'\\u2014';}",
"function sot(){var d=new Date();d.setHours(0,0,0,0);return d.getTime();}",
"function dayDiff(s){var d=pd(s);if(!d)return null;var x=new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();return Math.round((x-sot())/86400000);}",
"function ago(s){var dd=dayDiff(s);if(dd==null)return '';if(dd===0)return 'today';if(dd<0)return (-dd)+'d ago';return 'in '+dd+'d';}",
"function fmtTime(s){if(!s)return '';var m=String(s).match(/^(\\d{1,2}):(\\d{2})/);if(!m)return String(s);var hh=parseInt(m[1],10);var ap=hh>=12?'pm':'am';hh=hh%12;if(hh===0)hh=12;return hh+':'+m[2]+ap;}",
"function findForm(ctx,name){var t=String(name).toLowerCase();for(var i=0;i<ctx.forms.length;i++){if(String(ctx.forms[i].displayName||'').toLowerCase()===t)return ctx.forms[i];}return null;}",
"function optionMap(form,fieldId){var m={};if(!form||!form.fields)return m;for(var i=0;i<form.fields.length;i++){var f=form.fields[i];if(f.id===fieldId&&f.properties&&f.properties.options){var o=f.properties.options;for(var j=0;j<o.length;j++){m[o[j].value]=o[j].label;}}}return m;}",
"function labelFor(map,v){if(v==null||v==='')return '\\u2014';return map[v]||String(v);}",
"async function recs(form,limit){if(!form)return [];try{return await FL.records(form.formId,{limit:limit||500});}catch(e){return [];}}",
"function nameMap(records,fn){var m={};for(var i=0;i<records.length;i++){var r=records[i];m[r.id]=fn(r.answers||{},r)||'';}return m;}",
"function refName(map,v){if(v==null||v==='')return '';if(Array.isArray(v))v=v[0];return map[v]||'';}",
"function countBy(records,fieldId){var c={};for(var i=0;i<records.length;i++){var v=(records[i].answers||{})[fieldId];if(Array.isArray(v)){for(var k=0;k<v.length;k++){if(v[k]!=null&&v[k]!=='')c[v[k]]=(c[v[k]]||0)+1;}}else if(v!=null&&v!==''){c[v]=(c[v]||0)+1;}}return c;}",
"function sumBy(records,fieldId){var t=0;for(var i=0;i<records.length;i++){t+=num((records[i].answers||{})[fieldId]);}return t;}",
"function weekly(records,weeks){weeks=weeks||8;var out=[];for(var i=0;i<weeks;i++)out.push(0);var now=Date.now();for(var r=0;r<records.length;r++){var d=pd(records[r].submittedAt);if(!d)continue;var wk=Math.floor((now-d.getTime())/604800000);if(wk>=0&&wk<weeks)out[weeks-1-wk]++;}return out;}",
"function icoSvg(d){return '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">'+d+'</svg>';}",
"var I={};",
"I.plus=icoSvg('<path d=\"M12 5v14M5 12h14\"/>');",
"I.user=icoSvg('<circle cx=\"12\" cy=\"8\" r=\"3.5\"/><path d=\"M4.5 20.5c.7-3.4 3.7-5 7.5-5s6.8 1.6 7.5 5\"/>');",
"I.users=icoSvg('<circle cx=\"9\" cy=\"8.5\" r=\"3.25\"/><path d=\"M2.5 20c.6-3 3.2-4.5 6.5-4.5s5.9 1.5 6.5 4.5\"/><path d=\"M15.5 5.6a3.25 3.25 0 0 1 0 5.8M17.6 15.9c2 .6 3.5 1.9 3.9 4.1\"/>');",
"I.doc=icoSvg('<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5M9 13h6M9 17h4\"/>');",
"I.cal=icoSvg('<rect x=\"4\" y=\"5\" width=\"16\" height=\"15.5\" rx=\"2.5\"/><path d=\"M8 3v4M16 3v4M4 10.5h16\"/>');",
"I.clock=icoSvg('<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 7.5V12l3 2\"/>');",
"I.chart=icoSvg('<path d=\"M5 20v-7M11 20V6M17 20v-4\"/><path d=\"M3 20h18\"/>');",
"I.check=icoSvg('<path d=\"M4.5 12.5l4.7 4.7L19.5 6.9\"/>');",
"I.alert=icoSvg('<path d=\"M12 4 2.8 19.5h18.4z\"/><path d=\"M12 10v4M12 16.8h.01\"/>');",
"I.arrow=icoSvg('<path d=\"M5 12h14M13 6l6 6-6 6\"/>');",
"I.money=icoSvg('<path d=\"M12 2.5v19\"/><path d=\"M16.5 6H9.75a3.25 3.25 0 0 0 0 6.5h4.5a3.25 3.25 0 0 1 0 6.5H7\"/>');",
"I.box=icoSvg('<path d=\"M21 8.2 12 3 3 8.2v7.6L12 21l9-5.2z\"/><path d=\"M3.3 8.3 12 13.3l8.7-5M12 13.3V21\"/>');",
"I.wrench=icoSvg('<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z\"/>');",
"I.shield=icoSvg('<path d=\"M12 3l7.5 2.8v5.4c0 4.3-3 7.7-7.5 9-4.5-1.3-7.5-4.7-7.5-9V5.8z\"/>');",
"I.home=icoSvg('<path d=\"M4 11.5 12 4l8 7.5\"/><path d=\"M6 10v10h12V10\"/>');",
"I.tag=icoSvg('<path d=\"M3.5 11.3V4.5a1 1 0 0 1 1-1h6.8a1 1 0 0 1 .7.3l8.2 8.2a1.5 1.5 0 0 1 0 2.1l-6.1 6.1a1.5 1.5 0 0 1-2.1 0L3.8 12a1 1 0 0 1-.3-.7z\"/><circle cx=\"8\" cy=\"8\" r=\"1.25\"/>');",
"function spark(vals,w,hh){w=w||220;hh=hh||42;if(!vals||vals.length<2)return '';var mx=0,mn=Infinity;for(var i=0;i<vals.length;i++){if(vals[i]>mx)mx=vals[i];if(vals[i]<mn)mn=vals[i];}if(mx===0)return '';if(mn===mx)mn=0;var rng=mx-mn||1;var pts=[];for(var j=0;j<vals.length;j++){var x=2+(j/(vals.length-1))*(w-4);var y=(hh-5)-((vals[j]-mn)/rng)*(hh-12);pts.push(x.toFixed(1)+','+y.toFixed(1));}var line=pts.join(' ');return '<svg viewBox=\"0 0 '+w+' '+hh+'\" preserveAspectRatio=\"none\" aria-hidden=\"true\"><polygon points=\"2,'+(hh-2)+' '+line+' '+(w-2)+','+(hh-2)+'\" fill=\"color-mix(in srgb, var(--fl-accent) 12%, transparent)\" stroke=\"none\"/><polyline points=\"'+line+'\" fill=\"none\" stroke=\"var(--fl-accent)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>';}",
"function pill(text,kind){var c=kind==='good'?'var(--fl-good)':kind==='warn'?'var(--fl-warn)':kind==='bad'?'var(--fl-bad)':kind==='accent'?'var(--ax)':'var(--fl-muted)';var bg=(kind==='neutral'||!kind)?'var(--fl-track)':'color-mix(in srgb, '+c+' 15%, transparent)';return '<span class=\"pill\" style=\"color:'+c+';background:'+bg+'\">'+h(text)+'</span>';}",
"function kpi(label,val,sub,opts){opts=opts||{};var v=(typeof val==='number')?'<span data-count=\"'+val+'\">'+fmtInt(val)+'</span>':val;return '<div class=\"kpi'+(opts.hero?' kpi-hero':'')+'\"><div class=\"kpi-label\">'+h(label)+'</div><div class=\"kpi-val\">'+v+'</div>'+(sub?'<div class=\"kpi-sub\">'+sub+'</div>':'')+(opts.spark?'<div class=\"kpi-spark\">'+opts.spark+'</div>':'')+'</div>';}",
"function sec(label){return '<div class=\"sec\">'+h(label)+'</div>';}",
"function panel(title,body,nav,navLabel){return '<div class=\"panel\">'+(title?'<div class=\"panel-h\"><div class=\"panel-t\">'+h(title)+'</div>'+(nav?'<button class=\"panel-link\" data-nav=\"'+h(nav)+'\">'+h(navLabel||'View all')+'</button>':'')+'</div>':'')+body+'</div>';}",
"function barRow(label,count,max,color){var pct=max>0?Math.max(3,Math.round(count/max*100)):0;return '<div class=\"bar-row\"><span class=\"bar-name\" title=\"'+h(label)+'\">'+h(label)+'</span><div class=\"bar-track\"><div class=\"bar-fill\" data-pct=\"'+pct+'\" style=\"background:'+(color||'var(--fl-accent)')+'\"></div></div><span class=\"bar-val\">'+fmtInt(count)+'</span></div>';}",
"function breakdown(records,fieldId,map,opts){opts=opts||{};var counts=countBy(records,fieldId);var keys=Object.keys(map);for(var k in counts){if(keys.indexOf(k)===-1)keys.push(k);}var max=0,total=0;for(var i=0;i<keys.length;i++){var c=counts[keys[i]]||0;if(c>max)max=c;total+=c;}if(total===0)return '';keys.sort(function(a,b){return (counts[b]||0)-(counts[a]||0);});var out='';for(var j=0;j<keys.length;j++){var n2=counts[keys[j]]||0;if(n2===0)continue;out+=barRow(labelFor(map,keys[j]),n2,max,opts.color);}return out;}",
"function rowItem(title,sub,right){return '<div class=\"row\"><div class=\"row-main\"><div class=\"row-title\">'+title+'</div>'+(sub?'<div class=\"row-sub\">'+sub+'</div>':'')+'</div>'+(right?'<div class=\"row-r\">'+right+'</div>':'')+'</div>';}",
"function qRow(color,title,sub,right){return '<div class=\"q-row\" style=\"--q:'+color+'\"><div class=\"row-main\"><div class=\"row-title\">'+title+'</div>'+(sub?'<div class=\"row-sub\">'+sub+'</div>':'')+'</div>'+(right?'<div class=\"row-r\">'+right+'</div>':'')+'</div>';}",
"function emptyBlock(ic,msg,nav,cta){return '<div class=\"empty\">'+(ic||'')+h(msg)+(nav?'<div><button class=\"link-btn\" data-nav=\"'+h(nav)+'\">'+h(cta||'+ Add one')+'</button></div>':'')+'</div>';}",
"function acts(items){var out='<div class=\"acts\">';for(var i=0;i<items.length;i++){var it=items[i];if(!it||!it.nav)continue;out+='<button class=\"act\" data-nav=\"'+h(it.nav)+'\">'+(it.icon||I.plus)+'<span>'+h(it.label)+'</span></button>';}out+='</div>';return out;}",
"function brief(clauses){var cs=[];for(var i=0;i<clauses.length;i++){if(clauses[i])cs.push(clauses[i]);}return cs.join('<span class=\"dot\">\\u00b7</span>');}",
"function headerBlock(glyph,titleText,briefHtml,ctas){var out='<div class=\"hdr\"><div class=\"hdr-l\"><div class=\"glyph\">'+glyph+'</div><div style=\"min-width:0\"><h1 class=\"title\">'+h(titleText)+'</h1>'+(briefHtml?'<div class=\"brief\">'+briefHtml+'</div>':'')+'</div></div>';if(ctas&&ctas.length){out+='<div class=\"hdr-r\">';for(var i=0;i<ctas.length;i++){var c2=ctas[i];if(!c2||!c2.nav)continue;out+='<button class=\"btn '+(c2.ghost?'btn-ghost':'btn-primary')+'\" data-nav=\"'+h(c2.nav)+'\">'+(c2.icon||'')+'<span>'+h(c2.label)+'</span></button>';}out+='</div>';}out+='</div>';return out;}",
"function countUp(el){var target=parseFloat(el.getAttribute('data-count'));if(isNaN(target)||target<=0)return;var t0=null,dur=700;function step(ts){if(t0===null)t0=ts;var p=Math.min(1,(ts-t0)/dur);var e=1-Math.pow(1-p,3);el.textContent=Math.round(target*e).toLocaleString();if(p<1)requestAnimationFrame(step);}requestAnimationFrame(step);}",
"function wire(root){var nav=root.querySelectorAll('[data-nav]');for(var i=0;i<nav.length;i++){(function(el){el.addEventListener('click',function(){var t=el.getAttribute('data-nav');if(t)FL.navigate(t);});})(nav[i]);}var kids=root.querySelectorAll('.wrap > *');for(var k2=0;k2<kids.length;k2++){kids[k2].classList.add('reveal');kids[k2].style.animationDelay=(Math.min(k2,8)*60)+'ms';}requestAnimationFrame(function(){requestAnimationFrame(function(){var f=root.querySelectorAll('.bar-fill');for(var j2=0;j2<f.length;j2++){f[j2].style.width=(f[j2].getAttribute('data-pct')||0)+'%';}});});if(!RM){var cs2=root.querySelectorAll('[data-count]');for(var m2=0;m2<cs2.length;m2++){countUp(cs2[m2]);}}}",
"function fatal(root,msg){root.innerHTML='<div class=\"wrap\"><div class=\"load\">'+h(msg)+'</div></div>';}",

// ─── HTML shell (replace the app's customScreen.html with exactly this) ───
// html: '<div id="app"><div class="wrap"><div class="load">Loading dashboard…</div></div></div>',

// ─── After the kit, app code follows this skeleton (same TS string style) ───
// "async function main(){",
// "  var root=document.getElementById('app');",
// "  var ctx;try{ctx=await FL.context();}catch(e){return fatal(root,'Could not load this dashboard.');}",
// "  var user=null;try{user=await FL.currentUser();}catch(e){}",
// "  var fX=findForm(ctx,'<Form Display Name>');",
// "  var xs=await recs(fX);",   // parallelize independent fetches with Promise.all if 3+ forms
// "  ...compute metrics...",
// "  var html='<div class=\"wrap\">';",
// "  html+=headerBlock(GLYPH,ctx.appName||'<fallback>',brief([...]),[{nav:fX?fX.formId:'',label:'New X',icon:I.plus}]);",
// "  html+='<div class=\"kpis\">'+kpi(...)+kpi(...)+'</div>';",
// "  html+=sec('...')+'<div class=\"grid g21\">'+panel(...)+panel(...)+'</div>';",
// "  html+=sec('Quick actions')+acts([...]);",
// "  html+='</div>';root.innerHTML=html;wire(root);",
// "}",
// "main();",
```

## Verification pipeline

1. `cd form-builder/ui && node <checker> src/data/packs/<pack>.ts` — syntax (new Function), no emoji, no hardcoded hex, wire()/data-nav present. The checker script lives inline in the repo history (commit 166ea8a tooling) and is trivial to recreate: esbuild-bundle the pack, `new Function(customScreen.js)`, regex policy checks.
2. `node scripts/emit-marketplace.mjs` (ui/) → `php scripts/provision-demo.php` (backend/; `RESEED_DEMO=1` to regenerate data).
3. Screenshot every demo app (manifest: backend/storage/pack-screenshots/manifest.json) at 1360px light+dark and 390px mobile; POST /api/demo/start mints the session (re-mint on "Sign in to continue" — the shared demo user can trip rate limits mid-burst).
4. Marketplace thumbnails: `THEME=light node scripts/capture-pack-shots.mjs` (writes backend/resources/pack-screenshots, committed).
