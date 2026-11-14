<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support;

use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\SiteDesktopAi;

/**
 * The desktop AI lane held in memory, for tests of what reads it (SiteDesktopAi, its controllers):
 * requests by id with their owner, status and frames, every read scoped to the owner as the real
 * lane's are, and a record of what was asked of it. The parent's database is never used.
 */
final class InMemoryAiRelay extends DesktopAiRelayService
{
    /** @var array<string, array{owner: string, requester: string, target: ?string, kind: string, ephPub: string, envelope: string, status: string, taken: bool, age: int, frames: list<array{seq: int, envelope: ?string}>}> */
    public array $requests = [];
    /** @var list<array{kind: string, owner: string, requester: string, laneCap: ?int}> */
    public array $enqueued = [];
    /** @var list<string> */
    public array $cancelled = [];
    /** @var list<string> */
    public array $abandoned = [];
    /** @var list<string> the owner each read was scoped to */
    public array $readAs = [];
    /** @var list<array{0: int, 1: ?int}> each read of frames: how many at most, and the largest it takes */
    public array $fetched = [];
    /** What inFlightForTarget answers. */
    public int $inFlight = 0;
    /** Thrown by the next read, as a database that fails would. */
    public ?\Throwable $failRead = null;
    private int $seq = 0;

    public function __construct()
    {
        parent::__construct(new LinkedComputers());
    }

    public function enqueue(string $ownerUserId, string $requestingUserId, array $data, ?string $source = null, ?int $laneCap = null): array
    {
        $kind = (string) $data['kind'];
        $this->enqueued[] = ['kind' => $kind, 'owner' => $ownerUserId, 'requester' => $requestingUserId, 'laneCap' => $laneCap];
        if ($laneCap !== null) {
            $picture = $kind === self::PICTURE_KIND;
            $open = array_filter($this->requests, static fn (array $r): bool => $r['owner'] === $ownerUserId && $r['target'] === ($data['targetInstanceId'] ?? null)
                && in_array($r['status'], ['pending', 'claimed', 'streaming'], true) && ($r['kind'] === self::PICTURE_KIND) === $picture);
            if (count($open) >= $laneCap) {
                throw new \RuntimeException('queue_full_lane');
            }
        }
        $id = vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex(random_bytes(16)), 4));
        $this->requests[$id] = [
            'owner' => $ownerUserId, 'requester' => $requestingUserId, 'target' => $data['targetInstanceId'] ?? null, 'kind' => $kind,
            'ephPub' => (string) $data['ephPub'], 'envelope' => (string) $data['envelope'], 'status' => 'pending', 'taken' => false, 'age' => 0, 'frames' => [],
        ];
        return ['request' => ['requestId' => $id, 'status' => 'pending'], 'created' => true];
    }

    public function getStatus(string $id, string $ownerUserId): ?string
    {
        return $this->mine($id, $ownerUserId)['status'] ?? null;
    }

    public function progress(string $id, string $ownerUserId): ?array
    {
        $row = $this->mine($id, $ownerUserId);
        return $row === null ? null : ['status' => $row['status'], 'taken' => $row['taken'], 'age' => $row['age'], 'kind' => $row['kind'], 'ephPub' => $row['ephPub']];
    }

    public function fetchOutput(string $id, string $ownerUserId, int $since, int $limit = 200, ?int $maxFrameBytes = null): array
    {
        $this->fetched[] = [$limit, $maxFrameBytes];
        $row = $this->mine($id, $ownerUserId);
        if ($row === null) {
            return [];
        }
        $after = array_values(array_filter($row['frames'], static fn (array $f): bool => $f['seq'] > $since));
        return array_slice($after, 0, $limit);
    }

    public function getForAccess(string $id, string $userId): ?array
    {
        $row = $this->requests[$id] ?? null;
        if ($row === null || ($row['owner'] !== $userId && $row['requester'] !== $userId)) {
            return null;
        }
        return ['requestId' => $id, 'ownerUserId' => $row['owner'], 'requestingUserId' => $row['requester'], 'status' => $row['status']];
    }

    public function cancel(string $id, string $ownerUserId): bool
    {
        return $this->cancelSaying($id, $ownerUserId) !== null;
    }

    public function cancelSaying(string $id, string $ownerUserId): ?string
    {
        $this->cancelled[] = $id;
        $row = $this->mine($id, $ownerUserId);
        if ($row === null || !in_array($row['status'], ['pending', 'claimed', 'streaming'], true)) {
            return null;
        }
        $this->requests[$id]['status'] = 'expired';
        $this->requests[$id]['frames'] = [];
        return $row['status'];
    }

    public function abandon(string $id, string $ownerUserId): bool
    {
        $this->abandoned[] = $id;
        return false;
    }

    public function inFlightForTarget(string $ownerUserId, string $targetInstanceId, ?bool $picture = null): int
    {
        return $this->inFlight;
    }

    /** The newest request queued, as the computer it is for would claim it: its id. */
    public function newest(): string
    {
        $ids = array_keys($this->requests);
        return (string) end($ids);
    }

    /** A computer takes request $id. */
    public function take(string $id): void
    {
        $this->requests[$id]['status'] = 'claimed';
        $this->requests[$id]['taken'] = true;
    }

    /** What the computer holding $desktopSecret reads of request $id as it takes it: [its turn, the box pair it answers with]. */
    public function claimAs(string $id, string $desktopSecret): array
    {
        $this->take($id);
        $pair = sodium_crypto_box_keypair_from_secretkey_and_publickey($desktopSecret, (string) base64_decode($this->requests[$id]['ephPub'], true));
        return [SiteDesktopAi::open($this->requests[$id]['envelope'], 0, 0, $pair), $pair];
    }

    /** The computer sends one frame, sealed under counter $counter. */
    public function answer(string $id, array $frame, int $counter, string $pair): void
    {
        $this->requests[$id]['status'] = $this->requests[$id]['status'] === 'claimed' ? 'streaming' : $this->requests[$id]['status'];
        $this->requests[$id]['frames'][] = ['seq' => ++$this->seq, 'envelope' => SiteDesktopAi::seal($frame, 1, $counter, $pair)];
    }

    /** A frame the lane kept but a capped reader is not given (larger than it takes): its envelope reads as null. */
    public function oversized(string $id): void
    {
        $this->requests[$id]['frames'][] = ['seq' => ++$this->seq, 'envelope' => null];
    }

    public function finish(string $id, string $status = 'done'): void
    {
        $this->requests[$id]['status'] = $status;
    }

    public function age(string $id, int $seconds): void
    {
        $this->requests[$id]['age'] = $seconds;
    }

    private function mine(string $id, string $ownerUserId): ?array
    {
        $this->readAs[] = $ownerUserId;
        if ($this->failRead !== null) {
            $failure = $this->failRead;
            $this->failRead = null;
            throw $failure;
        }
        $row = $this->requests[$id] ?? null;
        return $row !== null && $row['owner'] === $ownerUserId ? $row : null;
    }
}
