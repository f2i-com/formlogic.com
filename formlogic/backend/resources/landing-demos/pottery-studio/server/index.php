<?php
declare(strict_types=1);

$startedAt = microtime(true);

function jsonOut(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function readBody(): array
{
    $raw = file_get_contents('php://input');
    if (!is_string($raw) || trim($raw) === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function openDb(): PDO
{
    $pdo = new PDO('sqlite:app.db');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA foreign_keys = ON');

    $exists = (int) $pdo->query("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'classes'")->fetchColumn();
    if ($exists === 0) {
        $schemaPath = __DIR__ . '/schema.sql';
        if (is_file($schemaPath)) {
            $pdo->exec((string) file_get_contents($schemaPath));
        }
    }
    return $pdo;
}

function buildState(PDO $pdo, float $startedAt): array
{
    $classes = $pdo->query(
        'SELECT id, title, instructor, schedule, level, price_usd, capacity, spots_booked, clay_type,
                MAX(0, capacity - spots_booked) AS spots_left
         FROM classes
         ORDER BY id ASC'
    )->fetchAll();

    $bookings = $pdo->query(
        'SELECT b.id, b.class_id, b.guest_name, b.guest_email, b.seats, b.note, b.status, b.created_at,
                c.title AS class_title, c.schedule AS class_schedule, c.price_usd AS unit_price
         FROM bookings b
         JOIN classes c ON c.id = b.class_id
         ORDER BY b.id DESC
         LIMIT 50'
    )->fetchAll();

    $openSpots = 0;
    foreach ($classes as &$c) {
        $c['id'] = (int) $c['id'];
        $c['price_usd'] = (int) $c['price_usd'];
        $c['capacity'] = (int) $c['capacity'];
        $c['spots_booked'] = (int) $c['spots_booked'];
        $c['spots_left'] = max(0, $c['capacity'] - $c['spots_booked']);
        $openSpots += $c['spots_left'];
    }
    unset($c);

    foreach ($bookings as &$b) {
        $b['id'] = (int) $b['id'];
        $b['class_id'] = (int) $b['class_id'];
        $b['seats'] = (int) $b['seats'];
        $b['unit_price'] = (int) $b['unit_price'];
    }
    unset($b);

    return [
        'classes' => $classes,
        'bookings' => $bookings,
        'meta' => [
            'engine' => 'SQLite',
            'tables' => 2,
            'totalClasses' => count($classes),
            'totalBookings' => count($bookings),
            'openSpots' => $openSpots,
            'queryMs' => max(1, (int) round((microtime(true) - $startedAt) * 1000)),
        ],
    ];
}

try {
    $pdo = openDb();
    $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/api/classes');
    $path = parse_url($uri, PHP_URL_PATH);
    $path = is_string($path) ? rtrim($path, '/') : '/api/classes';
    if ($path === '') {
        $path = '/api/classes';
    }

    if ($method === 'GET' && ($path === '/api/classes' || $path === '/api/state' || $path === '/api/bookings')) {
        jsonOut(buildState($pdo, $startedAt));
    }

    if ($method === 'POST' && $path === '/api/bookings') {
        $body = readBody();
        $classId = (int) ($body['class_id'] ?? 0);
        $guestName = trim((string) ($body['guest_name'] ?? ''));
        $guestEmail = trim((string) ($body['guest_email'] ?? ''));
        $seats = (int) ($body['seats'] ?? 1);
        $note = trim((string) ($body['note'] ?? ''));

        if ($classId <= 0) {
            jsonOut(['error' => 'Please select a pottery class.'], 400);
        }
        if (mb_strlen($guestName) < 2 || mb_strlen($guestName) > 80) {
            jsonOut(['error' => 'Please enter your name (2-80 characters).'], 400);
        }
        if ($guestEmail === '' || !filter_var($guestEmail, FILTER_VALIDATE_EMAIL)) {
            jsonOut(['error' => 'Please enter a valid email address.'], 400);
        }
        if ($seats < 1 || $seats > 3) {
            jsonOut(['error' => 'You can book 1 to 3 spots at a time.'], 400);
        }
        $note = mb_substr($note, 0, 140);

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('SELECT id, title, capacity, spots_booked FROM classes WHERE id = ?');
            $stmt->execute([$classId]);
            $cls = $stmt->fetch();
            if (!$cls) {
                $pdo->rollBack();
                jsonOut(['error' => 'Class not found.'], 404);
            }
            $left = max(0, (int) $cls['capacity'] - (int) $cls['spots_booked']);
            if ($seats > $left) {
                $pdo->rollBack();
                jsonOut(['error' => $left === 0 ? 'That class is currently full.' : "Only {$left} spot(s) left in this class."], 409);
            }

            $ins = $pdo->prepare(
                'INSERT INTO bookings (class_id, guest_name, guest_email, seats, note, status) VALUES (?, ?, ?, ?, ?, ?)'
            );
            $ins->execute([$classId, $guestName, $guestEmail, $seats, $note, 'confirmed']);
            $bookingId = (int) $pdo->lastInsertId();

            $upd = $pdo->prepare('UPDATE classes SET spots_booked = spots_booked + ? WHERE id = ?');
            $upd->execute([$seats, $classId]);
            $pdo->commit();

            $state = buildState($pdo, $startedAt);
            $state['createdBookingId'] = $bookingId;
            $state['message'] = "Booked {$seats} spot" . ($seats === 1 ? '' : 's') . " in {$cls['title']}!";
            jsonOut($state, 201);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    if ($method === 'DELETE' && ($path === '/api/bookings' || preg_match('#^/api/bookings/(\d+)$#', $path, $m))) {
        $body = readBody();
        $bookingId = isset($m[1]) ? (int) $m[1] : (int) ($_GET['id'] ?? $body['id'] ?? 0);
        if ($bookingId <= 0) {
            jsonOut(['error' => 'Missing booking ID.'], 400);
        }
        $pdo->beginTransaction();
        try {
            $sel = $pdo->prepare('SELECT id, class_id, seats FROM bookings WHERE id = ?');
            $sel->execute([$bookingId]);
            $booking = $sel->fetch();
            if (!$booking) {
                $pdo->rollBack();
                jsonOut(['error' => 'Booking not found.'], 404);
            }
            $pdo->prepare('DELETE FROM bookings WHERE id = ?')->execute([$bookingId]);
            $pdo->prepare('UPDATE classes SET spots_booked = MAX(0, spots_booked - ?) WHERE id = ?')
                ->execute([(int) $booking['seats'], (int) $booking['class_id']]);
            $pdo->commit();

            $state = buildState($pdo, $startedAt);
            $state['message'] = 'Booking cancelled and spots restored.';
            jsonOut($state);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    if ($method === 'POST' && $path === '/api/classes') {
        $body = readBody();
        $title = trim((string) ($body['title'] ?? ''));
        $instructor = trim((string) ($body['instructor'] ?? 'Studio Host'));
        $schedule = trim((string) ($body['schedule'] ?? 'Thu, 6:30 PM'));
        $level = trim((string) ($body['level'] ?? 'All levels'));
        $price = max(15, min(350, (int) ($body['price_usd'] ?? 65)));
        $capacity = max(2, min(20, (int) ($body['capacity'] ?? 8)));
        $clay = trim((string) ($body['clay_type'] ?? 'Speckled stoneware'));

        if (mb_strlen($title) < 3 || mb_strlen($title) > 70) {
            jsonOut(['error' => 'Class title must be 3-70 characters.'], 400);
        }
        $ins = $pdo->prepare(
            'INSERT INTO classes (title, instructor, schedule, level, price_usd, capacity, spots_booked, clay_type)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
        );
        $ins->execute([$title, mb_substr($instructor, 0, 50), mb_substr($schedule, 0, 40), mb_substr($level, 0, 30), $price, $capacity, mb_substr($clay, 0, 40)]);
        $state = buildState($pdo, $startedAt);
        $state['message'] = "Added \"{$title}\" to the live timetable!";
        jsonOut($state, 201);
    }

    jsonOut(['error' => 'Route not found', 'path' => $path, 'method' => $method], 404);
} catch (Throwable $e) {
    jsonOut(['error' => $e->getMessage()], 500);
}
