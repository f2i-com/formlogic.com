# Windows sandbox watchdog

Windows form-expression and onSubmit execution uses one directly launched watchdog
for each runtime invocation. The watchdog retains the original process handle;
it never runs `ping`, `taskkill`, a shell command, or a PID-tree search.

## Windows requirements and compatibility

The shipped native launcher and native launcher overrides remain supported,
including the `FORMLOGIC_RUNTIME_BIN` and legacy `FORMLOGIC_QJS_BIN` settings.
**Windows `.bat` and `.cmd` overrides now fail closed.** Previously accepted,
undocumented script wrappers can create descendants outside the directly owned
process. Use the native launcher executable instead. A trusted native override
must follow the same contract: no OS child-process tree, and exit on stdin EOF
before receiving a job. This watchdog does not promise arbitrary process-tree
cleanup. The shipped Wasmtime launcher embeds its guest and creates only threads.

The helper runs with Windows' built-in
`SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe`, `-NoProfile`,
`-NonInteractive` and `-File`. It needs no new credential, service or environment
pin. It does not change execution policy, request a policy bypass, or change
Constrained Language settings. An installation that blocks the script or required
.NET process operations will reject runtime work at startup. File presence alone
is not proof of helper availability. Keep the PHP temporary directory under the
application account's control, as for other runtime temporary files.

## Acquisition, compute windows and owner loss

PHP starts the native runtime and retains its original process resource. The
helper opens that target once and retains its `Process.SafeHandle`. PHP sends a
random per-run HELLO challenge through the helper's exact stdin pipe. This is an
inert protocol challenge, not an account credential. Only a challenge-bound READY
acknowledgment can authorize PHP to send ARM; only ARM permits helper termination.
Before ARM, EOF, timeout and errors exit without killing anything. This remains
safe if PHP dies before acquisition and its former PID is later reused.

The helper creates its acknowledgment file once, refuses an existing path and
holds its write handle until exit. Sharing permits reads but no second writer or
delete. Acknowledgments include the challenge, command sequence and target PID.
PHP waits for the exact acknowledgment and confirms helper liveness before
sending the initial job or a host-call reply.

PAUSE disarms the helper before it acknowledges. PHP dispatches the trusted host
handler only after that acknowledgment and a live-runtime check. ARM restarts only
the remaining compute allowance before PHP releases the reply. The cumulative
guest budget and 256-host-call limit are unchanged; host latency and helper
startup cannot replenish the budget. The helper stays alive during a pause.
After initial ARM, control EOF, final CANCEL and internal errors terminate and
observe the retained original target, including while paused. Final CANCEL stops
the target before helper exit, so PHP death during final cleanup does not remove
the target's only owner-loss guard first.

## Cleanup and explicit limits

Normal cleanup confirms helper exit before releasing its resource and cleaning
the native runtime. If cancellation does not finish within two seconds, PHP first
terminates and observes the original runtime through its own handle. It may force
the exact helper only after runtime exit is confirmed. Unconfirmed live resources
are never passed to blocking `proc_close`; PHP releases them without that wait.
An unconfirmed cleanup returns an error and cannot produce a successful job result
or further host dispatch. Confirmed temporary files are removed; an unconfirmed
helper's files may remain for diagnosis.

PHP encodes the initial payload before acquiring any process or temporary file.
It serializes host replies while the watchdog is paused, then rearms before
releasing the encoded reply. A throwing `JsonSerializable` produces a fixed error
without exposing exception text. The acquired runtime's protocol loop uses a
`finally` boundary so ordinary protocol exceptions also reach cancellation and
observed cleanup; an unconfirmed cleanup still overrides any successful result.

These branches preserve target ownership; they do not call an unobserved exit a
successful join. An OS that refuses termination may leave an unconfirmed process.
Abrupt external termination of an already armed helper is also outside the
protocol's liveness guarantee. The runtime's own fuel/instruction and epoch
backstops remain in force. No external Job supervisor is required by this design.

The .NET Framework implementation caches the handle acquired by `SafeHandle` and
reuses it for `Kill` and `WaitForExit`; it does not reopen the PID while that handle
is held. PHP on Windows also terminates through the stored process handle and
waits indefinitely only for explicit `proc_close`, not resource garbage collection.
See [Microsoft reference source](https://raw.githubusercontent.com/microsoft/referencesource/main/System/services/monitoring/system/diagnosticts/Process.cs)
and [PHP process-resource source](https://raw.githubusercontent.com/php/php-src/php-8.4.15/ext/standard/proc_open.c).

The POSIX sleep/kill helper mechanism is unchanged. Both platforms now rearm
before PHP releases a host-call reply. The Windows helper is included beside
`SandboxRunner.php` in the production application; its protocol tests remain in
the repository test suite. The production package deliberately excludes tests.
