<?php
declare(strict_types=1);

require_once __DIR__ . '/app/boot.php';
header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit('Method not allowed');
}
try {
    $settings = config();
    $secret = (string) ($_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '');
    if (!$settings || $secret === '' || !hash_equals($settings['secret'], $secret)) {
        http_response_code(403);
        exit('Forbidden');
    }
    $json = file_get_contents('php://input', false, null, 0, 262145);
    if (!is_string($json) || strlen($json) > 262144) {
        http_response_code(413);
        exit('Payload too large');
    }
    try {
        $update = json_decode($json, true, 32, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        http_response_code(400);
        exit('Bad JSON');
    }
    if (!is_array($update)) {
        http_response_code(400);
        exit('Bad update');
    }
    $bot = new Bot(new Db(configPath()), new Telegram($settings['token']), $settings);
    $bot->receive($update);
    if (!$bot->drain()) {
        http_response_code(503);
        exit('Delivery queued');
    }
    echo 'OK';
} catch (Throwable $error) {
    error_log('Miz Hokm webhook: ' . get_class($error) . ' (' . $error->getCode() . ')');
    http_response_code(503);
    echo 'Temporarily unavailable';
}
