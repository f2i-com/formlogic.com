// §11B O2 — the "Connect your AI" wizard: three doors, honestly explained.
//
// Opening a toolbox, not passing airport security: each door says what it's best for,
// what it needs, and where it leads — and "Skip for now" is always visible. The doors
// live in components/ai/ConnectAiDoors (shared with the create-app precursor).
import { Link } from 'react-router-dom';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { Header } from '../components/layout/Header';
import { ConnectAiDoors } from '../components/ai/ConnectAiDoors';

// Rendered INSIDE AppShell (audit FL-24): the shell already provides the sidebar
// and content offset — rendering a second <Sidebar /> + md:pl-72 here produced
// duplicate navigation landmarks and a double offset on desktop AND mobile.
export default function ConnectAiWizard() {
  return (
    <div className="min-h-screen">
      <Header title="Connect your AI" />
      <main className="mx-auto max-w-3xl px-4 pb-16 pt-6 sm:pt-8">
        <Link
          to="/"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Dashboard
        </Link>
        <h1 className="mt-3 flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">
          <Sparkles className="h-6 w-6 text-primary-600 dark:text-primary-300" />
          Connect your AI
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-gray-500 dark:text-slate-400">
          Bring an AI and FormLogic becomes a copilot — describe what you want and watch it
          get built. Three ways in, each with different strengths. You can connect more than
          one, and change your default any time in Settings.
        </p>

        <div className="mt-6">
          <ConnectAiDoors />
        </div>

        <p className="mt-6 text-center text-sm text-gray-400 dark:text-slate-500">
          Not now?{' '}
          <Link to="/" className="font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-300">
            Skip for now
          </Link>{' '}
          — the visual builders are always available.
        </p>
      </main>
    </div>
  );
}
