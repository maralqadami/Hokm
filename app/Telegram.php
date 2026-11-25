<?php
declare(strict_types=1);

final class TelegramFailure extends RuntimeException
{
    public function __construct(public readonly int $apiCode, string $description, public readonly int $retry = 0)
    {
        parent::__construct($description, $apiCode);
    }

    public function uncertain(): bool
    {
        return $this->apiCode === 0 || $this->apiCode >= 500;
    }
}

final class Telegram
{
    public const COMMANDS = [
        'start' => 'خانه و منوی اصلی',
        'play' => 'میز رقابتی، خصوصی یا تمرینی',
        'table' => 'بازگشت به میز بازی',
        'profile' => 'پروفایل و آمار بازی',
        'friends' => 'پیدا کردن دوست و دعوت به میز',
        'rank' => 'رتبه‌بندی روزانه، هفتگی و ماهانه',
        'wallet' => 'خریدها و رسیدهای استارز',
        'help' => 'قوانین بازی و راهنما',
        'feedback' => 'ارسال بازخورد',
        'paysupport' => 'پیگیری خرید و بازگشت وجه',
        'cancel' => 'لغو و خروج',
        'privacy' => 'حریم خصوصی و داده‌ها',
    ];

    public function __construct(private readonly string $token, private readonly ?Closure $transport = null) {}

    public static function validToken(string $token): bool
    {
        return (bool) preg_match('/\A[0-9]{5,16}:[A-Za-z0-9_-]{30,70}\z/', $token);
    }

    public function call(string $method, array $payload = [], int $timeoutMs = 4100): mixed
    {
        if ($this->transport) {
            return ($this->transport)($method, $payload);
        }
        $handle = curl_init('https://api.telegram.org/bot' . $this->token . '/' . $method);
        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => encoded((object) $payload),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT_MS => min($timeoutMs, 2500),
            CURLOPT_TIMEOUT_MS => $timeoutMs,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        $raw = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);
        if (!is_string($raw)) {
            throw new TelegramFailure(0, 'ارتباط با Telegram Bot API برقرار نشد یا زمان پاسخ تمام شد.');
        }
        $response = json_decode($raw, true);
        if (!is_array($response) || !isset($response['ok'])) {
            throw new TelegramFailure($status >= 500 ? $status : 0, 'پاسخ Telegram Bot API قابل‌خواندن نبود.');
        }
        if (!$response['ok']) {
            $description = str_replace($this->token, '[token]', (string) ($response['description'] ?? 'Telegram API error'));
            throw new TelegramFailure((int) ($response['error_code'] ?? $status), shortText($description, 240), (int) ($response['parameters']['retry_after'] ?? 0));
        }
        return $response['result'] ?? null;
    }

    public function shortcuts(): void
    {
        $commands = [];
        foreach (self::COMMANDS as $command => $description) {
            $commands[] = ['command' => $command, 'description' => $description];
        }
        $this->call('setMyCommands', ['commands' => $commands, 'scope' => ['type' => 'all_private_chats']]);
        $this->call('setChatMenuButton', ['menu_button' => ['type' => 'commands']]);
    }

    public function webhook(array $config): void
    {
        $this->call('setWebhook', [
            'url' => $config['base'] . '/webhook.php',
            'secret_token' => $config['secret'],
            'allowed_updates' => ['message', 'callback_query', 'pre_checkout_query'],
            'max_connections' => 10,
        ], 7500);
    }
}
