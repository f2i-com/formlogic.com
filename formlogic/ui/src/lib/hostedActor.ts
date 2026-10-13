import { currentSessionGeneration, currentSessionOwner, isSessionGenerationCurrent } from './sessionGeneration';

/** Compare-only server identity. It grants no authority and is never read from guest input. */
export type HostedActor = Readonly<{
  version: 1; appId: string; userId: string; roleId: string | null; isOwner: boolean; sessionId: string;
}>;
export type HostedRequest = Readonly<{ generation: number; userId: string | null }>;
export type HostedAdmission = Readonly<{ slug: string; generation: number; actor: HostedActor }>;
export const HOSTED_ACTOR_ERROR = 'This app could not verify your current access. Reload or sign in again.';
const fields = ['appId', 'isOwner', 'roleId', 'sessionId', 'userId', 'version'];
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);

export function copyHostedActor(value: unknown): HostedActor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== fields.join(',') || record.version !== 1 ||
    typeof record.appId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(record.appId) || !identifier(record.userId) || typeof record.isOwner !== 'boolean' ||
    (record.isOwner ? record.roleId !== null : !identifier(record.roleId)) ||
    typeof record.sessionId !== 'string' || !/^[a-f0-9]{64}$/.test(record.sessionId)) return null;
  return Object.freeze({ version: 1, appId: record.appId, userId: record.userId,
    roleId: record.roleId as string | null, isOwner: record.isOwner, sessionId: record.sessionId });
}
export function sameHostedActor(left: HostedActor, right: unknown): boolean {
  const actor = copyHostedActor(right);
  return !!actor && fields.every(field => left[field as keyof HostedActor] === actor[field as keyof HostedActor]);
}
export const captureHostedRequest = (): HostedRequest => Object.freeze({ generation: currentSessionGeneration(), userId: currentSessionOwner() });
export const isHostedRequestCurrent = (request: HostedRequest): boolean => isSessionGenerationCurrent(request.generation) && request.userId === currentSessionOwner();

/** Capture before fetching; a delayed source prop cannot grant itself a new session. */
export function admitHostedActor(value: unknown, request: HostedRequest, slug: string, appId?: string): HostedAdmission | null {
  const actor = copyHostedActor(value);
  if (!actor || !request.userId || !isHostedRequestCurrent(request) || actor.userId !== request.userId ||
    !slug || (appId !== undefined && actor.appId !== appId)) return null;
  return Object.freeze({ slug, generation: request.generation, actor });
}
export function isHostedAdmissionCurrent(admission: HostedAdmission | undefined | null, slug: string): admission is HostedAdmission {
  return !!admission && admission.slug === slug && isSessionGenerationCurrent(admission.generation) &&
    admission.actor.userId === currentSessionOwner() && !!copyHostedActor(admission.actor);
}
