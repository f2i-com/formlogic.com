// CANONICAL FORMLOGIC PRELUDE — single source of truth.
// This plain-JS standard library is evaluated inside the QuickJS sandbox on
// BOTH the browser (zipp wasm) and the backend (the zipp sandbox child) before
// every user expression/script, so helper builtins resolve identically on
// each side. It is imported as raw text in the browser and read from disk by
// the backend; the backend copy at backend/resources/formlogic-prelude.js is
// generated from THIS file by scripts/sync-prelude.mjs (run in prebuild) —
// edit this file and never hand-edit the generated copy.
//
// The module objects are declared with `var` (not `let`) on purpose: the qjs
// harness installs the prelude via indirect eval and then runs user code via
// `new Function`, whose body sees global *object* properties (var/function) but
// NOT global lexical (let/const) bindings. `var` keeps them resolvable on both
// engines.

function __isArr(a) { return typeof a == "object" && a != null && typeof a.length == "number"; }
var validators = {
  email: function(value) {
    if (typeof value != "string") { return false; }
    return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(value);
  },
  phone: function(value) {
    if (typeof value != "string") { return false; }
    let stripped = value.replace(/[ \-()]/g, "");
    return /^[+]?[0-9]{7,15}$/.test(stripped);
  },
  url: function(value) {
    if (typeof value != "string") { return false; }
    return /^https?:\/\/[^ ]+\.[^ ]{2,}/.test(value);
  },
  minLength: function(value, min) {
    if (typeof value != "string" || typeof min != "number") { return false; }
    return value.length >= min;
  },
  maxLength: function(value, max) {
    if (typeof value != "string" || typeof max != "number") { return false; }
    return value.length <= max;
  },
  pattern: function(value, pat) {
    if (typeof value != "string" || typeof pat != "string") { return false; }
    if (pat.length > 500) { return false; }
    let re = RegExp(pat);
    return re.test(value);
  },
  required: function(value) {
    if (value == null) { return false; }
    if (typeof value == "string") { return value.trim().length > 0; }
    if (__isArr(value)) { return value.length > 0; }
    return true;
  },
  min: function(value, m) {
    if (typeof value != "number" || typeof m != "number") { return false; }
    return value >= m;
  },
  max: function(value, m) {
    if (typeof value != "number" || typeof m != "number") { return false; }
    return value <= m;
  }
};
var format = {
  currency: function(value, cur) {
    if (typeof value != "number") { return ""; }
    let prefix = "$";
    if (cur == "EUR") { prefix = "\u20AC"; }
    if (cur == "GBP") { prefix = "\u00A3"; }
    if (cur == "AUD") { prefix = "A$"; }
    let s = Math.abs(value).toFixed(2);
    let parts = s.split(".");
    let intPart = parts[0];
    let decPart = parts[1];
    let result = "";
    let cnt = 0;
    let i = intPart.length - 1;
    while (i >= 0) {
      if (cnt > 0 && cnt % 3 == 0) { result = "," + result; }
      result = intPart[i] + result;
      cnt = cnt + 1;
      i = i - 1;
    }
    if (value < 0) { return "-" + prefix + result + "." + decPart; }
    return prefix + result + "." + decPart;
  },
  number: function(value, decimals) {
    if (typeof value != "number") { return ""; }
    if (typeof decimals != "number") { decimals = 0; }
    return value.toFixed(decimals);
  },
  date: function(value, fmt) {
    if (value == null) { return ""; }
    return "" + value;
  },
  uppercase: function(value) {
    if (typeof value != "string") { return ""; }
    return value.toUpperCase();
  },
  lowercase: function(value) {
    if (typeof value != "string") { return ""; }
    return value.toLowerCase();
  }
};
var compliance = {
  regBICheck: function(riskScore, portfolioType) {
    if (typeof riskScore != "number" || typeof portfolioType != "string") { return false; }
    let pt = portfolioType.toLowerCase();
    if (pt == "conservative") { return riskScore >= 0 && riskScore <= 30; }
    if (pt == "moderate") { return riskScore >= 20 && riskScore <= 60; }
    if (pt == "aggressive") { return riskScore >= 50 && riskScore <= 85; }
    if (pt == "speculative") { return riskScore >= 75 && riskScore <= 100; }
    return false;
  },
  suitabilityScore: function(age, income, netWorth, riskTolerance, timeHorizon) {
    if (typeof age != "number" || typeof income != "number" || typeof netWorth != "number" || typeof riskTolerance != "number" || typeof timeHorizon != "number") { return 0; }
    let ageScore = Math.max(0, Math.min(100, 100 - age));
    let incomeScore = Math.max(0, Math.min(100, (income / 500000) * 100));
    let nwScore = Math.max(0, Math.min(100, (netWorth / 5000000) * 100));
    let tolScore = Math.max(0, Math.min(100, riskTolerance * 10));
    let horizonScore = Math.max(0, Math.min(100, timeHorizon * 3.33));
    let weighted = ageScore * 0.20 + incomeScore * 0.15 + nwScore * 0.20 + tolScore * 0.25 + horizonScore * 0.20;
    return Math.round(Math.max(1, Math.min(100, weighted)));
  },
  amlFlag: function(amount, frequency) {
    if (typeof amount != "number") { return false; }
    let freq = 0;
    if (typeof frequency == "number") { freq = frequency; }
    if (amount >= 10000) { return true; }
    if (amount >= 8000 && amount < 10000 && freq > 3) { return true; }
    if (freq > 50) { return true; }
    if (amount * freq > 100000) { return true; }
    return false;
  },
  kycComplete: function(...args) {
    let i = 0;
    while (i < args.length) {
      let val = args[i];
      if (val == null) { return false; }
      if (typeof val == "string" && val.trim().length == 0) { return false; }
      i = i + 1;
    }
    return args.length > 0;
  },
  nigoCheck: function(...args) {
    let missing = "";
    let i = 0;
    while (i < args.length) {
      let val = args[i];
      let isMissing = false;
      if (val == null) { isMissing = true; }
      if (!isMissing && typeof val == "string" && val.trim().length == 0) { isMissing = true; }
      if (isMissing) {
        if (missing.length > 0) { missing = missing + ","; }
        missing = missing + (i + 1);
      }
      i = i + 1;
    }
    return missing;
  },
  accreditedInvestor: function(income, netWorth) {
    if (typeof income != "number" || typeof netWorth != "number") { return false; }
    return income > 200000 || netWorth > 1000000;
  },
  wholesaleClient: function(income, netAssets) {
    if (typeof income != "number" || typeof netAssets != "number") { return false; }
    return income >= 250000 || netAssets >= 2500000;
  },
  austracFlag: function(amount, frequency) {
    if (typeof amount != "number") { return false; }
    let freq = 0;
    if (typeof frequency == "number") { freq = frequency; }
    if (amount >= 10000) { return true; }
    if (amount >= 8000 && amount < 10000 && freq > 3) { return true; }
    if (freq > 50) { return true; }
    if (amount * freq > 100000) { return true; }
    return false;
  },
  tfnValid: function(tfn) {
    if (typeof tfn != "string") { return false; }
    return /^[0-9]{3}-?[0-9]{3}-?[0-9]{3}$/.test(tfn.trim());
  }
};
var finance = {
  compoundInterest: function(principal, rate, periods) {
    if (typeof principal != "number" || typeof rate != "number" || typeof periods != "number") { return 0; }
    let result = principal * Math.pow(1 + rate, periods);
    return Math.round(result * 100) / 100;
  },
  aumFee: function(assets) {
    if (typeof assets != "number" || assets <= 0) { return 0; }
    let tiers = [[1000000, 0.01], [5000000, 0.0075], [10000000, 0.005], [999999999999, 0.0035]];
    let remaining = assets;
    let totalFee = 0;
    let prevCeiling = 0;
    let i = 0;
    while (i < tiers.length) {
      let tierAmount = remaining;
      let diff = tiers[i][0] - prevCeiling;
      if (tierAmount > diff) { tierAmount = diff; }
      if (tierAmount <= 0) { i = tiers.length; } else {
        totalFee = totalFee + tierAmount * tiers[i][1];
        remaining = remaining - tierAmount;
        prevCeiling = tiers[i][0];
        if (remaining <= 0) { i = tiers.length; }
      }
      i = i + 1;
    }
    return Math.round(totalFee * 100) / 100;
  },
  riskScore: function(age, timeHorizon, riskTolerance) {
    if (typeof age != "number" || typeof timeHorizon != "number" || typeof riskTolerance != "number") { return 0; }
    let ageScore = Math.max(0, Math.min(100, 100 - age));
    let horizonScore = Math.max(0, Math.min(100, timeHorizon * 3.33));
    let tolScore = Math.max(0, Math.min(100, riskTolerance * 10));
    let weighted = ageScore * 0.30 + horizonScore * 0.30 + tolScore * 0.40;
    return Math.round(Math.max(1, Math.min(100, weighted)));
  },
  portfolioAllocation: function(riskScore) {
    if (typeof riskScore != "number") { return "20:50:30"; }
    let score = Math.max(1, Math.min(100, riskScore));
    let t = (score - 1) / 99;
    let equity = Math.round(20 + t * 70);
    let bond = Math.round(50 - t * 42);
    let cash = 100 - equity - bond;
    if (cash < 0) { bond = bond + cash; cash = 0; }
    return equity + ":" + bond + ":" + cash;
  },
  transferFee: function(amount, custodian) {
    if (typeof amount != "number") { return 0; }
    if (amount < 500) { return 0; }
    if (typeof custodian == "string") {
      let c = custodian.toLowerCase();
      if (c == "schwab") { return 50; }
      if (c == "fidelity") { return 0; }
      if (c == "vanguard") { return 100; }
      if (c == "etrade") { return 75; }
      if (c == "pershing") { return 75; }
      if (c == "lpl") { return 75; }
    }
    return 75;
  },
  auAumFee: function(assets) {
    if (typeof assets != "number" || assets <= 0) { return 0; }
    let tiers = [[500000, 0.011], [2000000, 0.0088], [5000000, 0.0066], [999999999999, 0.0044]];
    let remaining = assets;
    let totalFee = 0;
    let prevCeiling = 0;
    let i = 0;
    while (i < tiers.length) {
      let tierAmount = remaining;
      let diff = tiers[i][0] - prevCeiling;
      if (tierAmount > diff) { tierAmount = diff; }
      if (tierAmount <= 0) { i = tiers.length; } else {
        totalFee = totalFee + tierAmount * tiers[i][1];
        remaining = remaining - tierAmount;
        prevCeiling = tiers[i][0];
        if (remaining <= 0) { i = tiers.length; }
      }
      i = i + 1;
    }
    return Math.round(totalFee * 100) / 100;
  },
  auTransferFee: function(amount, platform) {
    if (typeof amount != "number" || typeof platform != "string") { return 0; }
    let p = platform.toLowerCase();
    if (p == "netwealth") { return 0; }
    if (p == "hub24") { return 0; }
    if (p == "bt panorama") { return 54; }
    if (p == "macquarie") { return 33; }
    if (p == "cfs") { return 0; }
    if (p == "cfs firstchoice") { return 0; }
    return 55;
  }
};
var safety = {
  riskMatrix: function(likelihood, consequence) {
    if (typeof likelihood != "number" || typeof consequence != "number") { return 0; }
    let l = Math.max(1, Math.min(5, Math.round(likelihood)));
    let c = Math.max(1, Math.min(5, Math.round(consequence)));
    return l * c;
  },
  riskLevel: function(score) {
    if (typeof score != "number") { return "Unknown"; }
    if (score >= 20) { return "Critical"; }
    if (score >= 12) { return "High"; }
    if (score >= 5) { return "Medium"; }
    if (score >= 1) { return "Low"; }
    return "Unknown";
  },
  controlEffectiveness: function(controlType) {
    if (typeof controlType != "string") { return 0; }
    let ct = controlType.toLowerCase();
    if (ct == "elimination") { return 5; }
    if (ct == "substitution") { return 4; }
    if (ct == "engineering") { return 3; }
    if (ct == "administrative") { return 2; }
    if (ct == "ppe") { return 1; }
    return 0;
  },
  residualRisk: function(riskScore, controlType) {
    if (typeof riskScore != "number" || typeof controlType != "string") { return 0; }
    let ct = controlType.toLowerCase();
    let effectiveness = 0;
    if (ct == "elimination") { effectiveness = 5; }
    if (ct == "substitution") { effectiveness = 4; }
    if (ct == "engineering") { effectiveness = 3; }
    if (ct == "administrative") { effectiveness = 2; }
    if (ct == "ppe") { effectiveness = 1; }
    let residual = Math.round(riskScore * (1 - effectiveness / 5));
    return Math.max(0, residual);
  }
};
function isEmpty(value) {
  if (value == null) { return true; }
  if (typeof value == "string") { return value.trim().length == 0; }
  if (__isArr(value)) { return value.length == 0; }
  return false;
}
function isNotEmpty(value) {
  return !isEmpty(value);
}
function contains(arr, item) {
  if (!__isArr(arr)) { return false; }
  return arr.includes(item);
}
function sum(arr) {
  if (!__isArr(arr)) { return 0; }
  let total = 0;
  let i = 0;
  while (i < arr.length) {
    if (typeof arr[i] == "number") { total = total + arr[i]; }
    i = i + 1;
  }
  return total;
}
function avg(arr) {
  if (!__isArr(arr) || arr.length == 0) { return 0; }
  let total = 0;
  let cnt = 0;
  let i = 0;
  while (i < arr.length) {
    if (typeof arr[i] == "number") { total = total + arr[i]; cnt = cnt + 1; }
    i = i + 1;
  }
  if (cnt == 0) { return 0; }
  return total / cnt;
}
function count(arr) {
  if (!__isArr(arr)) { return 0; }
  return arr.length;
}
