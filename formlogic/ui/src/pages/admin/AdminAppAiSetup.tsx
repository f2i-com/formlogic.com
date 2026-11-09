// Admin → Platform → AI for apps: the setup checklist at the top of the card.
//
// Five lines, each with its live state and one action: a computer for the site's AI, the site's AI
// running on it, apps allowed, a picture model, and a test picture through the real worker. Each
// action takes effect at once (with the usual administrator confirmation). It also adapts when the
// site's AI is the provider in the server's settings. See docs/FREE_PLANS_AND_AI_SETUP.md, "AI for apps".
import { useState, type ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AiTestResult } from '../../components/apps/AiTestResult';
import { PictureModelField } from '../../components/apps/PictureModelField';
import { useAiTest, useLinkWatch, useModelList } from '../../components/apps/useAiTest';
import { ConnectOaiyServer } from '../../components/desktop/ConnectOaiyServer';
import { Button } from '../../components/ui/Button';
import { Switch } from '../../components/ui/Switch';
import { api, type SiteAiDesktopState } from '../../lib/api';
import { sinceWords, suggestedPictureModel, whenWords, type AppAiAdminView, type AppAiSetup, type AppAiSiteSettings } from '../../lib/appAi';
import { announceSiteAiChanged } from '../../lib/siteAiEvents';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';

const ENGINE = 'oaiy-engine';
/** A worker that has made no pass for this long is not running. */
const WORKER_QUIET_SECONDS = 150;
const PROVIDER = 'the AI provider in your server settings';
/** The Plans card's switch for members' Site AI, by the name it has there. */
const SITE_AI_SWITCH = '“Offer operator-funded Site AI”';
const muted = 'text-sm text-gray-600 dark:text-slate-300';
const small = 'text-xs text-gray-500 dark:text-slate-400';
const field = 'block min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white';

function Step({ number, title, done, next, children }: { number: number; title: string; done: boolean; next: boolean; children: ReactNode }) {
  return (
    <li
      data-testid={`ai-setup-step-${number}`}
      data-done={done ? 'yes' : 'no'}
      className={cn('flex gap-3 rounded-xl border p-3 sm:p-4', next ? 'border-primary-400 bg-primary-50/50 dark:border-primary-500/50 dark:bg-primary-500/5' : 'border-gray-200 dark:border-slate-700')}
    >
      <span className="mt-0.5 shrink-0" aria-hidden="true">
        {done
          ? <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
          : <span className={cn('flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-semibold', next ? 'border-primary-500 text-primary-700 dark:text-primary-300' : 'border-gray-400 text-gray-500 dark:border-slate-500 dark:text-slate-400')}>{number}</span>}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}<span className="sr-only">{done ? ': done' : ': to do'}</span></h3>
        {children}
      </div>
    </li>
  );
}

function Presence({ online, lastSeenAt }: { online: boolean; lastSeenAt: string | null }) {
  return online
    ? <span className="text-green-700 dark:text-green-300">online</span>
    : <span className="text-amber-700 dark:text-amber-300">offline{lastSeenAt ? ` ${sinceWords(lastSeenAt)}` : ''}</span>;
}

export function AdminAppAiSetup({ setup, settings, desktop, onReload, onSaved }: {
  setup: AppAiSetup;
  /** The settings as saved. */
  settings: AppAiSiteSettings;
  /** The administrator's linked computers, and the one chosen. */
  desktop: SiteAiDesktopState | null;
  /** Read everything again: after a computer is chosen or linked, or Site AI switched. */
  onReload: () => Promise<void>;
  /** After a setting was saved here. */
  onSaved: (view: AppAiAdminView) => void;
}) {
  const candidates = desktop?.candidates ?? [];
  const engine = desktop?.engineProvider ?? ENGINE;
  const source = setup.source;
  const computer = setup.computer;
  const name = computer ? computer.deviceName || 'your computer' : '';
  const [busy, setBusy] = useState<string | null>(null);
  const [pictureDraft, setPictureDraft] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState<string | null>(null);

  // The chosen computer's models, read live while it is online: its picture models (OAIY's own
  // engines draw them), and, where another provider on it chats, that provider's models.
  const listKey = computer && computer.online ? computer.connectionId : null;
  const ownProvider = computer !== null && computer.providerId !== engine;
  const pictures = useModelList(listKey, () => api.adminOaiyModels(computer?.connectionId ?? '', engine));
  const chats = useModelList(listKey && ownProvider ? `${listKey}|${computer?.providerId}` : null, () => api.adminOaiyModels(computer?.connectionId ?? '', computer?.providerId ?? engine));
  const pictureModels = pictures.models ? pictures.models.filter((model) => model.type === 'image') : null;
  const chatModels = chats.models ? chats.models.filter((model) => !model.type) : null;
  const suggestion = pictureModels ? suggestedPictureModel(pictureModels) : null;
  const picture = pictureDraft ?? settings.pictureModel ?? suggestion ?? '';
  const chat = chatDraft ?? settings.chatModel ?? '';
  const modelsChanged = picture !== (settings.pictureModel ?? '') || chat !== (settings.chatModel ?? '');

  // A server just linked by code appears here once OAIY has started on it: keep looking until it does.
  const { watching, start: linked } = useLinkWatch(candidates.length, onReload);

  const changeSite = async (key: string, work: () => Promise<{ error?: string; data?: unknown }>, failed: string) => {
    setBusy(key);
    const result = await work();
    setBusy(null);
    if (result.error || !result.data) { toast.error(failed, result.error ?? ''); return; }
    announceSiteAiChanged();
    await onReload();
  };
  const chooseComputer = (connectionId: string) => changeSite(`use:${connectionId}`, () => api.adminPutSiteAiDesktop(connectionId), 'The computer was not chosen');
  const forget = () => changeSite('forget', () => api.adminDeleteSiteAiDesktop(), 'It was not forgotten');
  const turnOnSiteAi = () => changeSite('site-ai', async () => {
    const plans = await api.adminGetPlans();
    return plans.data ? api.adminPutPlans({ ...plans.data.plans, siteAiEnabled: true }) : plans;
  }, 'Site AI was not turned on');
  const save = async (key: string, change: Partial<AppAiSiteSettings>): Promise<boolean> => {
    setBusy(key);
    const result = await api.adminPutAppAi({ ...settings, ...change });
    setBusy(null);
    if (result.error || !result.data) { toast.error('Not saved', result.error ?? ''); return false; }
    onSaved(result.data);
    return true;
  };
  const saveModels = async () => {
    if (await save('models', { pictureModel: picture || null, chatModel: chat || null })) { setPictureDraft(null); setChatDraft(null); }
  };

  const { test, error: testError, run, running } = useAiTest(
    (kind) => api.adminTestAppAi(kind),
    (id) => api.adminGetAppAiTest(id),
    // What the server now keeps as the last test is what marks the fifth line.
    () => void onReload(),
  );

  // The four things apps need; the test is how to see that they work.
  const usesProvider = source === 'env' && candidates.length === 0;
  const step1 = source === 'computer' || source === 'env' || candidates.length > 0;
  const step2 = source === 'computer' || (source === 'env' && setup.provider.on);
  const step3 = settings.allowApps;
  const step4 = settings.pictureModel !== null;
  const steps = [step1, step2, step3, step4];
  const left = steps.filter((done) => !done).length;
  const next = steps.indexOf(false) + 1;
  const where = source === 'computer' ? name : PROVIDER;
  const chatWorks = step3 && !settings.paused && setup.kinds.includes('chat');
  const summary: { tone: 'ready' | 'warn' | 'todo'; text: string } = setup.ready
    ? (computer && !computer.online
      ? { tone: 'warn', text: `Ready, but ${name} is offline. Apps' requests wait until it is back.` }
      : { tone: 'ready', text: `Ready: apps can make pictures with ${settings.pictureModel} on ${where}.` })
    : left > 0 ? { tone: 'todo', text: `${left} step${left === 1 ? '' : 's'} left before apps can make pictures.${!step4 && left === 1 && chatWorks ? ' Chat already works.' : ''}` }
    : settings.paused ? { tone: 'warn', text: 'Paused: you have paused every app\'s AI. Turn the pause off below when you are ready.' }
    : !setup.drawing ? { tone: 'warn', text: 'Not ready: this server cannot prepare pictures for apps. It needs PHP\'s GD extension.' }
    : { tone: 'warn', text: 'Not ready yet. Make a test picture to see why.' };

  const canDraw = setup.kinds.includes('picture');
  const canChat = setup.kinds.includes('chat');
  const workerQuiet = step2 && (setup.workerIdleSeconds === null || setup.workerIdleSeconds > WORKER_QUIET_SECONDS);
  const others = candidates.filter((candidate) => candidate.connectionId !== computer?.connectionId);
  // The last test picture counts while it is about what is set up now: the model, and where the
  // site's AI runs, have not changed since it was made.
  const last = setup.lastTest ?? null;
  const proven = last !== null && last.status === 'done' && last.current;
  const offline = computer !== null && !computer.online;
  const lastWhen = last ? whenWords(last.at) : '';

  /** The linked computers that are not the chosen one, each with a button that makes it the site's AI. */
  const computerChoices = (action: string, lead: boolean) => (
    <ul className="space-y-2">
      {others.map((candidate, index) => (
        <li key={candidate.connectionId} className="flex flex-wrap items-center justify-between gap-2">
          <span className={muted}><strong className="text-gray-900 dark:text-white">{candidate.deviceName || 'A linked computer'}</strong> · <Presence online={candidate.online} lastSeenAt={candidate.lastSeenAt} /></span>
          <Button size="sm" variant={lead && index === 0 ? 'primary' : 'outline'} isLoading={busy === `use:${candidate.connectionId}`} disabled={busy !== null} onClick={() => void chooseComputer(candidate.connectionId)}>{action}</Button>
        </li>
      ))}
    </ul>
  );

  return (
    <section aria-label="Set up AI for apps" className="space-y-3" data-testid="ai-setup">
      <p
        role="status"
        data-testid="ai-setup-summary"
        className={cn('rounded-xl px-4 py-3 text-sm font-medium',
          summary.tone === 'ready' ? 'bg-green-50 text-green-900 dark:bg-green-500/10 dark:text-green-200'
            : summary.tone === 'warn' ? 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200'
              : 'bg-gray-100 text-gray-800 dark:bg-slate-800 dark:text-slate-200')}
      >
        {summary.text}
      </p>
      <ol className="space-y-2">
        <Step number={1} title={usesProvider ? 'Where the site\'s AI runs' : 'A computer for the site\'s AI'} done={step1} next={next === 1}>
          {source === 'computer' && computer && <p className={muted}><strong className="text-gray-900 dark:text-white">{name}</strong> · <Presence online={computer.online} lastSeenAt={computer.lastSeenAt} /></p>}
          {source === 'gone' && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
              <span><strong>{setup.gone?.deviceName || 'The computer you chose'}</strong> was unlinked or has a new key, so nothing is sent to it. {others.length > 0 ? 'Choose a computer again in step 2.' : 'Link it again, or forget it.'}</span>
              <Button size="sm" variant="outline" isLoading={busy === 'forget'} onClick={() => void forget()}>Forget it</Button>
            </div>
          )}
          {source !== 'computer' && others.length > 0 && (
            <p className={muted}>
              {others.map((candidate, index) => <span key={candidate.connectionId}>{index > 0 ? ', ' : ''}<strong className="text-gray-900 dark:text-white">{candidate.deviceName || 'A linked computer'}</strong> (<Presence online={candidate.online} lastSeenAt={candidate.lastSeenAt} />)</span>)}
              {others.length === 1 ? ' is linked.' : ' are linked.'}
            </p>
          )}
          {usesProvider && <p className={muted}>This site&apos;s AI is {PROVIDER}. To run it on a computer of your own instead, link one:</p>}
          {source === 'none' && others.length === 0 && <p className={muted}>None yet. Link the computer that runs OAIY:</p>}
          {source !== 'computer' && others.length === 0 && <ConnectOaiyServer compact onLinked={linked} />}
          {watching && <p className={small} role="status">Looking for the new computer. It appears here once OAIY has started on it.</p>}
          {source === 'none' && others.length === 0 && (
            <p className={small}>Using OAIY on your own desktop? Link it in <Link className="font-medium text-indigo-600 underline underline-offset-2 dark:text-indigo-300" to="/settings#local-runtime">Settings → AI &amp; devices</Link> instead; it then shows here.</p>
          )}
        </Step>

        <Step number={2} title={usesProvider ? 'Site AI is turned on' : 'This site\'s AI runs on it'} done={step2} next={next === 2}>
          {source === 'computer' && (
            <>
              <p className={muted}>This site&apos;s AI runs on <strong className="text-gray-900 dark:text-white">{name}</strong>.</p>
              {!setup.provider.on && <p className={small}>Members&apos; own Site AI is a separate switch: {SITE_AI_SWITCH}, in Plans &amp; AI above. Apps do not need it.</p>}
              {others.length > 0 && (
                <>
                  <p className={small}>Your other linked computers:</p>
                  {computerChoices('Use this one instead', false)}
                </>
              )}
            </>
          )}
          {source !== 'computer' && others.length > 0 && (
            <>
              {source === 'env' && setup.provider.on && <p className={muted}>For now, requests go to {PROVIDER}. To use your own computer instead:</p>}
              {computerChoices('Use this computer', !step2)}
              {source === 'env' && !setup.provider.on && (
                <p className={small}>
                  Or use {PROVIDER}: <button type="button" className="font-medium text-indigo-600 underline underline-offset-2 dark:text-indigo-300" disabled={busy !== null} onClick={() => void turnOnSiteAi()}>turn on Site AI</button>. It may charge you for each request, and members can use it too.
                </p>
              )}
            </>
          )}
          {usesProvider && (setup.provider.on
            ? <p className={muted}>On. Apps&apos; requests go to {PROVIDER}, which may charge you for each one.</p>
            : (
              <>
                <p className={muted}>Site AI is off, so {PROVIDER} is not used. Turning it on lets apps, and members, use it. Your provider may charge you for each request.</p>
                <p className={small}>It is the same switch as {SITE_AI_SWITCH}, in Plans &amp; AI above.</p>
                <Button size="sm" isLoading={busy === 'site-ai'} disabled={busy !== null} onClick={() => void turnOnSiteAi()}>Turn on Site AI</Button>
              </>
            ))}
          {!usesProvider && source !== 'computer' && others.length === 0 && <p className={small}>Link a computer first.</p>}
        </Step>

        <Step number={3} title="Apps may use the site's AI" done={step3} next={next === 3}>
          <div className="flex items-start gap-3">
            <Switch ariaLabel="Apps may use the site's AI" checked={settings.allowApps} disabled={busy !== null} onChange={(on) => void save('allow', { allowApps: on })} />
            <p className={muted}>{settings.allowApps ? 'On. Each app\'s owner still turns AI on for their own app.' : 'Off. No app can use the site\'s AI until you turn this on.'}</p>
          </div>
        </Step>

        <Step number={4} title="Picture model" done={step4} next={next === 4}>
          {!step2 ? <p className={small}>Choose where the site&apos;s AI runs first.</p> : (
            <>
              <label htmlFor="ai-setup-picture-model" className={muted}>{step4 ? 'Apps\' pictures are made with:' : 'The model that makes apps\' pictures:'}</label>
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1 basis-56">
                  <PictureModelField
                    id="ai-setup-picture-model"
                    models={source === 'computer' ? pictureModels : null}
                    listing={pictures.listing}
                    error={pictures.error}
                    noList={source === 'env' ? 'provider' : computer && !computer.online ? 'offline' : null}
                    value={picture}
                    onChange={setPictureDraft}
                    onRetry={pictures.retry}
                  />
                </div>
                {modelsChanged && <Button size="sm" isLoading={busy === 'models'} disabled={busy !== null} onClick={() => void saveModels()}>{step4 ? 'Save' : 'Use this model'}</Button>}
              </div>
              {!step4 && suggestion !== null && picture === suggestion && <p className={small}>Suggested: {suggestion}, from the models on {name}.</p>}
              {source === 'computer' && !ownProvider && <p className={small}>Chat is answered by the model chosen in OAIY on {name}.</p>}
              {(source === 'env' || ownProvider) && (
                <div className="space-y-1">
                  <label htmlFor="ai-setup-chat-model" className={muted}>Chat model (optional):</label>
                  {chatModels && chatModels.length > 0 ? (
                    <select id="ai-setup-chat-model" className={field} value={chat} onChange={(event) => setChatDraft(event.target.value)}>
                      <option value="">The one the site&apos;s AI already uses</option>
                      {chatModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                      {chat !== '' && !chatModels.some((model) => model.id === chat) && <option value={chat}>{chat}</option>}
                    </select>
                  ) : (
                    <input id="ai-setup-chat-model" className={field} value={chat} placeholder="The one the site's AI already uses" autoComplete="off" spellCheck={false} onChange={(event) => setChatDraft(event.target.value.trim())} />
                  )}
                </div>
              )}
              {!step4 && canChat && <p className={small}>Until you choose one, apps can use chat only.</p>}
            </>
          )}
        </Step>

        <Step number={5} title="Make a test picture" done={proven} next={next === 0 && !proven}>
          <p className={muted}>A real small picture, made the way an app&apos;s would be. It shows every part works, and how long a picture takes.</p>
          {workerQuiet && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200" role="alert">
              Nothing is running the AI worker on this server{setup.workerIdleSeconds === null ? ' yet' : ` (it last ran ${Math.round(setup.workerIdleSeconds / 60)} minutes ago)`}, so apps&apos; requests, and this test, would only wait.
              Set <code>php bin/app-ai-worker.php</code> to run every minute (DEPLOYMENT.md, &ldquo;Every scheduled job&rdquo;).
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={next === 0 && !proven && !offline ? 'primary' : 'outline'} disabled={!canDraw || running} isLoading={running && test?.kind !== 'chat'} onClick={() => void run('picture')}>Make a test picture</Button>
            <Button size="sm" variant="outline" disabled={!canChat || running} isLoading={running && test?.kind === 'chat'} onClick={() => void run('chat')}>Test chat</Button>
          </div>
          {!canDraw && <p className={small}>{!step2 ? 'Choose where the site\'s AI runs first (steps 1 and 2).' : !step4 ? 'Choose a picture model first (step 4).' : !setup.drawing ? 'This server cannot prepare pictures: it needs PHP\'s GD extension.' : 'The site\'s AI cannot make pictures now.'}</p>}
          {canDraw && offline && !test && <p className={small}>{name} is offline, so a test waits until it is back.</p>}
          {testError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{testError}</p>}
          {test && <AiTestResult test={test} computer={name || undefined} />}
          {!test && last && canDraw && (
            <p className={small} data-testid="ai-setup-last-test">
              {last.status === 'failed' ? <>The last test <strong className="text-red-600 dark:text-red-400">failed</strong> {lastWhen}: {last.message || 'the AI gave no reason.'}</>
                : last.current ? <>The last test <strong className="text-green-700 dark:text-green-300">worked</strong> {lastWhen}{last.seconds != null ? `, made in ${last.seconds.toFixed(1)} s` : ''}{last.model ? ` with ${last.model}` : ''}.</>
                  : <>The last test worked {lastWhen}{last.model ? ` with ${last.model}` : ''}, but the model, or where the site&apos;s AI runs, has changed since. Make another to be sure.</>}
            </p>
          )}
        </Step>
      </ol>
    </section>
  );
}
