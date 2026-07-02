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
