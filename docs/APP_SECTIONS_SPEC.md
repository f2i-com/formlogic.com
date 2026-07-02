# App Section Screens — Spec & Plan

Every marketplace app gets a **custom screen per form ("section")**, so opening a section inside an
app (or its public link) shows a themed mini-dashboard for that section's data — with an optional,
runtime-provided **"New record"** action that opens the real form. This document specs what each
app does, what each section screen shows, and the mechanics that make it work.

## Mechanics (shipped alongside this spec)

- `customScreen.allowNewResponses?: boolean` on forms. When a form's screen is enabled and this is
  true, the viewer can still submit records: the runtime overlays a **"+ New <form>"** button on
  the screen (public link AND app runtime), which reveals the normal form; a back control returns
  to the screen. Screens can also trigger it themselves via the new `FormLogic.openForm()` SDK
  call (no-ops with a toast when the toggle is off).
- The form-scoped screen runtime now injects the same `--fl-*` light/dark palette + theme shim the
  app-home runtime gets (accent = the app accent inside an app, else the form theme's primary), so
  section screens are built on tokens and theme-flip automatically.
- The Custom Screen Studio (form) exposes the toggle ("Allow new records while the screen is shown").
- Packs ship per-form screens: `PackForm.customScreen` (typed; import already supported server-side),
  export round-trips it, and demo provisioning refreshes form screens in place (scoped per pack
  installation so duplicate titles across packs can't cross-contaminate).

## Section screen template (kit-based, form-scoped SDK only)

Header glyph + section title + live briefing (2–3 clauses) · 3 KPI tiles (records total + two
domain KPIs) · one breakdown (most meaningful choice field) or schedule/queue module · recent
rows (5–6, title = first text field, sub = choice label · date, money right-aligned) · a "New
record" pill wired to `FormLogic.openForm()`. Empty states with a CTA. `allowNewResponses: true`
on every pack section. JS budget ≤ ~10KB per screen (kit subset + section code).

Form-scoped SDK limits: `records({limit})` (this form only), `context()` → `{formId,title,fields}`,
`submit(answers)`, `currentUser()`, `escapeHtml`, `openForm()`. No cross-form data, no navigate.

## Per-app specs (purpose → section intents)

The authoritative form list is each pack file; sections not named here get the default template.

### Finance OS (US) — Client Onboarding Navigator + Advisor Transition Hub
Wealth-management back office: onboard clients, evidence suitability, move assets.
- **New Client Onboarding**: book roster — KPIs clients / accredited / total net worth; objectives breakdown; recent clients w/ accredited pill.
- **Risk Tolerance Questionnaire**: suitability desk — KPIs assessments / flagged (reg_bi_check) / avg score; portfolio-type breakdown.
- **Form CRS**: disclosure log — KPIs delivered / this month; recent acknowledgements.
- **Document Vault**: compliance files — KPIs on file / expiring 60d (warn); type breakdown; expiring list.
- **W-9 Form**: tax certs — KPIs on file / this quarter; classification breakdown.
- **Beneficiary Designation**: KPIs designations / this quarter; recent designations.
- **ACAT / Transfer**: assets-in-motion — KPIs transfers / $ in transit; custodian breakdown; recent transfers w/ amounts.
- **Annual Client Review**: review desk — KPIs reviews / due 45d (warn) / total AUM; upcoming reviews queue.
- **Fee Agreement**: KPIs agreements / $ under agreement; tier breakdown; recent w/ amounts.
- **1035 Exchange**: KPIs exchanges / $ value / surrender charges; type breakdown.
- **Rollover Form**: KPIs rollovers / $ moving; type breakdown; direct-vs-indirect split.

### Finance OS (AU) — Client Onboarding (AU) + Portfolio Management Hub (AU)
AFSL advisory workflow (FSG/TFN/BDBN, super, platforms).
- **New Client Onboarding**: KPIs clients / wholesale / net assets total; objectives breakdown.
- **Risk Profile Assessment**: KPIs profiles / avg score; recommended-profile breakdown.
- **FSG Acknowledgement**: KPIs signed / this month; recent list.
- **Document Vault**: same pattern as US vault (SoA/PDS types).
- **TFN Declaration**: KPIs declarations / residency breakdown.
- **Binding Death Benefit Nomination**: KPIs nominations / lapsing soon if dated; relationship breakdown.
- **Off-Market Transfer**: KPIs transfers / $ value; platform breakdown.
- **Annual Client Review**: KPIs reviews / due 60d / portfolio value total; upcoming queue.
- **Fee Disclosure Statement**: KPIs agreements / FUA total; fee-type breakdown.
- **Superannuation Rollover**: KPIs rollovers / $ balance; preservation breakdown.

### OHS & Quality — Safety Management + Quality & Compliance
ISO 45001/9001 site safety + QMS.
- **Incident Report**: incident log — KPIs incidents / high+critical (bad) / days since last; severity breakdown; recent incidents.
- **Injury Record**: KPIs injuries / lost-time (bad); injury-type breakdown.
- **Hazard Identification**: KPIs hazards / open; type breakdown (risk_level is computed → fall back to hazard_type).
- **Action Items**: action queue — KPIs actions / overdue (bad) / due 7d (warn); overdue-first queue.
- **Meetings & Toolbox Talks**: KPIs meetings / this month; type breakdown.
- **Plant & Equipment**: KPIs assets / service due 30d (warn); category breakdown.
- **Contractor Approval**: KPIs contractors / approvals expiring 60d; induction status split.
- **Training Records**: KPIs records / expiring 60d (warn) / failed (bad); recent list.
- **Audit Reports**: KPIs audits / major+critical findings (warn); type breakdown.
- **Corrective Actions (CAR)**: queue — KPIs open / overdue; priority breakdown.
- **Non-Conformances (NCR)**: KPIs NCRs / critical (bad); disposition breakdown.
- **Complaints**: KPIs complaints / high priority; source breakdown.

### HR & People — People Hub
Recruit → onboard → manage leave/expenses/reviews.
- **Job Application**: pipeline intake — KPIs applicants / this month; position breakdown; recent applicants.
- **Interview Scorecard**: KPIs interviews / recommend-hire share; recommendation breakdown.
- **Employee Onboarding**: KPIs onboarded / starting soon; department breakdown.
- **Leave Request**: KPIs requests / days requested / upcoming; type breakdown; upcoming list.
- **Performance Review**: KPIs reviews / avg rating; goals-met breakdown.
- **Expense Claim**: KPIs claims / $ total; category breakdown; recent w/ amounts.
- **Training Request**: KPIs requests / $ cost; type breakdown.
- **Exit Interview**: KPIs exits / avg satisfaction; reason breakdown.

### Event Management — Event Hub
Run an event end-to-end: attendance, program, vendors, budget.
- **Event Registration**: KPIs registered / this week; ticket-type breakdown; recent registrations.
- **Speaker Submission**: KPIs submissions / keynotes; presentation-type breakdown.
- **Vendor Application**: KPIs vendors / premium booths; booth-size breakdown.
- **Volunteer Signup**: KPIs volunteers / all-days available; availability breakdown.
- **Incident Log**: KPIs incidents / high+critical (bad); type breakdown.
- **Budget Tracker**: KPIs line items / estimated vs actual totals; over-budget categories flagged.
- **Post-Event Feedback**: KPIs responses / avg rating; would-attend-again breakdown.

### Customer Service — Service Desk
Ticketing + product feedback loop.
- **Support Ticket**: queue — KPIs open / urgent+high (bad) / this week; priority breakdown; oldest-first queue.
- **Bug Report**: KPIs bugs / critical (bad); product breakdown.
- **Feature Request**: KPIs requests / critical priority; impact distribution.
- **Escalations**: KPIs escalations / this week; reason breakdown.
- **Refund Request**: KPIs refunds / $ total; reason breakdown; recent w/ amounts.
- **Customer Feedback**: KPIs responses / avg CSAT / NPS mix; satisfaction distribution.
- **Knowledge Base**: KPIs articles / published share; category breakdown.

### Plumbing & Trades — Field Service
Jobs → site visits → invoices → parts.
- **Customers**: KPIs customers / this month; type breakdown; recent customers.
- **Jobs**: job board — KPIs open / this week / emergency (bad); status breakdown; upcoming schedule.
- **Site Visits**: KPIs visits / hours on site; follow-up-required count; recent visits.
- **Invoices**: ledger — KPIs invoiced $ / outstanding $ / overdue (bad); status breakdown; recent w/ amounts.
- **Parts Requests**: KPIs requests / on order; status breakdown.

### Job & Invoice — Billing Pipeline
Lead-to-cash for service businesses.
- **Clients**: KPIs clients / new this month; type breakdown.
- **Jobs**: pipeline — KPIs open / pipeline $; stage breakdown.
- **Quotes**: KPIs quotes / awaiting reply / $ quoted; status breakdown.
- **Invoices**: KPIs outstanding $ / overdue (bad) / paid $; status breakdown; attention list.
- **Payments**: KPIs collected $ / this month; method breakdown; recent payments.

### Salon & Beauty — Salon
Front-of-house booking book.
- **Clients**: KPIs clients / new this month; recent clients.
- **Services**: menu — KPIs services / avg price; category breakdown w/ prices.
- **Stylists**: team — KPIs stylists / taking bookings; role breakdown.
- **Appointments**: the book — KPIs today / this week / no-shows 30d (bad); status breakdown; today & upcoming schedule.
- **Product Sales**: retail — KPIs $ 30d / units; recent sales w/ amounts.

### Mechanic Workshop — Workshop
Bay operations.
- **Customers**: KPIs customers / fleet accounts; type breakdown.
- **Vehicles**: KPIs vehicles / avg year; fuel breakdown; recent vehicles (make·model·rego).
- **Job Cards**: bay board — KPIs in workshop / awaiting parts (warn) / ready (good); status breakdown; days-in queue.
- **Parts Used**: KPIs line items / $ cost; recent parts w/ quantities.
- **Invoices**: KPIs invoiced $ / unpaid $ / overdue (bad); status breakdown.

### Property Maintenance — Maintenance
Requests → work orders → inspections.
- **Properties**: portfolio — KPIs properties; type breakdown; recent additions.
- **Tenants**: KPIs tenants / new leases 90d; recent tenants w/ property.
- **Maintenance Requests**: queue — KPIs open / urgent (bad) / this week; category breakdown; priority queue.
- **Work Orders**: KPIs scheduled / this week / $ cost total; status breakdown; upcoming schedule.
- **Inspections**: KPIs inspections / avg condition; type breakdown; recent list.

### Clinic Intake — Front Desk
Reception operations (operational only, nothing clinical).
- **Patients**: KPIs patients / new 30d; recent registrations.
- **Providers**: KPIs providers / accepting appointments; role breakdown.
- **Appointments**: the schedule — KPIs today / upcoming 7d / no-shows 30d (bad); status breakdown; today & upcoming.
- **Intake Forms**: KPIs intakes / this week; contact-preference breakdown.
- **Follow-ups**: KPIs pending / overdue (bad); status breakdown; due-date queue.

### Inventory & POs — Inventory
Stock control.
- **Products**: catalog — KPIs SKUs / low stock (warn) / out (bad) / stock value $; category breakdown; low-stock list.
- **Suppliers**: KPIs suppliers / avg lead time; payment-terms breakdown.
- **Purchase Orders**: KPIs open / $ on order; status breakdown; expected-date list.
- **PO Line Items**: KPIs lines / $ total; recent lines w/ quantities.
- **Stock Movements**: KPIs movements 30d / net units; type breakdown; recent movements.

### Sales CRM (sample app)
Lightweight pipeline: contacts, deals, activities.
- **Contacts**: the book — KPIs contacts / new 30d; company mix (top companies as rows if free-text); recent contacts w/ email sub.
- **Deals**: pipeline — KPIs open pipeline $ / won $ / total deals; stage breakdown; recent deals w/ amounts + stage pills.
- **Activities**: touch log — KPIs activities / this week; type breakdown; recent activities.

### Expense Manager (sample app)
Claim → approve → track spend.
- **Expenses** (claims): KPIs spend 30d / awaiting approval (warn) / claims; category breakdown; recent claims w/ status pills + amounts.
- **Category Budgets** (if present): KPIs budgets / total monthly limit $; per-category limits as bars.

### People Onboarding & Compliance (sample app)
Roster + tasks + policy acknowledgements.
- **Employees**: roster — KPIs employees / new 30d; department breakdown; recent hires.
- **Onboarding Tasks**: task queue — KPIs tasks / completed share / overdue (bad); category breakdown; overdue-first queue.
- **Policy Acknowledgements**: compliance — KPIs acknowledgements / pending; policy breakdown; recent acks.

Sample-app note: their APP home screens stay multi-file TS; the per-form section screens use the
plain html/css/js string format inside the JSON (same import path as packs).

## New operational packs (2026-07)

15 packs for high-frequency small businesses; same kit, same mechanics. Full field/intent specs
live in each pack `.ts` (and scratchpad `pack-build/specs/*.md`).

### PawRoute — Dog Walking & Pet Care
Manage pets, clients, walkers, walks and incidents.
- **Pets** (roster): KPIs active pets / new / attention flags; species + temperament pills.
- **Clients** (book): KPIs clients / overdue billing (bad); billing-status breakdown.
- **Walks & Visits** (route board): KPIs today / this week / completion; Morning–Evening schedule lanes; service-type breakdown.
- **Team Members** (dispatch): KPIs active / walkers vs sitters; availability-day chips.
- **Incidents** (care alerts): KPIs open follow-ups / urgent; severity qRow stack; type breakdown.

### BrewDesk — Cafe & Barista Ops
Orders, barista queue, prep/stock, roster, daily close.
- **Cafe Orders** (service board): open orders / served today / takeaway share; status qRows.
- **Barista Queue** (coffee rail): in queue / ready / most-poured; milk breakdown.
- **Stock & Prep** (prep fridge): low/out / OK / freshness; par bars; category breakdown.
- **Staff Roster**: on today / baristas / opens; start-time schedule.
- **Daily Close** (ritual): last register $ / tips / closes; beans+milk usage bars.
- **Menu Items** (library): active / dietary-friendly / retired; station breakdown.

### GrillStack — Burger Shop Command Center
Orders, kitchen tickets, prep, shifts, daily close.
- **Orders** (counter board): live / rush (bad) / collected; big order-number qRows; status breakdown.
- **Kitchen Tickets** (the pass): on the pass / ready / held; station lanes w/ elapsed chips.
- **Prep & Stock** (station): low-out / OK / checked; par bars.
- **Staff Shifts** (crew): on shift / breaks / week; start-time schedule.
- **Daily Close** (checklist): last takings $ / draft / reviewed; payment-mix bars.
- **Menu Items** (board): active / combos / off-menu; prep-station breakdown.

### CounterFlow — Retail Store Operations
Products, suppliers, movements, tasks, staff, returns.
- **Products** (stock wall): active / at reorder (warn) / stock value $; low-stock list.
- **Stock Movements** (ledger): net 30d / deliveries / damage-returns; type breakdown.
- **Store Tasks** (board): open / blocked (bad) / done; To do–Blocked lanes; area breakdown.
- **Returns** (queue): open / resolved 30d / refund $; issue-type breakdown.
- **Suppliers** (directory): suppliers / avg lead time / net-30+; terms breakdown.
- **Staff** (team): active / managers / online cover; role breakdown.

### StayReady — Short-Stay Turnover
Properties, bookings, turnovers, inspections, supplies.
- **Turnovers** (today's board): today / issues (bad) / week; time schedule w/ linen chips.
- **Bookings** (timeline): in-house / arrivals 7d / 30d; platform breakdown.
- **Properties** (portfolio): live / paused / avg beds; type breakdown.
- **Inspections** (condition watch): follow-ups / avg rating / 30d; rating distribution.
- **Cleaners** (dispatch): active / coverage / areas; availability chips.
- **Supplies** (restock): low/out / OK / properties; par bars.

### RepairBench — Device Repair Shop
Customers, technicians, devices, repair jobs, parts, QA.
- **Repair Jobs** (bench queue): on bench / ready (good) / express (warn); status pipeline lanes; issue breakdown.
- **Devices** (registry): on file / phones vs laptops; type breakdown.
- **Parts Orders** (board): awaiting / backordered (bad) / received; ETA chips.
- **Quality Checks** (test bench): pass rate / fails / not notified; pass/fail bars.
- **Customers** (book): customers / new / phone-preferred; contact breakdown.
- **Technicians** (roster): active / skill cover / micro-solder; skill chips.

### PassMaster — Restaurant Kitchen & Table Service
Reservations, tables, kitchen tickets, prep, shift close.
- **Tables** (floor board): turning / open / needs reset (warn); stage-colored tiles; section breakdown.
- **Kitchen Tickets** (the pass): live / fired (bad) / served; course lanes w/ allergy pills.
- **Reservations** (the book): covers tonight / 7d / no-shows; party-size schedule.
- **Prep List** (board): not done / done / 86'd (bad); station completion bars.
- **Staff** (brigade): active / servers / kitchen; role breakdown.
- **Shift Close** (nightly): last sales $ / covers / voids; sales-by-close bars.

### CaterCraft — Catering & Event Orders
Clients, menu packages, jobs, production, delivery, dietary.
- **Catering Jobs** (pipeline): confirmed+prep / pipeline $ / events 14d; status lanes.
- **Production Tasks** (board): open / blocked (bad) / due today; station completion.
- **Delivery Runs** (dispatch): today / en route / issues (bad); pickup→delivery rows.
- **Dietary Requirements** (matrix): unconfirmed (warn) / guests / types; type bars.
- **Menu Packages** (library): active / avg $/person / dietary; category breakdown.
- **Clients** (book): clients / orgs / new; monthly bars.

### CleanShift — Cleaning Business Scheduler
Clients, teams, jobs, quality, supplies, issues.
- **Cleaning Jobs** (run sheet): today / week / issues (bad); start-time schedule.
- **Quality Checks** (QA): avg rating / follow-ups (warn) / 30d; rating distribution.
- **Supplies** (cupboard): low/out / OK / categories; par bars.
- **Client Issues** (resolution): open / high (bad) / resolved; severity qRows.
- **Teams** (dispatch): active / areas / vehicles; coverage bars.
- **Clients** (book): clients / overdue (warn) / commercial; type breakdown.

### TutorTrack — Tutoring & Lessons Manager
Students, tutors, lessons, progress, invoices.
- **Lessons** (teaching week): week / today / no-shows; subject schedule.
- **Students** (roster): active / waitlist / new; subject breakdown.
- **Progress Notes** (board): avg score / follow-ups (warn) / 30d; progress-area breakdown.
- **Invoices** (billing): outstanding $ / overdue (bad) / paid 30d; status breakdown.
- **Tutors** (bench): active / subject cover / avg rate $; availability bars.

### FitStudio — Personal Training & Gym Coaching
Clients, trainers, sessions, assessments, programs, payments.
- **Sessions** (coaching day): today / week / no-shows; type schedule.
- **Clients** (floor): active / trials / new; goal breakdown.
- **Assessments** (progress lab): 30d / avg mobility / clients; monthly bars.
- **Programs** (timeline): active / finishing / drafts; goal breakdown.
- **Payments** (revenue): collected 30d $ / pending (warn) / failed (bad); type breakdown.
- **Trainers** (bench): active / specialties / PTs; role breakdown.

### VenueOps — Venue Hire & Booking Manager
Spaces, clients, bookings, setups, incidents, payments.
- **Bookings** (diary): 7d / unpaid (warn) / enquiries; purpose schedule.
- **Spaces** (catalogue): available / capacity / avg rate $; type breakdown.
- **Setup Requirements** (sheet): not complete (warn) / catering / done; layout breakdown.
- **Payments** (revenue): collected 30d $ / pending (warn) / refunds; method breakdown.
- **Incidents** (register): open / cost $ / closed; type qRows.
- **Clients** (hirer book): clients / orgs / new; monthly bars.

### FleetFlow — Vehicle Fleet & Driver Log
Vehicles, drivers, trips, maintenance, incidents.
- **Vehicles** (fleet board): available / in workshop (warn) / compliance (rego+insurance); expiry chips.
- **Trips** (log): km 30d / trips / fuel $; purpose breakdown.
- **Maintenance** (service bay): overdue+due / in workshop / spend $; due-date rows.
- **Drivers** (compliance): active / licences expiring (warn) / classes; class breakdown.
- **Incidents** (register): open / high (bad) / 90d; type breakdown.

### SitePulse — Construction Site Diary
Projects, daily diaries, subbies, deliveries, defects, variations.
- **Daily Diaries** (wall): week / avg workers / rain days; weather-mix breakdown.
- **Defects** (board): open / critical (bad) / verified; priority qRows w/ due chips.
- **Deliveries** (materials log): week / with issues (warn) / suppliers; monthly bars.
- **Variations** (pipeline): approved $ / awaiting client (warn) / rejected; status breakdown.
- **Projects** (portfolio): active / due 60d / on hold; status breakdown.
- **Subcontractors** (register): approved / insurance expiring (warn) / trades; trade breakdown.

### AgriLog — Farm Jobs & Harvest Tracker
Paddocks, farm jobs, harvest, chemicals, machinery, maintenance.
- **Farm Jobs** (work board): week / overdue (warn) / rained off; job-type breakdown.
- **Paddocks** (block map): in crop / hectares / fallow; status breakdown.
- **Harvest Logs** (tally): 30d / premium share / blocks; grade breakdown.
- **Chemical Applications** (register): active WHP (warn) / 30d / operators; monthly bars.
- **Machinery** (shed): running / service due (warn) / workshop; type breakdown.
- **Maintenance Logs** (workshop log): spend 90d $ / 30d / repairs; type breakdown.
