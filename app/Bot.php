<?php
declare(strict_types=1);

final class Bot
{
    private readonly Tables $tables;
    private readonly Payments $payments;
    private readonly Screens $screens;
    private readonly Notices $notices;
    private readonly int $now;

    public function __construct(private readonly Db $db, private readonly Telegram $api, array $config, ?int $clock = null)
    {
        $this->now = $clock ?? time();
        $this->notices = new Notices($db, $this->now);
        $this->tables = new Tables($db, $this->now);
        $this->payments = new Payments($db, $this->now);
        $this->screens = new Screens($db, $this->tables, $this->payments, $config, $this->now);
    }

    public function receive(array $update): void
    {
        if (!isset($update['update_id']) || !is_int($update['update_id'])) {
            return;
        }
        $id = $update['update_id'];
        $response = $this->db->write(function () use ($id, $update): ?array {
            $old = $this->db->one('SELECT answer FROM updates WHERE id=?', $id);
            if ($old) {
                return $old['answer'] ? json_decode($old['answer'], true, 16, JSON_THROW_ON_ERROR) : null;
            }
            $answer = $this->route($update);
            $this->db->run('INSERT INTO updates VALUES(?,?,?)', $id, $this->now, $answer ? encoded($answer) : null);
            if ($id % 211 === 0) {
                $this->db->run('DELETE FROM updates WHERE created_at<?', $this->now - 7 * 86400);
                $this->db->run('DELETE FROM outbox WHERE dead_at<?', $this->now - 14 * 86400);
            }
            return $answer;
        });
        if ($response) {
            [$method, $data] = $response;
            try {
                $this->api->call($method, $data, $method === 'answerPreCheckoutQuery' ? 5000 : 1600);
            } catch (TelegramFailure $error) {
                if ($method === 'answerPreCheckoutQuery' && ($error->uncertain() || $error->apiCode === 429)) {
                    throw $error;
                }
            }
        }
    }

    private function user(array $from): ?array
    {
        $id = $from['id'] ?? null;
        if (!is_int($id) || $id <= 0 || !empty($from['is_bot'])) {
            return null;
        }
        $name = shortText(($from['first_name'] ?? '') . ' ' . ($from['last_name'] ?? ''), 44) ?: 'بازیکن';
        $username = shortText((string) ($from['username'] ?? ''), 32) ?: null;
        $this->db->run(
            'INSERT INTO users(id,name,telegram_username,active_at,created_at) VALUES(?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,telegram_username=excluded.telegram_username,active_at=excluded.active_at',
            $id, $name, $username, $this->now, $this->now
        );
        return $this->db->one('SELECT * FROM users WHERE id=?', $id);
    }

    private function route(array $update): ?array
    {
        if (isset($update['pre_checkout_query'])) {
            $query = $update['pre_checkout_query'];
            $user = $this->user($query['from'] ?? []);
            if ($user) {
                return ['answerPreCheckoutQuery', $this->payments->checkout($user['id'], $query)];
            }
            return null;
        }

        $callback = $update['callback_query'] ?? null;
        $message = $update['message'] ?? ($callback['message'] ?? []);
        if (($message['chat']['type'] ?? '') !== 'private') {
            return null;
        }
        if (!$callback && isset($message['refunded_payment'])) {
            $id = $message['chat']['id'] ?? null;
            if (is_int($id) && $this->db->value('SELECT 1 FROM users WHERE id=?', $id)) {
                $this->payments->refunded($id, $message['refunded_payment']);
            }
            return null;
        }
        if (!$callback && isset($message['successful_payment'])) {
            $id = $message['chat']['id'] ?? null;
            if (is_int($id)) {
                if (!$this->db->value('SELECT 1 FROM users WHERE id=?', $id) && ($message['from']['id'] ?? null) === $id) {
                    $this->user($message['from']);
                }
                if ($this->db->value('SELECT 1 FROM users WHERE id=?', $id)) {
                    $this->payments->paid($id, $message['successful_payment']);
                }
            }
            return null;
        }
        $user = $this->user($callback['from'] ?? $message['from'] ?? []);
        if (!$user || $message['chat']['id'] !== $user['id']) {
            return null;
        }
        $this->tables->sweep();
        if ($callback) {
            $answer = ['callback_query_id' => $callback['id']];
            try {
                $this->action($user, (string) ($callback['data'] ?? ''));
            } catch (PlayError $error) {
                $answer['text'] = $error->getMessage();
                $answer['show_alert'] = true;
            }
            return ['answerCallbackQuery', $answer];
        }
        try {
            $this->message($user, trim((string) ($message['text'] ?? '')));
        } catch (PlayError $error) {
            $this->notices->text($user['id'], escaped($error->getMessage()), [[Screens::home()]]);
        }
        return null;
    }

    private function show(int $user, array $view): void
    {
        [$text, $buttons] = $view;
        $this->notices->text($user, $text, $buttons);
    }

    private function prompt(int $user, string $key, string $text): void
    {
        $this->db->run('UPDATE users SET prompt=? WHERE id=?', $key, $user);
        $this->notices->text($user, $text, [[Screens::button('لغو', 'cancel', 'danger')]]);
    }

    private function message(array $user, string $text): void
    {
        if (preg_match('/\A\/([a-z_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+(.*))?\z/us', $text, $match)) {
            $args = trim($match[2] ?? '');
            if ($match[1] === 'start' && preg_match('/\Aj_([a-f0-9]{12})\z/', $args, $room)) {
                $this->tables->joinRoom($user['id'], $room[1]);
                return;
            }
            if ($match[1] === 'invite' && $args !== '') {
                $this->search($user, $args);
                return;
            }
            $action = match ($match[1]) {
                'start', 'menu' => $args === 'hokm-store' ? 'store' : 'home',
                'rank' => 'board:day:0', 'rules' => 'help',
                'invite' => 'search',
                'play', 'table', 'profile', 'friends', 'wallet', 'help', 'feedback', 'paysupport', 'cancel', 'privacy', 'practice', 'leave' => $match[1],
                default => 'help',
            };
            $this->action($user, $action);
            return;
        }

        if (!$text) {
            $this->notices->text($user['id'], 'برای ادامه یکی از دکمه‌ها را بزن یا /start را بفرست.');
            return;
        }

        $id = $user['id'];
        switch ($user['prompt']) {
            case 'search':
                $this->search($user, $text);
                break;
            case 'edit:nickname':
            case 'edit:alias':
            case 'edit:bio':
                $field = substr($user['prompt'], 5);
                $max = ['nickname' => 32, 'alias' => 24, 'bio' => 110][$field];
                $value = $text === 'پاک' ? '' : shortText($text, $max + 1);
                if ($field === 'alias' && $value !== '') {
                    $value = strtolower(ltrim(latin($value), '@'));
                    if (!preg_match('/\A[a-z][a-z0-9_]{2,23}\z/', $value)) {
                        throw new PlayError('نام کاربری باید ۳ تا ۲۴ حرف انگلیسی، عدد یا زیرخط باشد و با حرف شروع شود.');
                    }
                    if ($this->db->value('SELECT 1 FROM users WHERE alias=? AND id<>?', $value, $id)) {
                        throw new PlayError('این نام کاربری گرفته شده. یک نام دیگر بفرست.');
                    }
                }
                if ($value !== shortText($value, $max)) {
                    throw new PlayError('حداکثر ' . fa($max) . ' نویسه بنویس.');
                }
                $this->db->run("UPDATE users SET $field=?,prompt=NULL WHERE id=?", $value !== '' || $field === 'bio' ? $value : null, $id);
                $this->show($id, $this->screens->profile($this->db->one('SELECT * FROM users WHERE id=?', $id)));
                break;
            case 'feedback':
            case 'paysupport':
                $feedback = shortText($text, 700);
                if (!preg_match('/\\A.{4}/us', $feedback)) {
                    throw new PlayError('چند کلمه بیشتر دربارهٔ موضوع بنویس.');
                }
                $isPayment = $user['prompt'] === 'paysupport';
                $this->db->run('INSERT INTO feedback(user_id,kind,message,created_at) VALUES(?,?,?,?)',
                    $isPayment ? $id : null, $user['prompt'], $feedback, $this->now
                );
                $number = $this->db->pdo->lastInsertId();
                $this->db->run('UPDATE users SET prompt=NULL WHERE id=?', $id);
                $this->notices->text($id, $isPayment ? '✅ درخواست پرداخت ثبت شد. شمارهٔ پیگیری  ' . fa($number) : '✅ بازخورد ناشناس ثبت شد. ممنون که گفتی.', [[Screens::home()]]);
                break;
            default:
                $this->show($id, $this->screens->main($user));
        }
    }

    private function search(array $user, string $input): void
    {
        $value = latin(trim($input));
        $target = null;
        if (preg_match('/\A[1-9][0-9]{1,15}\z/', $value)) {
            $target = $this->db->one('SELECT * FROM users WHERE id=?', (int) $value);
        } elseif (preg_match('/\A@?[a-zA-Z0-9_]{3,32}\z/', $value)) {
            $handle = ltrim($value, '@');
            $columns = str_starts_with($value, '@') ? ['telegram_username', 'alias'] : ['alias', 'telegram_username'];
            foreach ($columns as $column) {
                $target = $this->db->one("SELECT * FROM users WHERE $column=? ORDER BY active_at DESC LIMIT 1", $handle);
                if ($target) {
                    break;
                }
            }
        }
        if (!$target || $target['id'] === $user['id']) {
            throw new PlayError('بازیکن پیدا نشد. دوستت باید دست‌کم یک بار /start زده باشد.');
        }
        $this->db->run('UPDATE users SET prompt=NULL WHERE id=?', $user['id']);
        $text = '👤 <b>' . escaped(Screens::player($target)) . '</b>' . ($target['alias'] ? "\n<code>" . escaped($target['alias']) . '</code>' : '');
        $this->notices->text($user['id'], $text, [[Screens::button('✉️ دعوت به میز', 'invite:' . $target['id'], 'success')], [Screens::button('جستجوی دوباره', 'search'), Screens::home()]]);
    }

    private function cancel(array $user, bool $leave = false): void
    {
        $id = $user['id'];
        $this->db->run('UPDATE users SET prompt=NULL WHERE id=?', $id);
        if ($user['prompt'] && !$leave) {
            $this->notices->text($id, 'ورودی لغو شد.', [[Screens::home()]]);
            return;
        }
        if ($this->db->run('DELETE FROM queue WHERE user_id=?', $id)) {
            $this->notices->text($id, 'از صف حریف‌یابی خارج شدی.', [[Screens::button('بازی جدید', 'play'), Screens::home()]]);
            return;
        }
        $current = $this->tables->current($id);
        if (!$current) {
            $this->show($id, $this->screens->main($user));
            return;
        }
        if ($current['status'] === 'waiting') {
            $this->tables->leaveWaiting($current, $id);
            $this->notices->text($id, 'از میز خصوصی خارج شدی.', [[Screens::home()]]);
            return;
        }
        $state = json_decode($current['state'], true, 32, JSON_THROW_ON_ERROR);
        $this->notices->text($id, 'از این مسابقه خارج می‌شوی؟ انصراف نتیجه را برای تیم مقابل ثبت می‌کند.', [
            [Screens::button('تأیید انصراف', 'act:' . $current['id'] . ':' . $state['v'] . ':resign:0', 'danger')],
            [Screens::button('ادامهٔ میز', 'table', 'success')],
        ]);
    }

    private function action(array $user, string $action): void
    {
        $id = $user['id'];
        if ($action === 'home') {
            $this->db->run('UPDATE users SET prompt=NULL WHERE id=?', $id);
        }
        if (preg_match('/\Aact:([1-9][0-9]*):([1-9][0-9]*):(cut|trump|card|redeal|vote|bam|resign):([0-9]{1,2})\z/', $action, $move)) {
            $this->tables->act($id, (int) $move[1], (int) $move[2], $move[3], (int) $move[4]);
            return;
        }
        if (preg_match('/\Aboard:(day|week|month):([01])\z/', $action, $period)) {
            $this->show($id, $this->screens->board($id, $period[1], (bool) $period[2]));
            return;
        }
        if (preg_match('/\Ajoin:([a-f0-9]{12})\z/', $action, $join)) {
            $this->tables->joinRoom($id, $join[1]);
            return;
        }
        if (preg_match('/\Ainvite:([1-9][0-9]{1,15})\z/', $action, $target)) {
            $friend = (int) $target[1];
            if (!$this->db->value('SELECT 1 FROM users WHERE id=?', $friend)) {
                throw new PlayError('این بازیکن پیدا نشد.');
            }
            $this->tables->invite($id, $friend, Screens::player($user));
            $this->notices->text($id, '✉️ دعوت فرستاده شد.', [[Screens::button('میز من', 'table', 'primary')]]);
            return;
        }
        if (preg_match('/\A(buy|theme):(classic|royal|emerald)\z/', $action, $purchase)) {
            if ($purchase[1] === 'buy') {
                $this->payments->order($id, $purchase[2]);
            } else {
                $this->payments->theme($id, $purchase[2]);
                $this->show($id, $this->screens->store($this->db->one('SELECT * FROM users WHERE id=?', $id)));
            }
            return;
        }

        $view = match ($action) {
            'home' => $this->screens->main($user),
            'play' => $this->screens->modes(),
            'profile' => $this->screens->profile($user),
            'wallet' => $this->screens->wallet($id),
            'store' => $this->screens->store($user),
            'friends' => $this->screens->friends($id),
            'help' => $this->screens->help(),
            'history' => $this->screens->history($id),
            'privacy' => [
                "🔐 <b>حریم خصوصی</b>\n\nبرای ورود و دعوت، شناسه، نام و نام کاربری تلگرام ثبت می‌شود. امتیاز و نتیجه برای جدول و پروفایل، و شناسه و مبلغ پرداخت برای رسید و بازگشت وجه روی هاست نگهداری می‌شود. بازخورد عمومی بدون شناسه ثبت می‌شود. برای اصلاح یا حذف داده‌ها /feedback را بزن و راه ارتباطی دلخواهت را بده.",
                [[Screens::home()]],
            ],
            default => null,
        };
        if ($view !== null) {
            $this->show($id, $view);
            return;
        }
        $prompts = [
            'search' => '🔍 شناسهٔ عددی، ‎@username تلگرام یا نام کاربری داخل میز حکم را بفرست.',
            'edit:nickname' => 'نام نمایشی تا ۳۲ نویسه را بفرست. برای برگشت به نام تلگرام، «پاک» را بفرست.',
            'edit:alias' => 'نام کاربری ۳ تا ۲۴ نویسه‌ای را با حرف انگلیسی شروع کن. عدد و زیرخط هم مجازند. برای حذف، «پاک» را بفرست.',
            'edit:bio' => 'یک معرفی کوتاه تا ۱۱۰ نویسه بنویس. برای حذف، «پاک» را بفرست.',
            'feedback' => '💬 پیشنهاد یا گزارش خطا را در یک پیام بفرست. این بازخورد بدون شناسه ثبت می‌شود.',
            'paysupport' => '🧾 شناسهٔ رسید /wallet و مشکل پرداخت را بنویس. پاسخ پشتیبانی در همین گفتگو می‌آید.',
        ];
        if (isset($prompts[$action])) {
            $this->prompt($id, $action, $prompts[$action]);
            return;
        }
        switch ($action) {
            case 'queue':
                $queue = $this->tables->queue($id);
                if (!$queue['game']) {
                    $this->notices->text($id,
                        '⚡ <b>دنبال حریف می‌گردیم</b>' . "\n\n"
                        . 'تعداد نفرات صف  ' . fa($queue['count']) . ' از ۴' . "\n" . 'با کامل‌شدن میز، برگ‌ها همین‌جا می‌رسند. مهلت صف ۱۲ دقیقه است.',
                        [[Screens::button('خروج از صف', 'cancel', 'danger'), Screens::home()]]
                    );
                }
                break;
            case 'practice':
                $this->tables->practice($id);
                break;
            case 'room':
                $room = $this->tables->openRoom($id);
                $this->notices->table($room['id'], $id, true);
                break;
            case 'table':
                $game = $this->tables->current($id);
                if ($game) {
                    $this->notices->table($game['id'], $id, true);
                } elseif ($this->db->value('SELECT 1 FROM queue WHERE user_id=?', $id)) {
                    $this->notices->text($id, 'در صف حریف‌یابی هستی. به‌محض تکمیل میز، پیام می‌فرستیم.', [[Screens::button('خروج از صف', 'cancel', 'danger')]]);
                } else {
                    $this->show($id, $this->screens->modes());
                }
                break;
            case 'cancel':
            case 'leave':
                $this->cancel($user, $action === 'leave');
                break;
            default:
                throw new PlayError('این میانبر قدیمی شده. از /start وارد شو.');
        }
    }

    public function drain(float $seconds = 5.0): bool
    {
        $until = microtime(true) + $seconds;
        for ($sent = 0; $sent < 20 && microtime(true) < $until; $sent++) {
            $clock = time();
            $job = $this->db->write(function () use ($clock): ?array {
                $job = $this->db->one(
                    'SELECT * FROM outbox WHERE dead_at IS NULL AND available_at<=? AND lock_until<=?
                     ORDER BY id LIMIT 1', $clock, $clock
                );
                if ($job) {
                    $this->db->run('UPDATE outbox SET lock_until=?,attempts=attempts+1 WHERE id=?', $clock + 22, $job['id']);
                }
                return $job;
            });
            if (!$job) {
                break;
            }
            try {
                $stored = $this->deliver($job);
                $this->db->write(function () use ($job, $stored): void {
                    if ($stored) {
                        [$game, $message] = $stored;
                        $this->db->run('UPDATE seats SET telegram_message=? WHERE game_id=? AND user_id=?', $message, $game, $job['user_id']);
                    }
                    $this->db->run('DELETE FROM outbox WHERE id=? AND version=?', $job['id'], $job['version']);
                    $this->db->run('UPDATE outbox SET lock_until=0 WHERE id=?', $job['id']);
                });
            } catch (TelegramFailure $error) {
                $this->db->write(function () use ($job, $error, $clock): void {
                    $retry = ($error->uncertain() || $error->apiCode === 429) && $job['attempts'] < 6;
                    $wait = min(120, max($error->retry, 2 ** ($job['attempts'] + 1)));
                    $affected = $this->db->run(
                        'UPDATE outbox SET lock_until=0,available_at=?,last_error=?,dead_at=? WHERE id=? AND version=?',
                        $clock + $wait, $error->getMessage(), $retry ? null : $clock, $job['id'], $job['version']
                    );
                    if (!$affected) {
                        $this->db->run('UPDATE outbox SET lock_until=0 WHERE id=?', $job['id']);
                    } elseif (!$retry && $job['kind'] === 'invoice') {
                        $payload = json_decode($job['payload'], true, 16, JSON_THROW_ON_ERROR);
                        $this->db->run("UPDATE invoices SET status='issue_failed',updated_at=? WHERE status='pending' AND id=?", $clock, $payload['id']);
                    }
                });
            }
        }
        return !(bool) $this->db->value('SELECT 1 FROM outbox WHERE dead_at IS NULL LIMIT 1');
    }

    private function deliver(array $job): ?array
    {
        $user = $job['user_id'];
        $payload = json_decode($job['payload'], true, 16, JSON_THROW_ON_ERROR);
        switch ($job['kind']) {
            case 'invoice':
                $this->payments->issue($this->api, $payload['id']);
                break;
            case 'text':
                $this->api->call('sendMessage', self::telegramText($user, $payload['html'], $payload['buttons']));
                break;
            case 'table':
                $view = $this->screens->table($payload['game'], $user);
                if ($view === null) {
                    break;
                }
                [$text, $buttons, $message] = $view;
                $args = self::telegramText($user, $text, $buttons);
                if ($message) {
                    try {
                        $this->api->call('editMessageText', $args + ['message_id' => $message]);
                        return null;
                    } catch (TelegramFailure $error) {
                        $detail = strtolower($error->getMessage());
                        if (str_contains($detail, 'message is not modified')) {
                            return null;
                        }
                        if ($error->apiCode !== 400 || !preg_match("/message to edit not found|message can.t be edited|message_id_invalid|message identifier is not specified/", $detail)) {
                            throw $error;
                        }
                    }
                }
                $result = $this->api->call('sendMessage', $args);
                return [$payload['game'], $result['message_id']];
        }
        return null;
    }

    private static function telegramText(int $user, string $text, array $buttons): array
    {
        $data = ['chat_id' => $user, 'text' => $text, 'parse_mode' => 'HTML', 'link_preview_options' => ['is_disabled' => true]];
        if ($buttons) {
            $data['reply_markup'] = ['inline_keyboard' => $buttons];
        }
        return $data;
    }
}
