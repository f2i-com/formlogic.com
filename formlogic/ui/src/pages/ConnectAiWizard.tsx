import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, Laptop, KeyRound } from "lucide-react";
import { Header } from "../components/layout/Header";
import { Button } from "../components/ui/Button";
import { LocalRuntimePanel } from "../components/desktop/LocalRuntimePanel";
import { AiSourceCard } from "../components/settings/AiSourceCard";
import AiServicesDialog from "../components/flows/AiServicesDialog";
import { useFlowsDesktopPresence } from "../components/flows/useFlowsDesktopPresence";
import {
  listProviders,
  providerSupports,
} from "../client-runtime/flows/aiProviders";
import { listAiSources } from "../client-runtime/flows/desktopService";
import { fetchProviderCatalog } from "../client-runtime/desktop/desktopTunnel";
import { providerListingFromTunnel } from "../components/settings/aiModelCatalog";
import { api } from "../lib/api";
import { cacheAiPreferences } from "../lib/websiteAiRouting";
import { useAuthStore } from "../stores/authStore";

type Method = "desktop" | "custom";
export default function ConnectAiWizard() {
  const [step, setStep] = useState(0);
  const [method, setMethod] = useState<Method>("desktop");
  const [desktopConnection, setDesktopConnection] = useState<'account' | 'local'>('account');
  const [servicesOpen, setServicesOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const stepTitle = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(step);
  const verification = useRef(0);
  useEffect(() => {
    if (previousStep.current !== step) stepTitle.current?.focus();
    previousStep.current = step;
  }, [step]);
  useEffect(() => () => { verification.current += 1; }, []);
  const presence = useFlowsDesktopPresence(true, desktopConnection === 'local', desktopConnection === 'account');
  const user = useAuthStore((s) => s.user);
  const verify = async () => {
    const attempt = ++verification.current;
    setChecking(true);
    setError("");
    setReady(false);
    try {
      const result = await api.getAiPreferences();
      if (verification.current !== attempt) return;
      if (!result.data)
        throw new Error(
          result.error || "Could not read your saved AI settings.",
        );
      const prefs = result.data;
      if (prefs.aiSource !== method)
        throw new Error(
          "Choose a provider below and save your AI settings first.",
        );
      if (method === "custom") {
        const provider = listProviders(user?.id).find(
          (p) =>
            p.id === prefs.customProviderId &&
            p.enabled &&
            providerSupports(p, "chat"),
        );
        if (!provider)
          throw new Error(
            "Add a chat provider in this browser, then select it below.",
          );
      } else {
        let sources = desktopConnection === 'local' ? await listAiSources() : [];
        if (sources.length === 0) {
          const catalog = await fetchProviderCatalog({ timeoutMs: 30_000 });
          if (!catalog.ok) throw new Error(catalog.error.message);
          sources = catalog.data.providers.flatMap((provider) => {
            const source = providerListingFromTunnel(provider);
            return source ? [source] : [];
          });
        }
        const id = prefs.desktopProviderId?.replace(/^provider:/, "");
        if (
          !id ||
          !sources.some(
            (p) =>
              p.enabled &&
              (p.kind === "provider" || p.status === "running") &&
              (p.capabilities.length === 0 ||
                p.capabilities.includes("chat")) &&
              (p.refId === id || p.id === prefs.desktopProviderId),
          )
        ) {
          // OAIY before 0.1.11 offered its own engine on its computer but not through the relay.
          if (id === "oaiy-engine" && desktopConnection === "account")
            throw new Error(
              "OAIY's own engine answers through the relay from OAIY 0.1.11. Update OAIY, or add a provider in OAIY (Codex, an API key, or a local model server) and choose it here.",
            );
          throw new Error(
            "The saved provider is not available. Keep OAIY open, link your FormLogic account in Connections and enable a provider there.",
          );
        }
      }
      if (verification.current !== attempt) return;
      cacheAiPreferences(prefs);
      setReady(true);
    } catch (e) {
      if (verification.current !== attempt) return;
      setError(
        e instanceof Error ? e.message : "Could not check the connection.",
      );
    } finally {
      if (verification.current === attempt) setChecking(false);
    }
  };
  const resetCheck = () => {
    verification.current += 1;
    setChecking(false);
    setReady(false);
    setError("");
  };
  const changeStep = (next: number) => {
    resetCheck();
    setStep(next);
  };
  const titles = ["How would you like to connect?", method === "desktop" ? "Connect your OAIY computer" : "Add your API connection", "Choose your default AI"];
  return (
    <div className="min-h-screen">
      <Header title="Connect your AI" />
      {/* Starts at the left, on the title's line, as every workspace page does; the steps keep a readable width. */}
      <div className="w-full max-w-3xl space-y-5 px-4 pb-24 pt-4 sm:px-6">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 dark:text-slate-400 dark:hover:text-white"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Home
        </Link>
        <div>
          <h2 className="text-2xl font-semibold">
            Your AI, ready in three steps
          </h2>
          <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-slate-400">
            FormLogic is free. Connect an AI you already use, or skip setup and
            use the visual builders. Your AI provider may charge separately.
          </p>
        </div>
        <ol className="grid grid-cols-3 gap-2" aria-label="AI setup progress">
          {["Choose", "Connect", "Use in FormLogic"].map((label, i) => (
            <li
              key={label}
              aria-current={step === i ? "step" : undefined}
              className={`rounded-xl border p-3 text-sm ${step === i ? "border-primary-500 bg-primary-50 text-primary-800 dark:bg-primary-900/30 dark:text-primary-200" : "border-gray-200 dark:border-slate-700"}`}
            >
              <span className="block text-xs opacity-60">Step {i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <section
          onChange={resetCheck}
          className="min-w-0 space-y-5 rounded-2xl border border-gray-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900 sm:p-7"
        >
          <h3 ref={stepTitle} tabIndex={-1} className="scroll-mt-20 text-lg font-semibold focus:outline-none">{titles[step]}</h3>
          {step === 0 && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    [
                      "desktop",
                      Laptop,
                      "OAIY desktop",
                      "Use Codex with a ChatGPT sign-in, provider keys, or local models. OAIY can run on this computer or another one.",
                    ],
                    [
                      "custom",
                      KeyRound,
                      "My own API provider",
                      "Connect an API endpoint and key directly. This setup stays in this browser. Your provider must allow browser requests.",
                    ],
                  ] as const
                ).map(([value, Icon, title, detail]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={method === value}
                    onClick={() => setMethod(value)}
                    className={`cursor-pointer rounded-xl border p-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${method === value ? "border-primary-500 bg-primary-50 dark:border-primary-500/70 dark:bg-primary-950/30" : "border-gray-200 hover:border-gray-300 hover:bg-gray-50/70 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:bg-slate-800/50"}`}
                  >
                    <Icon size={22} className="mb-3" />
                    <strong className="block">{title}</strong>
                    <span className="mt-2 block text-sm leading-6 text-gray-500 dark:text-slate-400">
                      {detail}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          {step === 1 && method === "desktop" && (
            <>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">Connection method</legend>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 hover:border-gray-300 dark:border-slate-700 dark:hover:border-slate-600">
                  <input type="radio" name="desktop-connection" value="account" checked={desktopConnection === 'account'} onChange={() => setDesktopConnection('account')} className="mt-1" />
                  <span className="text-sm"><strong className="block">Through my FormLogic account</strong><span className="text-gray-500 dark:text-slate-400">Use OAIY from any device through the encrypted AI relay.</span></span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 hover:border-gray-300 dark:border-slate-700 dark:hover:border-slate-600">
                  <input type="radio" name="desktop-connection" value="local" checked={desktopConnection === 'local'} onChange={() => setDesktopConnection('local')} className="mt-1" />
                  <span className="text-sm"><strong className="block">Directly from this computer</strong><span className="text-gray-500 dark:text-slate-400">Pair this browser with OAIY running on the same computer.</span></span>
                </label>
              </fieldset>
              <ol className="list-decimal space-y-3 pl-5 text-sm leading-6">
                <li>
                  <a
                    href="https://oaiy.com/#download"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary-600 underline dark:text-primary-300"
                  >
                    Get OAIY
                  </a>{" "}
                  and open its Getting started guide.
                </li>
                <li>
                  Choose an AI in OAIY. For Codex, open Providers, install the
                  Codex CLI if needed, then choose Sign in with ChatGPT and
                  complete the browser sign-in. You need an eligible account.
                  Alternatively add an API key or a local model.
                </li>
                <li>
                  {desktopConnection === 'account'
                    ? 'In OAIY, open Connections → Linked account, enter this FormLogic site’s address and approve the account link in your browser. Keep OAIY running, then continue here from any device.'
                    : 'Use Connect below. Check and approve the matching code in OAIY, then return here.'}
                </li>
              </ol>
              {desktopConnection === 'local' && <LocalRuntimePanel />}
              <p className="text-sm text-gray-500 dark:text-slate-400">
                {desktopConnection === 'account'
                  ? 'No port forwarding or localhost pairing is needed. Select your AI provider in the next step. If several computers are linked, choose their assignments in Settings → AI & devices → Linked desktops.'
                  : 'Pairing lets this browser use OAIY. Your AI provider is selected in the next step.'}
              </p>
            </>
          )}
          {step === 1 && method === "custom" && (
            <>
              <ol className="list-decimal space-y-3 pl-5 text-sm leading-6">
                <li>
                  Have your provider endpoint, model name and API key ready.
                </li>
                <li>
                  Open AI services, choose Add, and select the matching provider
                  preset.
                </li>
                <li>
                  Save it and use Test connection. A test may send a small
                  request billed by your provider.
                </li>
              </ol>
              <Button onClick={() => setServicesOpen(true)}>
                Add or test an AI service
              </Button>
              <p className="text-sm text-gray-500 dark:text-slate-400">
                Keys use the existing browser credential store. For a provider
                that blocks browser requests, configure it in OAIY instead.
              </p>
            </>
          )}
          {step === 2 && (
            <>
              <p className="text-sm text-gray-500 dark:text-slate-400">
                Select the provider you connected. These settings power chat and
                automations using your default AI.
              </p>
              <AiSourceCard preferredSource={method} remoteOnly={method === 'desktop' && desktopConnection === 'account'} />
              <div className="border-t border-gray-200 pt-5 dark:border-slate-700">
                <Button onClick={() => void verify()} isLoading={checking}>
                  Check saved setup
                </Button>
                <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">
                  Checks your saved selection and available provider. It does
                  not send a paid AI prompt.
                </p>
              </div>
              {error && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}
              {ready && (
                <div
                  role="status"
                  className="space-y-3 rounded-xl bg-green-50 p-4 text-green-800 dark:bg-green-950/40 dark:text-green-200"
                >
                  <p className="flex items-center gap-2">
                    <Check size={18} />
                    Your provider is selected.
                  </p>
                  <p className="text-sm">
                    Try a short chat to check a real response. Some document and
                    specialised generation tools still require operator-enabled
                    Site AI.
                  </p>
                  <Link
                    to="/"
                    className="inline-flex rounded-lg bg-primary-600 px-4 py-2 text-sm text-primary-foreground"
                  >
                    Return to your workspace
                  </Link>
                </div>
              )}
            </>
          )}
        </section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {step > 0 ? (
            <Button variant="outline" onClick={() => changeStep(step - 1)}>
              Back
            </Button>
          ) : (
            <Link to="/" className="text-sm text-gray-500 underline hover:text-gray-900 dark:text-slate-400 dark:hover:text-white">
              Skip for now
            </Link>
          )}
          {step < 2 && (
            <Button onClick={() => changeStep(step + 1)}>Continue</Button>
          )}
        </div>
        {servicesOpen && (
          <AiServicesDialog
            isOpen
            apiOnly
            onClose={() => setServicesOpen(false)}
            desktopPresence={presence}
          />
        )}
      </div>
    </div>
  );
}
