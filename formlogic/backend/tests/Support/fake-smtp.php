<?php

declare(strict_types=1);

// A mail server for a test: real SMTP on a port of its own, which it prints, with the delay at each
// step of a healthy one. It takes one conversation at a time and stops when it is killed.

$server = stream_socket_server('tcp://127.0.0.1:0');
if ($server === false) {
    exit(1);
}
echo substr((string) strrchr((string) stream_socket_get_name($server, false), ':'), 1), "\n";

$say = static function ($client, string $line): void {
    usleep(100_000);
    fwrite($client, $line . "\r\n");
};
while (true) {
    $client = @stream_socket_accept($server, 3600);
    if ($client === false) {
        continue;
    }
    $say($client, '220 test ready');
    $inData = false;
    while (($line = fgets($client)) !== false) {
        $line = rtrim($line, "\r\n");
        if ($inData) {
            if ($line === '.') {
                $inData = false;
                $say($client, '250 taken');
            }
            continue;
        }
        $verb = strtoupper(substr($line, 0, 4));
        if ($verb === 'QUIT') {
            fwrite($client, "221 bye\r\n");
            break;
        }
        if ($verb === 'DATA') {
            $inData = true;
            $say($client, '354 go');
        } else {
            $say($client, '250 ok');
        }
    }
    fclose($client);
}
