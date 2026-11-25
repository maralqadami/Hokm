<?php
declare(strict_types=1);

final class Screens
{
    public function __construct(
        private readonly Db $db,
        private readonly Tables $tables,
        private readonly Payments $payments,
        private readonly array $config,
        private readonly int $now,
    ) {}

    public static function button(string $text, string $action, ?string $style = null): array
    {
        $button = ['text' => $text, 'callback_data' => $action];
        if ($style) {
            $button['style'] = $style;
        }
        return $button;
    }

    public static function home(): array
    {
        return self::button('⌂ منوی اصلی', 'home');
    }

    public static function player(array $profile): string
    {
        return $profile['nickname'] ?: $profile['name'];
    }

    public function main(array $user): array
    {
        $name = escaped(self::player($user));
        $theme = Payments::THEMES[$user['theme']] ?? Payments::THEMES['classic'];
        $style = $user['theme'] === 'emerald' ? 'success' : 'primary';
        return [
            $theme['icon'] . ' <b>میز حکم</b>' . "\n\n" . $name . '، خوش اومدی! میز بعدی‌ات همین‌جاست.',
            [
                [self::button('🂡 شروع بازی', 'play', $style)],
                [self::button('♠️ میز من', 'table', 'success'), self::button('🏆 رتبه‌بندی', 'board:day:0', 'primary')],
                [self::button('✉️ دوستان', 'friends'), self::button('👤 پروفایل', 'profile')],
                [self::button('⭐ کیف پول و تم‌ها', 'wallet', 'primary')],
                [self::button('📖 قوانین', 'help'), self::button('💬 بازخورد', 'feedback')],
            ],
        ];
    }

    public function modes(): array
    {
        return [
            '🂡 <b>چه میزی می‌خوای؟</b>' . "\n\n"
            . 'رقابتی · حریف‌یابی و ثبت نتیجه در جدول' . "\n"
            . 'خصوصی · میز چهارنفره با لینک یا دعوت مستقیم' . "\n"
            . 'تمرینی · بازی با سه ربات به‌محض ورود',
            [
                [self::button('⚡ پیدا کردن حریف', 'queue', 'success')],
                [self::button('🔗 ساخت میز خصوصی', 'room', 'primary')],
                [self::button('🤖 تمرین با ربات‌ها', 'practice', 'primary')],
                [self::button('♠️ میز من', 'table'), self::home()],
            ],
        ];
    }

    public function profile(array $user): array
    {
        $stats = $this->db->one('SELECT COALESCE(SUM(won),0) wins,COALESCE(SUM(1-won),0) losses FROM results WHERE user_id=?', $user['id']);
        $rank = [];
        foreach (Period::TYPES as $type => $title) {
            $row = $this->tables->board($type, Period::key($type, $this->now), $user['id'], 1);
            $rank[] = $title . ' ' . (isset($row[0]) ? 'رتبهٔ ' . fa($row[0]['position']) : '—');
        }
        $sum = $stats['wins'] + $stats['losses'];
        $rate = $sum ? fa((int) round($stats['wins'] * 100 / $sum)) . '٪' : '—';
        $theme = Payments::THEMES[$user['theme']] ?? Payments::THEMES['classic'];
        $alias = $user['alias'] ? '<code>' . escaped($user['alias']) . '</code>' : 'هنوز انتخاب نشده';
        $text = $theme['icon'] . ' <b>' . escaped(self::player($user)) . "</b>\n"
            . ($user['bio'] ? escaped($user['bio']) . "\n" : '') . "\n"
            . 'نام کاربری میز حکم  ' . $alias . "\n"
            . 'شناسهٔ تلگرام  <code>' . $user['id'] . "</code>\n"
            . 'تم فعال  ' . escaped($theme['name']) . "\n\n"
            . 'برد  ' . fa($stats['wins']) . '  •  باخت  ' . fa($stats['losses']) . '  •  نرخ برد  ' . $rate . "\n"
            . implode('  |  ', $rank);
        return [$text, [
            [self::button('✏️ نام نمایشی', 'edit:nickname'), self::button('🔖 نام کاربری', 'edit:alias')],
            [self::button('📝 دربارهٔ من', 'edit:bio'), self::button('📊 آخرین بازی‌ها', 'history')],
            [self::button('⭐ کیف پول', 'wallet', 'primary'), self::home()],
        ]];
    }

    public function history(int $user): array
    {
        $matches = $this->db->all('SELECT r.*,g.mode FROM results r JOIN games g ON g.id=r.game_id
            WHERE r.user_id=? ORDER BY r.finished_at DESC,r.game_id DESC LIMIT 10', $user);
        $lines = [];
        foreach ($matches as $match) {
            $lines[] = ($match['won'] ? '✅ برد' : '✖️ باخت') . ' · ' . Tables::MODE[$match['mode']] . ' · ' . Period::stamp($match['finished_at']);
        }
        return [
            "📊 <b>آخرین بازی‌ها</b>\n\n" . ($lines ? implode("\n", $lines) : 'هنوز نتیجه‌ای ثبت نشده.'),
            [[self::button('پروفایل', 'profile'), self::home()]],
        ];
    }

    public function board(int $user, string $type, bool $previous): array
    {
        $key = Period::key($type, $this->now);
        if ($previous) {
            $key = Period::key($type, $key - 1);
        }
        $ranked = $this->tables->board($type, $key);
        $mine = $this->tables->board($type, $key, $user, 1);
        $lines = [];
        foreach ($ranked as $row) {
            $place = $row['position'];
            $badge = [1 => '🥇', 2 => '🥈', 3 => '🥉'][$place] ?? fa($place) . ' •';
            $name = escaped(self::player($row));
            $lines[] = $badge . ' ' . ($row['user_id'] === $user ? '<b>' . $name . '</b>' : $name)
                . '  ·  ' . fa($row['wins']) . ' برد، ' . fa($row['losses']) . ' باخت';
        }
        $text = '🏆 <b>جدول ' . Period::TYPES[$type] . '</b> · ' . Period::title($type, $key) . "\n\n"
            . ($lines ? implode("\n", $lines) : 'هنوز نتیجهٔ رقابتی کاملی در این بازه ثبت نشده.') . "\n\n"
            . (!empty($mine) ? 'رتبهٔ تو  <b>' . fa($mine[0]['position']) . '</b>' : 'رتبهٔ تو  —');
        if ($this->db->flag('rewards_open')) {
            $text .= "\n\n" . '🎁 گیفت‌های رتبه‌های ۱ تا ۳: به قیمت ۵۰، ۲۵ و ۱۵ استارز. ارسال پس از پایان بازه و در صورت موجودی کاتالوگ.';
        }
        $tabs = [];
        foreach (Period::TYPES as $period => $label) {
            $tabs[] = self::button($label, 'board:' . $period . ':' . (int) $previous, $type === $period ? 'primary' : null);
        }
        return [$text, [$tabs, [self::button($previous ? 'بازهٔ جاری' : 'بازهٔ قبلی', 'board:' . $type . ':' . (int) !$previous)], [self::home()]]];
    }

    public function wallet(int $user): array
    {
        $this->payments->expire();
        $net = $this->db->value("SELECT COALESCE(SUM(stars),0) FROM invoices WHERE user_id=? AND status='paid'", $user);
        $invoices = $this->db->all('SELECT * FROM invoices WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5', $user);
        $extra = $this->db->all("SELECT c.* FROM charges c LEFT JOIN invoices i ON i.primary_charge=c.id
            WHERE c.user_id=? AND i.id IS NULL ORDER BY c.created_at DESC LIMIT 3", $user);
        $text = "⭐ <b>کیف پول میز حکم</b>\n\nپرداخت‌های تم  <b>" . fa($net) . " استارز</b>\n";
        foreach ($invoices as $invoice) {
            $text .= "\n" . Payments::THEMES[$invoice['sku']]['name'] . ' · ' . fa($invoice['stars']) . ' ⭐ · ' . (Payments::STATUS[$invoice['status']] ?? 'در حال بررسی')
                . "\n" . '<code>' . substr($invoice['id'], 0, 10) . '</code> · ' . Period::stamp($invoice['created_at']) . "\n";
        }
        foreach ($extra as $charge) {
            $text .= "\n" . fa($charge['total']) . ' ⭐ · ' . (Payments::STATUS[$charge['status']] ?? 'در حال بررسی') . "\n";
        }
        if (!$invoices && !$extra) {
            $text .= "\nهنوز رسیدی نداری.";
        }
        return [$text, [
            [self::button('🎨 تم‌های میز و پروفایل', 'store', 'primary')],
            [self::button('💬 پشتیبانی پرداخت', 'paysupport'), self::home()],
        ]];
    }

    public function store(array $user): array
    {
        $text = "🎨 <b>تم‌های میز حکم</b>\n\nهر تم، ظاهر پروفایل و دکمه‌های میز را عوض می‌کند.";
        $rows = [];
        $open = $this->db->flag('store_open');
        foreach (Payments::THEMES as $sku => $item) {
            if ($user['theme'] === $sku) {
                $rows[] = [self::button('✓ ' . $item['name'] . ' · فعال', 'store')];
            } elseif ($this->payments->owned($user['id'], $sku)) {
                $rows[] = [self::button($item['icon'] . ' فعال کن · ' . $item['name'], 'theme:' . $sku, 'success')];
            } elseif ($open) {
                $rows[] = [self::button($item['icon'] . ' ' . $item['name'] . ' · ' . fa($item['stars']) . ' ⭐', 'buy:' . $sku, 'primary')];
            }
        }
        if (!$open) {
            $text .= "\n\nصدور فاکتور جدید غیرفعال است.";
        }
        $rows[] = [self::button('کیف پول', 'wallet'), self::home()];
        return [$text, $rows];
    }

    public function friends(int $user): array
    {
        $invites = $this->db->all("SELECT g.code, u.name,u.nickname FROM invites i
            JOIN games g ON g.id=i.game_id JOIN users u ON u.id=i.from_id
            WHERE i.user_id=? AND g.status='waiting' AND g.due_at>? ORDER BY i.created_at DESC LIMIT 5", $user, $this->now);
        $buttons = [[self::button('🔍 جستجوی بازیکن', 'search', 'primary')], [self::button('🔗 ساخت میز و لینک دعوت', 'room', 'success')]];
        foreach ($invites as $invite) {
            $buttons[] = [self::button('✉️ دعوت ' . self::player($invite), 'join:' . $invite['code'])];
        }
        $buttons[] = [self::home()];
        return [
            '✉️ <b>دعوت به میز</b>' . "\n\n" . 'دوستت را با شناسهٔ عددی تلگرام، ‎@username یا نام کاربری میز حکم پیدا کن.',
            $buttons,
        ];
    }

    public function help(): array
    {
        return [
            "📖 <b>قوانین حکم چهارنفره</b>\n\n"
            . "• یارها روبه‌روی هم‌اند. آس اول حاکم و آس اولِ بازیکن دیگر، یار او را مشخص می‌کند.\n"
            . "• بعد از کوپ، همه پنج برگ می‌گیرند. حاکم خال حکم را تعیین می‌کند و دو بستهٔ چهارتایی به هر نفر می‌رسد.\n"
            . "• حاکم دور اول را باز می‌کند. اگر خال زمینه را داری باید همان را بازی کنی. در نبودش هر برگی مجاز است. حکم از خال‌های دیگر بالاتر است. آس بالاترینِ هر خال است.\n"
            . "• برندهٔ هر دست، برگ اول دست بعد را می‌گذارد. هفت دست یک دور را می‌برد. هفت امتیاز نتیجهٔ مسابقه را تعیین می‌کند.\n"
            . "• برد ۷ به ۰ کت است. کت عادی ۲ امتیاز دارد و کت کردن تیم حاکم ۳ امتیاز. تیم برنده می‌تواند برای برد ۱۳ به ۰ و بام ادامه دهد.\n"
            . "• با برد تیم حاکم، حاکم می‌ماند. با باخت آن تیم، حاکم به نفر بعد می‌رسد. مهلت هر نوبت ۵ دقیقه است.\n\n"
            . '<a href="https://fa.wikipedia.org/wiki/%D8%AD%DA%A9%D9%85_(%D8%A8%D8%A7%D8%B2%DB%8C)">مرجع قوانین حکم</a>',
            [[self::button('🎮 شروع بازی', 'play', 'primary'), self::home()]],
        ];
    }

    public function table(int $gameId, int $user): ?array
    {
        $game = $this->db->one('SELECT * FROM games WHERE id=?', $gameId);
        if (!$game) {
            return null;
        }
        $members = $this->tables->members($gameId);
        $me = null;
        $seat = null;
        $names = [];
        foreach ($members as $player) {
            $index = $player['seat'];
            $names[$index] = $player['user_id'] === null ? 'ربات ' . fa($index + 1) : self::player($player);
            if ($player['user_id'] === $user) {
                $seat = $index;
                $me = $player;
            }
        }
        if ($me === null) {
            return null;
        }
        $rows = [];
        $theme = Payments::THEMES[$me['theme']] ?? Payments::THEMES['classic'];
        $skin = $me['theme'] === 'royal' ? 'میز شاهانه' : 'میز';
        $title = $theme['icon'] . ' <b>' . $skin . ' · ' . Tables::MODE[$game['mode']] . '</b> · ' . fa($gameId);
        $primary = $me['theme'] === 'emerald' ? 'success' : 'primary';
        if ($game['status'] === 'cancelled') {
            return [$title . "\n\nمیز بسته شد.", [[self::button('میز تازه', 'play', $primary), self::home()]], $me['telegram_message']];
        }
        if ($game['status'] === 'waiting') {
            $link = 'https://t.me/' . $this->config['username'] . '?start=j_' . $game['code'];
            $rows[] = [['text' => '🔗 اشتراک لینک میز', 'url' => 'https://t.me/share/url?url=' . rawurlencode($link), 'style' => $primary]];
            $rows[] = [self::button('🔍 پیدا کردن دوست', 'search'), self::button('خروج از میز', 'leave', 'danger')];
            $text = $title . "\n\n" . 'بازیکن حاضر  ' . fa(count($members)) . ' از ۴' . "\n"
                . escaped(implode(' · ', $names)) . "\n\n" . '<code>' . escaped($link) . '</code>';
            return [$text, $rows, $me['telegram_message']];
        }
        $state = json_decode($game['state'], true, 32, JSON_THROW_ON_ERROR);
        $team = $seat % 2;
        $text = $title . "\n"
            . 'یار تو  <b>' . escaped($names[($seat + 2) % 4]) . '</b>' . "\n"
            . 'حریف‌ها  ' . escaped($names[($seat + 1) % 4] . ' و ' . $names[($seat + 3) % 4]) . "\n\n"
            . 'امتیاز دورها  <b>' . fa($state['score'][$team]) . ' – ' . fa($state['score'][1 - $team]) . "</b>  (شما – حریف)\n";
        if ($state['lastRound'] && $state['phase'] !== 'ended') {
            $last = $state['lastRound'];
            $text .= ($last['team'] === $team ? 'دور قبلی برای شما' : 'دور قبلی برای حریف')
                . ' · ' . fa($last['points']) . " امتیاز\n";
        }
        if ($game['status'] === 'ended') {
            $reason = match ($state['reason']) {
                'bam' => 'بام · ۱۳ دست پیاپی',
                'timeout' => 'پایان مهلت نوبت',
                'resign' => 'انصراف بازیکن',
                default => 'پایان امتیازهای مسابقه',
            };
            return [
                $text . "\n" . ($state['winner'] === $team ? '🏅 <b>تیم تو برنده شد!</b>' : '♠️ <b>تیم حریف برنده شد.</b>')
                . "\n" . $reason,
                [[self::button('بازی دوباره', 'play', 'success'), self::button('پروفایل', 'profile')], [self::home()]],
                $me['telegram_message'],
            ];
        }
        $text .= 'حاکم  ' . escaped($names[$state['ruler']]) . '  ·  حکم  '
            . ($state['trump'] === null ? '—' : Hokm::SUITS[$state['trump']] . ' ' . Hokm::NAMES[$state['trump']]) . "\n";
        if ($state['notice']) {
            $text .= "\n" . escaped($state['notice']) . "\n";
        }
        if (in_array($state['phase'], ['play','bam'], true)) {
            $text .= 'دست‌های همین دور  ' . fa($state['tricks'][$team]) . ' – ' . fa($state['tricks'][1 - $team]) . "\n";
            if ($state['lastWinner'] !== null && !$state['trick']) {
                $text .= 'دست قبلی برای ' . escaped($names[$state['lastWinner']]) . "\n";
            }
            if ($state['trick']) {
                $cards = [];
                foreach ($state['trick'] as [$player, $card]) {
                    $cards[] = escaped($names[$player]) . ' <code>' . Hokm::label($card) . '</code>';
                }
                $text .= 'زمین  ' . implode(' · ', $cards) . "\n";
            }
        }
        $mine = $state['turn'] === $seat;
        $phase = match ($state['phase']) {
            'cut' => 'کوپِ ورق',
            'choose' => 'انتخاب خال حکم',
            'bam' => 'انتخاب بام یا ثبت کت',
            default => 'انداختن برگ',
        };
        $text .= "\n" . ($mine ? '🟢 <b>نوبت توست</b>' : '⏳ نوبت ' . escaped($names[$state['turn']])) . ' · ' . $phase
            . "\n" . 'تا ساعت ' . fa(Period::local($game['due_at'])->format('H:i')) . ' به وقت تهران';
        $hand = $state['hands'][$seat];
        if ($state['phase'] === 'choose' && $seat !== $state['ruler']) {
            $hand = [];
        }
        if ($hand) {
            sort($hand);
            $text .= "\n\n" . 'برگ‌های تو  <code>' . implode('  ', array_map(Hokm::label(...), $hand)) . '</code>';
        }
        $action = 'act:' . $gameId . ':' . $state['v'] . ':';
        if ($mine) {
            switch ($state['phase']) {
                case 'cut':
                    $rows[] = [self::button('ربع', $action . 'cut:13'), self::button('وسط', $action . 'cut:26', $primary), self::button('سه‌چهارم', $action . 'cut:39')];
                    $rows[] = [self::button('قبول بر · بدون کوپ', $action . 'cut:0')];
                    break;
                case 'choose':
                    $suits = [];
                    foreach (Hokm::SUITS as $i => $suit) {
                        $suits[] = self::button($suit . ' ' . Hokm::NAMES[$i], $action . 'trump:' . $i, in_array($i, [1,3], true) ? 'danger' : $primary);
                    }
                    $rows[] = $suits;
                    if (Hokm::canRulerRedeal($state)) {
                        $rows[] = [self::button('درخواست پخش دوباره', $action . 'redeal:0')];
                    }
                    break;
                case 'bam':
                    $rows[] = [self::button('ثبت کت', $action . 'bam:0', 'success'), self::button('ادامه برای بام', $action . 'bam:1', $primary)];
                    break;
                case 'play':
                    $cards = Hokm::legal($state, $seat);
                    sort($cards);
                    $buttons = [];
                    foreach ($cards as $card) {
                        $style = Hokm::suit($card) === $state['trump'] ? 'success' : (in_array(Hokm::suit($card), [1,3], true) ? 'danger' : $primary);
                        $buttons[] = self::button(Hokm::label($card), $action . 'card:' . $card, $style);
                    }
                    array_push($rows, ...array_chunk($buttons, 4));
                    break;
            }
        }
        if (Hokm::voteOpen($state) && !in_array($seat, $state['votes'], true)) {
            $rows[] = [self::button('رأی به پخش دوباره', 'act:' . $gameId . ':' . $state['round'] . ':vote:0')];
        }
        $rows[] = [self::home(), self::button('انصراف', 'leave', 'danger')];
        return [$text, $rows, $me['telegram_message']];
    }
}
