# formlogic.py: the guest half of FormLogic's Python contract, formlogic-python/1.
#
# Every Python evaluation runs a fresh ZIPP engine over three files: an entry main.py for
# the kind, this module, and logic_block.py (the author's code behind
# `from formlogic import *`). See pythonContract.ts for the wrappers and the attempt order.
#
# This module gives the author's code:
#   * the context names inputs, event, app, nodes, upstream and kv. The entry calls _bind()
#     before logic_block runs. The names are set with `global` here because ZIPP v0.0.18
#     cannot assign another module's attributes and has no builtins hook. The values are
#     plain dict, list, str, int, float, bool and None, so authors write inputs["from"].
#   * a no-op print, like the JavaScript console stubs, so chatty code never reaches the
#     engine's 8 MiB output ceiling. (sys.stdout.write still counts toward it.)
#   * the prelude.js helpers, with the same names and the same answers
#     (preludePythonParity.test.ts compares the two). format.* depends on JavaScript's
#     number formatting and stays JavaScript-only. sum and count are not exported, so the
#     star import leaves Python's sum() and list.count() alone.
#
# The entry passes every result through _plain() before it crosses to the host. Left to
# itself, the engine would turn a set or an object into a repr string with a heap address,
# and an int beyond 2**53 into a string.
import math as _math
import re as _re

inputs = None
event = None
app = None
nodes = None
upstream = None
kv = None


def _bind(ctx):
    global inputs, event, app, nodes, upstream, kv
    inputs = ctx.get("inputs")
    event = ctx.get("event")
    app = ctx.get("app")
    nodes = ctx.get("nodes")
    upstream = ctx.get("upstream")
    kv = ctx.get("kv")


def print(*args, **kwargs):
    pass


# --- JavaScript semantics the ported helpers need -------------------------------------

def _is_number(value):
    # typeof value == "number". A bool is an int in Python but never a number in JavaScript.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _round(value):
    # Math.round: a half rounds up. Python's round() rounds a half to even. A float from
    # 2**52 up is already whole and stays a float, as the JavaScript number would.
    if isinstance(value, int) or not _math.isfinite(value) or abs(value) >= 4503599627370496.0:
        return value
    whole = _math.floor(value)
    return whole + 1 if value - whole >= 0.5 else whole


def _utf16_length(text):
    # String.prototype.length counts UTF-16 code units, and len() counts code points.
    return len(text) + sum(1 for char in text if ord(char) > 0xFFFF)


def _array_length(value):
    # prelude.js __isArr: an array, or any object whose `length` is a number.
    if isinstance(value, (list, tuple)):
        return len(value)
    if isinstance(value, dict) and _is_number(value.get("length")):
        return value["length"]
    return None


def _array_items(value, length):
    if isinstance(value, (list, tuple)):
        return value
    items = []
    index = 0
    while index < length:
        items.append(value.get(str(index)))
        index = index + 1
    return items


def _same_value_zero(a, b):
    # Array.prototype.includes: True is not 1, NaN is NaN, and two equal dicts are two objects.
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return a == b or (a != a and b != b)
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    return a is b


def _blank(value):
    return value is None or (isinstance(value, str) and len(value.strip()) == 0)


def _tiered_fee(assets, tiers):
    remaining = assets
    total_fee = 0
    previous_ceiling = 0
    for ceiling, rate in tiers:
        tier_amount = min(remaining, ceiling - previous_ceiling)
        if tier_amount <= 0:
            break
        total_fee = total_fee + tier_amount * rate
        remaining = remaining - tier_amount
        previous_ceiling = ceiling
        if remaining <= 0:
            break
    return _round(total_fee * 100) / 100


# --- prelude.js helpers ---------------------------------------------------------------

class validators:
    @staticmethod
    def email(value=None):
        if not isinstance(value, str):
            return False
        return _re.fullmatch(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}", value) is not None

    @staticmethod
    def phone(value=None):
        if not isinstance(value, str):
            return False
        stripped = _re.sub(r"[ \-()]", "", value)
        return _re.fullmatch(r"[+]?[0-9]{7,15}", stripped) is not None

    @staticmethod
    def url(value=None):
        if not isinstance(value, str):
            return False
        return _re.match(r"https?://[^ ]+\.[^ ]{2,}", value) is not None

    @staticmethod
    def minLength(value=None, minimum=None):
        if not isinstance(value, str) or not _is_number(minimum):
            return False
        return _utf16_length(value) >= minimum

    @staticmethod
    def maxLength(value=None, maximum=None):
        if not isinstance(value, str) or not _is_number(maximum):
            return False
        return _utf16_length(value) <= maximum

    @staticmethod
    def pattern(value=None, pat=None):
        if not isinstance(value, str) or not isinstance(pat, str):
            return False
        if _utf16_length(pat) > 500:
            return False
        return _re.search(pat, value) is not None

    @staticmethod
    def required(value=None):
        if value is None:
            return False
        if isinstance(value, str):
            return len(value.strip()) > 0
        length = _array_length(value)
        if length is not None:
            return length > 0
        return True

    @staticmethod
    def min(value=None, m=None):
        if not _is_number(value) or not _is_number(m):
            return False
        return value >= m

    @staticmethod
    def max(value=None, m=None):
        if not _is_number(value) or not _is_number(m):
            return False
        return value <= m


_PORTFOLIO_RISK_BANDS = {
    "conservative": (0, 30),
    "moderate": (20, 60),
    "aggressive": (50, 85),
    "speculative": (75, 100),
}


def _transaction_flag(amount, frequency):
    if not _is_number(amount):
        return False
    freq = frequency if _is_number(frequency) else 0
    if amount >= 10000:
        return True
    if amount >= 8000 and amount < 10000 and freq > 3:
        return True
    if freq > 50:
        return True
    if amount * freq > 100000:
        return True
    return False


class compliance:
    @staticmethod
    def regBICheck(riskScore=None, portfolioType=None):
        if not _is_number(riskScore) or not isinstance(portfolioType, str):
            return False
        band = _PORTFOLIO_RISK_BANDS.get(portfolioType.lower())
        if band is None:
            return False
        return riskScore >= band[0] and riskScore <= band[1]

    @staticmethod
    def suitabilityScore(age=None, income=None, netWorth=None, riskTolerance=None, timeHorizon=None):
        if not (_is_number(age) and _is_number(income) and _is_number(netWorth)
                and _is_number(riskTolerance) and _is_number(timeHorizon)):
            return 0
        age_score = max(0, min(100, 100 - age))
        income_score = max(0, min(100, (income / 500000) * 100))
        net_worth_score = max(0, min(100, (netWorth / 5000000) * 100))
        tolerance_score = max(0, min(100, riskTolerance * 10))
        horizon_score = max(0, min(100, timeHorizon * 3.33))
        weighted = (age_score * 0.20 + income_score * 0.15 + net_worth_score * 0.20
                    + tolerance_score * 0.25 + horizon_score * 0.20)
        return _round(max(1, min(100, weighted)))

    @staticmethod
    def amlFlag(amount=None, frequency=None):
        return _transaction_flag(amount, frequency)

    @staticmethod
    def kycComplete(*args):
        for value in args:
            if _blank(value):
                return False
        return len(args) > 0

    @staticmethod
    def nigoCheck(*args):
        missing = ""
        for index, value in enumerate(args):
            if _blank(value):
                if len(missing) > 0:
                    missing = missing + ","
                missing = missing + str(index + 1)
        return missing

    @staticmethod
    def accreditedInvestor(income=None, netWorth=None):
        if not _is_number(income) or not _is_number(netWorth):
            return False
        return income > 200000 or netWorth > 1000000

    @staticmethod
    def wholesaleClient(income=None, netAssets=None):
        if not _is_number(income) or not _is_number(netAssets):
            return False
        return income >= 250000 or netAssets >= 2500000

    @staticmethod
    def austracFlag(amount=None, frequency=None):
        return _transaction_flag(amount, frequency)

    @staticmethod
    def tfnValid(tfn=None):
        if not isinstance(tfn, str):
            return False
        return _re.fullmatch(r"[0-9]{3}-?[0-9]{3}-?[0-9]{3}", tfn.strip()) is not None


_US_CUSTODIAN_FEES = {"schwab": 50, "fidelity": 0, "vanguard": 100, "etrade": 75, "pershing": 75, "lpl": 75}
_AU_PLATFORM_FEES = {"netwealth": 0, "hub24": 0, "bt panorama": 54, "macquarie": 33, "cfs": 0, "cfs firstchoice": 0}


class finance:
    @staticmethod
    def compoundInterest(principal=None, rate=None, periods=None):
        if not _is_number(principal) or not _is_number(rate) or not _is_number(periods):
            return 0
        # math.pow, not **: like Math.pow it answers inf or nan where ** can raise.
        result = principal * _math.pow(1 + rate, periods)
        return _round(result * 100) / 100

    @staticmethod
    def aumFee(assets=None):
        if not _is_number(assets) or assets <= 0:
            return 0
        return _tiered_fee(assets, [[1000000, 0.01], [5000000, 0.0075], [10000000, 0.005], [999999999999, 0.0035]])

    @staticmethod
    def riskScore(age=None, timeHorizon=None, riskTolerance=None):
        if not _is_number(age) or not _is_number(timeHorizon) or not _is_number(riskTolerance):
            return 0
        age_score = max(0, min(100, 100 - age))
        horizon_score = max(0, min(100, timeHorizon * 3.33))
        tolerance_score = max(0, min(100, riskTolerance * 10))
        weighted = age_score * 0.30 + horizon_score * 0.30 + tolerance_score * 0.40
        return _round(max(1, min(100, weighted)))

    @staticmethod
    def portfolioAllocation(riskScore=None):
        if not _is_number(riskScore):
            return "20:50:30"
        score = max(1, min(100, riskScore))
        t = (score - 1) / 99
        equity = _round(20 + t * 70)
        bond = _round(50 - t * 42)
        cash = 100 - equity - bond
        if cash < 0:
            bond = bond + cash
            cash = 0
        return str(equity) + ":" + str(bond) + ":" + str(cash)

    @staticmethod
    def transferFee(amount=None, custodian=None):
        if not _is_number(amount):
            return 0
        if amount < 500:
            return 0
        if isinstance(custodian, str):
            return _US_CUSTODIAN_FEES.get(custodian.lower(), 75)
        return 75

    @staticmethod
    def auAumFee(assets=None):
        if not _is_number(assets) or assets <= 0:
            return 0
        return _tiered_fee(assets, [[500000, 0.011], [2000000, 0.0088], [5000000, 0.0066], [999999999999, 0.0044]])

    @staticmethod
    def auTransferFee(amount=None, platform=None):
        if not _is_number(amount) or not isinstance(platform, str):
            return 0
        return _AU_PLATFORM_FEES.get(platform.lower(), 55)


_CONTROL_EFFECTIVENESS = {"elimination": 5, "substitution": 4, "engineering": 3, "administrative": 2, "ppe": 1}


class safety:
    @staticmethod
    def riskMatrix(likelihood=None, consequence=None):
        if not _is_number(likelihood) or not _is_number(consequence):
            return 0
        l = max(1, min(5, _round(likelihood)))
        c = max(1, min(5, _round(consequence)))
        return l * c

    @staticmethod
    def riskLevel(score=None):
        if not _is_number(score):
            return "Unknown"
        if score >= 20:
            return "Critical"
        if score >= 12:
            return "High"
        if score >= 5:
            return "Medium"
        if score >= 1:
            return "Low"
        return "Unknown"

    @staticmethod
    def controlEffectiveness(controlType=None):
        if not isinstance(controlType, str):
            return 0
        return _CONTROL_EFFECTIVENESS.get(controlType.lower(), 0)

    @staticmethod
    def residualRisk(riskScore=None, controlType=None):
        if not _is_number(riskScore) or not isinstance(controlType, str):
            return 0
        effectiveness = _CONTROL_EFFECTIVENESS.get(controlType.lower(), 0)
        residual = _round(riskScore * (1 - effectiveness / 5))
        return max(0, residual)


def is_empty(value=None):
    if value is None:
        return True
    if isinstance(value, str):
        return len(value.strip()) == 0
    length = _array_length(value)
    if length is not None:
        return length == 0
    return False


def is_not_empty(value=None):
    return not is_empty(value)


def contains(arr=None, item=None):
    if _array_length(arr) is None:
        return False
    if not isinstance(arr, (list, tuple)):
        # A JavaScript array-like object has no includes().
        raise TypeError("contains() needs a list")
    for entry in arr:
        if _same_value_zero(entry, item):
            return True
    return False


def avg(arr=None):
    length = _array_length(arr)
    if length is None or length == 0:
        return 0
    total = 0
    count = 0
    for item in _array_items(arr, length):
        if _is_number(item):
            total = total + item
            count = count + 1
    if count == 0:
        return 0
    return total / count


__all__ = [
    "inputs", "event", "app", "nodes", "upstream", "kv", "print",
    "validators", "compliance", "finance", "safety",
    "is_empty", "is_not_empty", "contains", "avg",
]


# --- the result, as JSON data ---------------------------------------------------------

_SAFE_INTEGER = 2 ** 53 - 1
_MAX_DEPTH = 64


def _plain_key(key):
    # Coerced the way json.dumps coerces keys.
    if isinstance(key, str):
        return key
    if key is None:
        return "null"
    if isinstance(key, bool):
        return "true" if key else "false"
    if isinstance(key, int):
        return str(key)
    if isinstance(key, float):
        if key != key:
            return "NaN"
        if not _math.isfinite(key):
            return "Infinity" if key > 0 else "-Infinity"
        return repr(key)
    raise TypeError("the result has a dict key of type " + type(key).__name__ + "; use str keys")


def _plain(value, depth=0):
    if depth > _MAX_DEPTH:
        raise ValueError("the result nests deeper than 64 levels")
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if -_SAFE_INTEGER <= value <= _SAFE_INTEGER:
            return value
        raise ValueError("the result holds an integer outside +/-(2**53 - 1); return it as a str")
    if isinstance(value, float):
        # Like JSON.stringify: nan and infinities become null.
        return value if _math.isfinite(value) else None
    if isinstance(value, (list, tuple)):
        return [_plain(item, depth + 1) for item in value]
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            out[_plain_key(key)] = _plain(item, depth + 1)
        return out
    raise TypeError("the result holds a " + type(value).__name__
                    + "; return JSON data (dict, list, str, int, float, bool, None)")
