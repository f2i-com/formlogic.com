import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { downloadHostedClient } from "../../lib/hosting";
import { useHostedRuntime } from "../../lib/useHostedRuntime";
import { HostedAppFrame } from "../../components/studio/HostedAppFrame";

export default function HostedAppPage() {
  const { appSlug = "" } = useParams();
  const app = useHostedRuntime(appSlug);
  const [downloadError, setDownloadError] = useState("");
  const error = app?.error || (app?.deployment ? downloadError : '');
  return (
    <main className="flex h-dvh min-h-[400px] flex-col bg-slate-50 p-2 sm:p-4 dark:bg-slate-950">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2 px-2">
        <Link
          to={`/app/${encodeURIComponent(appSlug)}`}
          className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-600 dark:text-slate-300"
        >
          <ArrowLeft size={16} />
          Back to app
        </Link>
        <h1 className="min-w-0 break-words font-semibold text-slate-900 dark:text-white">
          {app?.name || "Your app"}
        </h1>
        {app?.deployment && (
          <button
            className="inline-flex min-h-11 items-center gap-2 text-sm text-indigo-600 dark:text-indigo-300"
            onClick={() =>
              void downloadHostedClient(app.deployment!.client, app.name || 'App').catch(
                () => setDownloadError("Could not download the project."),
              )
            }
          >
            <Download size={16} />
            Download project
          </button>
        )}
      </header>
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900"
        >
          {error}
        </p>
      )}
      {app?.deployment && app.admission ? (
        <div className="min-h-0 flex-1">
          <HostedAppFrame
            slug={appSlug}
            client={app.deployment.client}
            version={app.deployment.version}
            engine={app.engine}
            hostedAdmission={app.admission}
          />
        </div>
      ) : (
        !error && (
          <div role="status" className="m-auto flex gap-2 text-sm">
            <Loader2 size={18} className="animate-spin" />
            Opening your app…
          </div>
        )
      )}
    </main>
  );
}
