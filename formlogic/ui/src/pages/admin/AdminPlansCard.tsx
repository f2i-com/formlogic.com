import { useEffect, useState } from "react";
import { api, type PlatformPlans } from "../../lib/api";
import { deferEffect } from "../../lib/deferredEffect";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Card, CardContent } from "../../components/ui/Card";

export function AdminPlansCard() {
  const [plans, setPlans] = useState<PlatformPlans | null>(null);
  const [price, setPrice] = useState("5.00");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    setError("");
    const result = await api.adminGetPlans();
    if (!result.data) {
      setError(result.error || "Could not load plans.");
      return;
    }
    setPlans(result.data.plans);
    setPrice((result.data.plans.pricePerMonthCents / 100).toFixed(2));
  };
  useEffect(() => deferEffect(() => {
    void load();
  }), []);
  const save = async () => {
    if (!plans) return;
    const cents = Math.round(Number(price) * 100);
    if (!/^\d+(\.\d{1,2})?$/.test(price) || cents < 100 || cents > 100000) {
      setError(
        "Enter a price from $1.00 to $1,000.00, with at most two decimal places.",
      );
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api.adminPutPlans({
        ...plans,
        pricePerMonthCents: cents,
      });
      if (!result.data) {
        setError(result.error || "Could not save plans.");
        return;
      }
      setPlans(result.data.plans);
      setMessage(
        "Plan settings saved. The landing page and checkout use these settings.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardContent className="space-y-5 p-5 sm:p-6">
        <div>
          <h3 className="text-lg font-semibold">
            Plans &amp; bring your own AI
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
            Free access stays available. Optional support is prepaid in 30-day
            periods, with no auto-renewal. Changes affect new orders; existing
            orders retain their agreed price.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {!plans ? (
          <Button variant="outline" onClick={() => void load()}>
            Retry loading plans
          </Button>
        ) : (
          <fieldset disabled={busy} className="min-w-0 space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Input
                label="Free plan name"
                value={plans.freeName}
                maxLength={60}
                onChange={(e) =>
                  setPlans({ ...plans, freeName: e.target.value })
                }
              />
              <Input
                label="Paid plan name"
                value={plans.paidName}
                maxLength={60}
                onChange={(e) =>
                  setPlans({ ...plans, paidName: e.target.value })
                }
              />
              <Input
                label="Free plan description"
                value={plans.freeDescription}
                maxLength={300}
                onChange={(e) =>
                  setPlans({ ...plans, freeDescription: e.target.value })
                }
              />
              <Input
                label="Paid plan description"
                value={plans.paidDescription}
                maxLength={300}
                onChange={(e) =>
                  setPlans({ ...plans, paidDescription: e.target.value })
                }
              />
              <Input
                label="Price per 30 days (USD)"
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
            <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-4 dark:border-slate-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={plans.paymentsEnabled}
                onChange={(e) =>
                  setPlans({ ...plans, paymentsEnabled: e.target.checked })
                }
              />
              <span>
                <strong className="block text-sm">
                  Enable optional paid plan
                </strong>
                <span className="text-sm text-gray-500">
                  Off by default. Checkout also requires configured PayPal
                  credentials. Public beta mode keeps checkout disabled.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-4 dark:border-slate-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={plans.siteAiEnabled}
                onChange={(e) =>
                  setPlans({ ...plans, siteAiEnabled: e.target.checked })
                }
              />
              <span>
                <strong className="block text-sm">
                  Offer operator-funded Site AI
                </strong>
                <span className="text-sm text-gray-500">
                  Off by default. Users bring their own AI. Enabling this
                  permits use of your configured server AI provider and may
                  incur provider charges.
                </span>
              </span>
            </label>
            <Button onClick={() => void save()} isLoading={busy}>
              Save plan settings
            </Button>
            {message && (
              <p
                role="status"
                className="text-sm text-green-700 dark:text-green-300"
              >
                {message}
              </p>
            )}
          </fieldset>
        )}
      </CardContent>
    </Card>
  );
}
