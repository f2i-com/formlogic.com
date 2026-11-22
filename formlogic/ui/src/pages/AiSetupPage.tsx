import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Bot, Copy } from 'lucide-react';
import { useState } from 'react';
import { copyToClipboard } from '../lib/utils';

export default function AiSetupPage() {
  useDocumentTitle('Connect your AI');
  const [message, setMessage] = useState('');
  const endpoint = `${window.location.origin}/api/mcp`;
  async function copyAddress() {
    const copied = await copyToClipboard(endpoint);
    setMessage(copied ? 'MCP address copied.' : 'Select and copy the address above.');
  }

  return <main className="min-h-dvh bg-slate-50 px-5 py-10 text-slate-900 dark:bg-slate-950 dark:text-white sm:py-16">
    <div className="mx-auto max-w-3xl">
      <Link to="/" className="inline-flex min-h-11 items-center gap-2 text-sm text-primary-600 dark:text-primary-300"><ArrowLeft size={16} />FormLogic home</Link>
      <Bot className="mt-8 h-9 w-9 text-primary-600 dark:text-primary-400" aria-hidden="true" /><h1 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">Build with your own AI.</h1>
      <p className="mt-5 text-lg leading-8 text-slate-600 dark:text-slate-300">From a first form to a connected app, your AI can help build the interface, backend scripts and workflows. You choose what it can access.</p>
      <ol className="mt-10 space-y-4">
        <li className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"><h2 className="text-xl font-semibold">1. Create your workspace</h2><p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">Create a free account or sign in. Complete any account verification yourself, then continue straight to AI setup.</p><div className="mt-4 flex flex-wrap gap-5"><Link className="inline-flex min-h-11 items-center gap-2 text-primary-600 hover:underline dark:text-primary-300" to="/signup?redirect=%2Fconnect-ai">Create account <ArrowRight size={16} aria-hidden="true" /></Link><Link className="inline-flex min-h-11 items-center text-primary-600 hover:underline dark:text-primary-300" to="/login?redirect=%2Fconnect-ai">Sign in</Link></div></li>
        <li className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"><h2 className="text-xl font-semibold">2. Connect an AI</h2><p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">Use the guided setup for OAIY or your own API provider. To build from an external AI client, add the MCP address below and complete FormLogic’s sign-in and permission review.</p><Link className="mt-3 inline-flex min-h-11 items-center text-primary-600 hover:underline dark:text-primary-300" to="/connect-ai">Open AI setup</Link><div className="mt-4 flex flex-col items-stretch gap-3 rounded-xl bg-slate-100 p-4 dark:bg-slate-800 sm:flex-row sm:items-center"><code className="min-w-0 flex-1 break-all text-sm">{endpoint}</code><button type="button" className="inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-700" onClick={copyAddress}><Copy size={16} aria-hidden="true" />Copy MCP address</button></div>{message && <p role="status" className="mt-2 text-sm text-emerald-700 dark:text-emerald-300">{message}</p>}</li>
        <li className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"><h2 className="text-xl font-semibold">3. Describe the app you need</h2><p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">For example: “Create a customer workspace with enquiries and bookings. Add a connected dashboard. Bring my Aokie forms into it and show me the automation permissions before moving them.”</p><p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">Your AI can read the current project, create forms, write private backend actions, publish the app project and connect existing apps. App-scoped connections stay within that app; combining two apps needs access to both.</p></li>
      </ol>
      <p className="mt-7 text-sm leading-6 text-slate-500 dark:text-slate-400">Hosted AI clients need a publicly reachable HTTPS address. A local MCP client can use this local server. Account sign-in, connector consent and hardware pairing remain explicit steps.</p>
      <a href="/llms.txt" className="mt-4 inline-flex min-h-11 items-center text-sm text-primary-600 dark:text-primary-300">Read the setup guide for AI assistants <ArrowRight className="ml-2" size={16} /></a>
    </div>
  </main>;
}
