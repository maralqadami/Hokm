<?php
declare(strict_types=1);

final class Payments
{
    public const THEMES = [
        'classic' => ['name' => 'کلاسیک', 'icon' => '♠️', 'stars' => 0, 'description' => 'تم پایهٔ میز و پروفایل'],
        'emerald' => ['name' => 'مخمل سبز', 'icon' => '🟢', 'stars' => 35, 'description' => 'رنگ سبز دکمه‌های میز و نشان مخمل سبز در پروفایلت'],
        'royal' => ['name' => 'شاهانه', 'icon' => '👑', 'stars' => 50, 'description' => 'نشان تاج در پروفایل و سربرگ تاج‌دار در میز و منوی بازی'],
    ];
    public const STATUS = [
        'pending' => 'در انتظار پرداخت', 'authorized' => 'در انتظار تأیید نهایی تلگرام',
        'expired' => 'منقضی', 'checkout_expired' => 'پایان مهلت تأیید', 'issue_failed' => 'خطا در صدور فاکتور',
        'paid' => 'پرداخت‌شده', 'refunded' => 'بازگشت وجه', 'mismatch' => 'مغایرت، نیازمند بررسی',
        'duplicate' => 'پرداخت اضافه، نیازمند بررسی', 'refunding' => 'در حال بازگشت وجه',
        'refund_review' => 'بازگشت وجه نیازمند بررسی',
    ];
    private const VALID_SECONDS = 1500;

    private readonly Notices $notices;

    public function __construct(private readonly Db $db, private readonly int $now)
    {
        $this->notices = new Notices($db, $now);
    }

    public function expire(): void
    {
        $this->db->run("UPDATE invoices SET status='expired',updated_at=? WHERE status='pending' AND created_at<=?", $this->now, $this->now - self::VALID_SECONDS);
        $this->db->run("UPDATE invoices SET status='checkout_expired',updated_at=? WHERE status='authorized' AND updated_at<=?", $this->now, $this->now - 3600);
    }

    public function owned(int $user, string $sku): bool
    {
        return $sku === 'classic' || (bool) $this->db->value("SELECT 1 FROM invoices WHERE user_id=? AND sku=? AND status='paid' LIMIT 1", $user, $sku);
    }

    public function theme(int $user, string $sku): void
    {
        if (!isset(self::THEMES[$sku]) || !$this->owned($user, $sku)) {
            throw new PlayError('این تم هنوز برای پروفایلت فعال نشده.');
        }
        $this->db->run('UPDATE users SET theme=? WHERE id=?', $sku, $user);
    }

    public function order(int $user, string $sku): string
    {
        $item = self::THEMES[$sku] ?? null;
        if (!$item || !$item['stars'] || !$this->db->flag('store_open')) {
            throw new PlayError('فروش این تم در حال حاضر فعال نیست.');
        }
        if ($this->owned($user, $sku)) {
            throw new PlayError('این تم قبلاً برایت فعال شده.');
        }
        $this->expire();
        $order = $this->db->one("SELECT * FROM invoices WHERE user_id=? AND sku=? AND status IN ('pending','authorized') LIMIT 1", $user, $sku);
        if ($order) {
            if ($order['status'] === 'authorized') {
                throw new PlayError('تلگرام هنوز پرداخت این فاکتور را تأیید نکرده. رسیدها را در کیف پول ببین.');
            }
            $this->notices->add('invoice', $user, ['id' => $order['id']], 'invoice:' . $order['id']);
            return $order['id'];
        }
        $id = bin2hex(random_bytes(16));
        $this->db->run("INSERT INTO invoices(id,user_id,sku,stars,status,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)", $id, $user, $sku, $item['stars'], $this->now, $this->now);
        $this->notices->add('invoice', $user, ['id' => $id], 'invoice:' . $id);
        return $id;
    }

    public function checkout(int $user, array $query): array
    {
        $this->expire();
        $id = (string) ($query['id'] ?? '');
        $invoice = $this->db->one('SELECT * FROM invoices WHERE id=?', (string) ($query['invoice_payload'] ?? ''));
        $answer = ['pre_checkout_query_id' => $id, 'ok' => false, 'error_message' => 'فاکتور معتبر نیست یا منقضی شده. فروشگاه را دوباره باز کن.'];
        if (!$invoice || $invoice['user_id'] !== $user || ($query['currency'] ?? '') !== 'XTR' || ($query['total_amount'] ?? null) !== $invoice['stars']) {
            return $answer;
        }
        if ($invoice['status'] === 'authorized' && $invoice['checkout_id'] === $id) {
            return ['pre_checkout_query_id' => $id, 'ok' => true];
        }
        if ($invoice['status'] !== 'pending' || !$this->db->flag('store_open') || $this->owned($user, $invoice['sku'])) {
            return $answer;
        }
        $this->db->run("UPDATE invoices SET status='authorized',checkout_id=?,updated_at=? WHERE id=?", $id, $this->now, $invoice['id']);
        return ['pre_checkout_query_id' => $id, 'ok' => true];
    }

    public function paid(int $user, array $payment): void
    {
        $charge = (string) ($payment['telegram_payment_charge_id'] ?? '');
        if ($charge === '' || $this->db->value('SELECT 1 FROM charges WHERE id=?', $charge)) {
            return;
        }
        $payload = (string) ($payment['invoice_payload'] ?? '');
        $amount = (int) ($payment['total_amount'] ?? 0);
        $currency = (string) ($payment['currency'] ?? '');
        $invoice = $this->db->one('SELECT * FROM invoices WHERE id=?', $payload);
        $valid = $invoice && $invoice['user_id'] === $user && $currency === 'XTR' && $amount === $invoice['stars'];
        $status = 'mismatch';
        if ($valid) {
            if ($this->owned($user, $invoice['sku']) || $invoice['primary_charge'] !== null) {
                $status = 'duplicate';
            } elseif (in_array($invoice['status'], ['authorized', 'checkout_expired'], true)) {
                $status = 'paid';
            }
        }
        $this->db->run('INSERT INTO charges(id,invoice_id,user_id,payload,currency,total,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
            $charge, $invoice['id'] ?? null, $user, $payload, $currency, $amount, $status, $this->now, $this->now
        );
        if ($status !== 'paid') {
            $this->notices->text($user, '🧾 پرداخت ثبت شد و در حال بررسی است. برای پیگیری /paysupport را بزن.');
            return;
        }
        $this->db->run("UPDATE invoices SET status='paid',primary_charge=?,updated_at=? WHERE id=?", $charge, $this->now, $invoice['id']);
        $this->theme($user, $invoice['sku']);
        $name = self::THEMES[$invoice['sku']]['name'];
        $this->notices->text($user, '✅ تم <b>' . escaped($name) . '</b> فعال شد. رسید را در /wallet ببین.');
    }

    public function refunded(int $user, array $payment): void
    {
        $id = (string) ($payment['telegram_payment_charge_id'] ?? '');
        $currency = (string) ($payment['currency'] ?? '');
        if ($id === '' || $currency !== 'XTR') {
            return;
        }
        $charge = $this->db->one('SELECT * FROM charges WHERE id=?', $id);
        if ($charge && ($charge['user_id'] !== $user || $charge['total'] !== (int) ($payment['total_amount'] ?? 0))) {
            return;
        }
        if (!$charge) {
            $payload = (string) ($payment['invoice_payload'] ?? '');
            $invoice = $this->db->one('SELECT * FROM invoices WHERE id=? AND user_id=?', $payload, $user);
            $this->db->run("INSERT INTO charges(id,invoice_id,user_id,payload,currency,total,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'refunded',?,?)",
                $id, $invoice['id'] ?? null, $user, $payload, $currency, (int) ($payment['total_amount'] ?? 0), $this->now, $this->now
            );
            if ($invoice && !$invoice['primary_charge'] && $invoice['stars'] === (int) ($payment['total_amount'] ?? 0)) {
                $this->db->run("UPDATE invoices SET status='refunded',primary_charge=?,updated_at=? WHERE id=?", $id, $this->now, $invoice['id']);
            }
            return;
        }
        $this->confirmRefund($charge);
    }

    private function confirmRefund(array $charge): void
    {
        if ($charge['status'] === 'refunded') {
            return;
        }
        $this->db->run("UPDATE charges SET status='refunded',updated_at=? WHERE id=?", $this->now, $charge['id']);
        $invoice = $this->db->one('SELECT * FROM invoices WHERE primary_charge=?', $charge['id']);
        if ($invoice) {
            $this->db->run("UPDATE invoices SET status='refunded',updated_at=? WHERE id=?", $this->now, $invoice['id']);
            if (!$this->owned($charge['user_id'], $invoice['sku'])) {
                $this->db->run("UPDATE users SET theme='classic' WHERE id=? AND theme=?", $charge['user_id'], $invoice['sku']);
            }
        }
        $this->notices->text($charge['user_id'], '↩️ بازگشت ' . fa($charge['total']) . ' استارز ثبت شد. جزئیات در /wallet.');
    }

    public function issue(Telegram $api, string $id): void
    {
        $order = $this->db->one("SELECT * FROM invoices WHERE id=? AND status='pending' AND created_at>?", $id, $this->now - self::VALID_SECONDS);
        if (!$order) {
            return;
        }
        $item = self::THEMES[$order['sku']];
        $api->call('sendInvoice', [
            'chat_id' => $order['user_id'],
            'title' => 'تم ' . $item['name'],
            'description' => $item['description'] . '. انتخاب تم روی بازی و رتبه اثری ندارد.',
            'payload' => $id,
            'provider_token' => '',
            'currency' => 'XTR',
            'prices' => [['label' => $item['name'], 'amount' => $order['stars']]],
            'start_parameter' => 'hokm-store',
        ]);
    }

    public function refund(Telegram $api, string $id): void
    {
        $charge = $this->db->write(function () use ($id): array {
            $row = $this->db->one('SELECT * FROM charges WHERE id=?', $id);
            if (!$row || $row['currency'] !== 'XTR' || !in_array($row['status'], ['paid','mismatch','duplicate','refund_review'], true)) {
                throw new PlayError('این تراکنش آمادهٔ بازگشت وجه نیست.');
            }
            $previous = $row['status'] === 'refund_review' ? $row['before_refund'] : $row['status'];
            $this->db->run("UPDATE charges SET status='refunding',before_refund=?,updated_at=? WHERE id=?", $previous, $this->now, $id);
            $row['before_refund'] = $previous;
            return $row;
        });
        try {
            $api->call('refundStarPayment', ['user_id' => $charge['user_id'], 'telegram_payment_charge_id' => $id], 7000);
        } catch (TelegramFailure $failure) {
            if (str_contains(strtoupper($failure->getMessage()), 'ALREADY_REFUNDED')) {
                $this->db->write(fn() => $this->confirmRefund($this->db->one('SELECT * FROM charges WHERE id=?', $id)));
                return;
            }
            $status = $failure->uncertain() ? 'refund_review' : $charge['before_refund'];
            $this->db->run("UPDATE charges SET status=?,updated_at=? WHERE id=? AND status='refunding'", $status, $this->now, $id);
            throw $failure;
        }
        $this->db->write(fn() => $this->confirmRefund($this->db->one('SELECT * FROM charges WHERE id=?', $id)));
    }
}

final class Gifts
{
    public const STATUS = [
        'pending' => 'در انتظار ارسال', 'sending' => 'در حال ارسال',
        'sent' => 'ارسال‌شده', 'failed' => 'خطا در ارسال', 'review' => 'نیازمند بررسی ارسال',
    ];

    public static function send(Db $db, Telegram $api, int $id, int $now): void
    {
        $reward = $db->one('SELECT * FROM rewards WHERE id=?', $id);
        if (!$db->flag('rewards_open') || !$reward || !in_array($reward['status'], ['pending','failed'], true)) {
            throw new PlayError('این گیفت آمادهٔ ارسال نیست.');
        }
        $catalog = $api->call('getAvailableGifts')['gifts'] ?? [];
        $gift = null;
        foreach ($catalog as $item) {
            if (($item['star_count'] ?? null) === $reward['cost'] && empty($item['total_count'])
                && empty($item['is_premium']) && empty($item['is_premium_required'])) {
                $gift = $item['id'];
                break;
            }
        }
        if ($gift === null) {
            throw new PlayError('الان در کاتالوگ، گیفت عادیِ ' . fa($reward['cost']) . ' استارزی موجود نیست.');
        }
        if (!$db->run("UPDATE rewards SET status='sending',gift_id=?,updated_at=? WHERE id=? AND status IN ('pending','failed')", $gift, $now, $id)) {
            throw new PlayError('ارسال این جایزه قبلاً شروع شده.');
        }
        try {
            $api->call('sendGift', [
                'user_id' => $reward['user_id'], 'gift_id' => $gift,
                'text' => 'رتبهٔ ' . fa($reward['rank']) . ' جدول ' . Period::TYPES[$reward['period']] . ' میز حکم مبارک! ♠️',
            ], 8000);
        } catch (TelegramFailure $failure) {
            $status = $failure->uncertain() ? 'review' : 'failed';
            $db->run("UPDATE rewards SET status=?,updated_at=? WHERE id=? AND status='sending'", $status, $now, $id);
            throw $failure;
        }
        $db->run("UPDATE rewards SET status='sent',updated_at=? WHERE id=? AND status='sending'", $now, $id);
    }
}
