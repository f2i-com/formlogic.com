# Native runtime session isolation

This change separates members-only native browser data by FormLogic installation and account, and applies the ordinary runtime visibility policy to archived owners. It does not change an application's independent native-login policy.

## Admission and persisted data

After visibility and membership admission, the native runtime GET returns `project.access` and a host-owned `project.storageScope`:

```ts
{ access: 'members', appId: string, userId: string }
{ access: 'application', appId: string }
```

The controller derives these values from the settled project, installation and authenticated request. Manifest metadata, iframe messages and a client-selected account cannot supply them. The page and every engine refetch require a valid descriptor matching `project.access`; member identity must also match the current session owner. Missing metadata fails closed before storage access or frame initialization. Deploy the backend descriptor and frontend consumer together; the new frontend intentionally refuses older responses without it.

`nativeAppStorage` keeps the existing bounded JSON string-map format under these keys:

| Access | Key and policy |
| --- | --- |
| Members | `formlogic:native-member-storage:v1:<encoded userId>:<encoded appId>`; account and installation scoped, independent of role or slug changes. |
| Application | Existing `formlogic:native-storage:<encoded slug>`; independent native login may persist across FormLogic logout, including anonymous use. |

Member reads, writes, export and reset never adopt or expose an unattributed legacy slug map. Existing legacy bytes are not assigned to the first member after upgrade. Switching access modes selects the corresponding policy; it does not migrate data between namespaces.

A same-principal reload retains member data. An unconfirmed startup transport failure also preserves it, while invalidating access until server admission succeeds. Logout, confirmed expiry and account transitions synchronously attempt to purge the departing account's member keys. Browser storage failure makes physical deletion best effort: the current tab remembers an unfinished purge and retries before allowing that member's next access. This memory is not a durable deletion guarantee across reload. Other principals still use different keys. Application-mode data remains outside this purge.

## Session and runtime boundaries

Generation changes synchronously invalidate old storage handles and frame callbacks, abort requests, and dispose message ports. Startup GETs, engine downloads/refetches, API unauthorized/auth-hint effects, workspace continuations and recovery controls check their captured session or mount before applying effects. A same-owner new session needs fresh server admission. Refetched engine overrides belong to the complete source and admission they replaced.

Cross-tab transitions use non-secret ordering metadata through `BroadcastChannel` and storage events. Messages invalidate stale state; they never authenticate or hydrate their claimed user. Delivery depends on browser support. Cleanup from an old tab must not overwrite a newer account's persisted platform state.

Native runtime GET and request POST now return 404 for archived apps, including their owner, before project or native execution. Owner draft previews remain allowed; owner administration remains available. Restoring an archived app to draft is an explicit administrative operation.

## Guest compatibility, rollback and limits

The host negotiates `storageProtocol: 1` only when the guest announces it. Compatible guests receive acknowledged storage batches and disposal messages; older guests retain single-operation compatibility and cannot claim acknowledged batches. Published SoftN v0.0.20 does not contain this guest acknowledgment extension. Its separate candidate port and validation belong in the release handoff; host tests do not establish published guest support.

No database migration is needed. Rolling back to an old host can again read unattributed slug-only snapshots; that rollback must not be described as preserving isolation. Do not copy member keys back into legacy maps. Retain the repaired admission and namespace behavior, or suspend affected member runtimes while resolving a rollback.

Client fences cannot undo HTTP `Set-Cookie` processing or a server mutation already accepted. Timing of unowned Workbox queue cleanup is outside this repair. The current CSRF middleware binds the request header to the auth cookie with HMAC: an account A header under account B's cookie is rejected on protected requests. No cross-account queued write is established by this work.

Evidence is offline source, module and jsdom validation. Full cross-tab browser/native qualification, including offline transitions, remains pending; no live qualification or publication is asserted here. Exact revisions and check results belong in the accompanying review handoff.

Implementation: [controller](../formlogic/backend/src/Controllers/NativeAppController.php), [storage](../formlogic/ui/src/lib/nativeAppStorage.ts), [session lifecycle](../formlogic/ui/src/stores/authStore.ts), [frame](../formlogic/ui/src/components/studio/HostedAppFrame.tsx), [page](../formlogic/ui/src/pages/apps/NativeAppPage.tsx), [API](../formlogic/ui/src/lib/api.ts), [CSRF policy](../formlogic/backend/src/Middleware/CsrfMiddleware.php).
