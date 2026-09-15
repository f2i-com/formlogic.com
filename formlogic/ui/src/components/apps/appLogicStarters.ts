// Starter sources for the App logic editor (AppLogicPanel), per script language.
//
// Each hook's JavaScript starter has a Python twin (formlogic-python/1: `def run(ctx)`, ctx a
// dict) that returns the same result for the same ctx; appLogicStarters.test.ts runs every pair
// on the real engine against SAMPLE_CTX. Small, working, and safe to run under Test run.
import type { CustomAppLogicHookName, CustomAppLogicLanguage } from '../../types/customAppLogic';

export const STARTERS: Record<CustomAppLogicLanguage, Record<CustomAppLogicHookName, string>> = {
  javascript: {
    onBeforeSubmit: "function run(ctx) {\n  if (Number(ctx.answers.fuel_percent || 0) < 15) {\n    return { reject: true, message: 'Fuel is too low to start this shift.' };\n  }\n  return { ok: true };\n}",
    onConnectorEvent: "function run(ctx) {\n  var e = ctx.event;\n  if (!e) return {};\n  // Phone abilities: e.result is the device data (see the 'device' connector).\n  if (e.command === 'gps.read') return { ui: { setValues: { latitude: e.result.lat, longitude: e.result.lng } } };\n  var v = e.vehicleStatus;\n  if (v) return { ui: { setValues: { fleet_number: v.fleetNumber, fuel_percent: v.fuelPercent } } };\n  return {};\n}",
    onScreenEnter: "function run(ctx) {\n  // Ask a connector for data on screen open. Use 'device' for phone abilities\n  // (gps.read, battery.read, network.read, info.read, …) or your own connector.\n  return { effects: [{ type: 'connector.request', connectorId: 'device', command: 'gps.read' }] };\n}",
    onAfterSubmit: "function run(ctx) {\n  return { ui: { toast: { message: 'Submission saved.', level: 'success' } } };\n}",
    onAppStart: "function run(ctx) {\n  return { ui: { toast: { message: 'Welcome back.', level: 'info' } } };\n}",
    onScreenLeave: "function run(ctx) {\n  // Remember the last screen for the next visit.\n  return { effects: [{ type: 'storage.set', key: 'last_screen', value: ctx.meta.screenId || '' }] };\n}",
    onButtonClick: "function run(ctx) {\n  return { ui: { navigate: { screenId: 'dashboard' } } };\n}",
    onSyncConflict: "function run(ctx) {\n  // ctx.event carries the clashing copies; return {} to accept the default resolution.\n  return {};\n}",
    mapConnectorDataToForm: "function run(ctx) {\n  var v = (ctx.event && ctx.event.vehicleStatus) || {};\n  return { ui: { setValues: { fleet_number: v.fleetNumber, fuel_percent: v.fuelPercent } } };\n}",
    calculateDashboardState: "function run(ctx) {\n  return { value: { lastChecked: ctx.meta.now } };\n}",
  },
  python: {
    // float() raises on text that is not a number, where JavaScript's Number() gives NaN (never
    // "too low"); the try keeps a stray letter from failing the submission.
    onBeforeSubmit: 'def run(ctx):\n    try:\n        fuel = float(ctx["answers"].get("fuel_percent") or 0)\n    except (TypeError, ValueError):\n        fuel = None  # not a number: never too low, like NaN in JavaScript\n    if fuel is not None and fuel < 15:\n        return {"reject": True, "message": "Fuel is too low to start this shift."}\n    return {"ok": True}\n',
    onConnectorEvent: 'def run(ctx):\n    e = ctx.get("event")\n    if not e:\n        return {}\n    # Phone abilities: e["result"] is the device data (see the \'device\' connector).\n    if e.get("command") == "gps.read":\n        return {"ui": {"setValues": {"latitude": e["result"]["lat"], "longitude": e["result"]["lng"]}}}\n    v = e.get("vehicleStatus")\n    if v:\n        return {"ui": {"setValues": {"fleet_number": v.get("fleetNumber"), "fuel_percent": v.get("fuelPercent")}}}\n    return {}\n',
    onScreenEnter: 'def run(ctx):\n    # Ask a connector for data on screen open. Use \'device\' for phone abilities\n    # (gps.read, battery.read, network.read, info.read, …) or your own connector.\n    return {"effects": [{"type": "connector.request", "connectorId": "device", "command": "gps.read"}]}\n',
    onAfterSubmit: 'def run(ctx):\n    return {"ui": {"toast": {"message": "Submission saved.", "level": "success"}}}\n',
    onAppStart: 'def run(ctx):\n    return {"ui": {"toast": {"message": "Welcome back.", "level": "info"}}}\n',
    onScreenLeave: 'def run(ctx):\n    # Remember the last screen for the next visit.\n    return {"effects": [{"type": "storage.set", "key": "last_screen", "value": ctx["meta"].get("screenId") or ""}]}\n',
    onButtonClick: 'def run(ctx):\n    return {"ui": {"navigate": {"screenId": "dashboard"}}}\n',
    onSyncConflict: 'def run(ctx):\n    # ctx["event"] carries the clashing copies; return {} to accept the default resolution.\n    return {}\n',
    mapConnectorDataToForm: 'def run(ctx):\n    v = (ctx.get("event") or {}).get("vehicleStatus") or {}\n    return {"ui": {"setValues": {"fleet_number": v.get("fleetNumber"), "fuel_percent": v.get("fuelPercent")}}}\n',
    calculateDashboardState: 'def run(ctx):\n    return {"value": {"lastChecked": ctx["meta"].get("now")}}\n',
  },
};

/** "Blank": an empty run(ctx) to write yourself. Python needs a body, so it returns {}. */
export const BLANK_SOURCES: Record<CustomAppLogicLanguage, string> = {
  javascript: 'function run(ctx) {\n  \n}',
  python: 'def run(ctx):\n    return {}\n',
};

// A representative ctx so authors can Test-run without a live form/connector.
export const SAMPLE_CTX = {
  answers: { fuel_percent: 8, active_fault_codes: '', vehicle_id: 'TRUCK-044' },
  values: {},
  params: {},
  meta: { nativeAvailable: false, offline: false, userRole: 'Owner', now: '2026-07-05T00:00:00Z' },
  // A device gps.read result so Test-run exercises phone-ability scripts; vehicleStatus
  // kept for the vehicle examples. Scripts read ctx.event.result.
  event: {
    connectorId: 'device',
    command: 'gps.read',
    result: { lat: -27.4698, lng: 153.0251, accuracy: 12 },
    vehicleStatus: { vehicleId: 'TRUCK-044', fleetNumber: 'F044', fuelPercent: 8, faultCodes: ['P0123'] },
  },
};
