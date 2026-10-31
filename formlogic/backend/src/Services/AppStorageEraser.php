<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * What an app keeps on disk, which outlives its MySQL rows: a native app's source, database
 * and host keys, and a hosted app's database. A deleted app's stays while it sits in the
 * recycle bin: it is the app as it was, and a restore keeps it over the bin's snapshot. It goes
 * when the app is gone for good: "Delete forever", the end of the bin's retention, and account
 * erasure.
 */
class AppStorageEraser
{
    public function __construct(private ?NativeAppService $native = null, private ?string $hostedPath = null)
    {
        $this->native ??= new NativeAppService();
    }

    /** Idempotent. Throws when something is left behind, so the caller keeps its record of it. */
    public function erase(string $appId): void
    {
        // An id neither service would have stored under has nothing on disk.
        if (!preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $appId)) {
            return;
        }
        $this->native->remove($appId);
        HostedAppService::eraseStorage($appId, $this->hostedPath);
    }
}
