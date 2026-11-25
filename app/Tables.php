<?php
declare(strict_types=1);

final class Notices
{
    public function __construct(private readonly Db $db, private readonly int $now) {}

    public function add(string $kind, int $user, array $payload = [], ?string $route = null): void
    {
        $this->db->run(
            'INSERT INTO outbox(route,kind,user_id,payload,available_at) VALUES(?,?,?,?,?)
             ON CONFLICT(route) DO UPDATE SET payload=excluded.payload, version=outbox.version+1,
                 available_at=excluded.available_at, attempts=0, dead_at=NULL, last_error=NULL',
            $route, $kind, $user, encoded($payload), $this->now
        );
    }

    public function text(int $user, string $html, array $buttons = []): void
    {
        $this->add('text', $user, ['html' => $html, 'buttons' => $buttons]);
    }

    public function table(int $game, int $user, bool $fresh = false): void
    {
        $this->add('table', $user, ['game' => $game], 'table:' . $game . ':' . $user);
        if ($fresh) {
            $this->db->run('UPDATE seats SET telegram_message=NULL WHERE game_id=? AND user_id=?', $game, $user);
        }
    }
}

final class Tables
{
    public const TURN_SECONDS = 300;
    public const QUEUE_SECONDS = 720;
    public const ROOM_SECONDS = 3600;
    public const MODE = ['ranked' => 'رقابتی', 'private' => 'خصوصی', 'practice' => 'تمرینی'];
    public const REWARD_COSTS = [50, 25, 15];

    private readonly Notices $notices;

    public function __construct(private readonly Db $db, private readonly int $now)
    {
        $this->notices = new Notices($db, $now);
    }

    public function current(int $user): ?array
    {
        return $this->db->one(
            "SELECT g.* FROM games g JOIN seats s ON s.game_id=g.id
             WHERE s.user_id=? AND g.status IN ('waiting','active') ORDER BY g.id DESC LIMIT 1", $user
        );
    }

    public function members(int $game): array
    {
        return $this->db->all(
            'SELECT s.*, u.name, u.nickname, u.alias, u.theme
             FROM seats s LEFT JOIN users u ON u.id=s.user_id WHERE s.game_id=? ORDER BY s.seat', $game
        );
    }

    private function ensureAvailable(int $user): void
    {
        if ($this->current($user)) {
            throw new PlayError('یک میز باز داری. از «میز من» ادامه بده.');
        }
    }

    public function queue(int $user): array
    {
        $this->ensureAvailable($user);
        $this->db->run('INSERT OR IGNORE INTO queue VALUES(?,?)', $user, $this->now);
        $queued = $this->db->all('SELECT user_id FROM queue WHERE joined_at>? ORDER BY joined_at,rowid', $this->now - self::QUEUE_SECONDS);
        $ids = array_column(array_slice($queued, 0, 4), 'user_id');
        if (count($ids) === 4) {
            $game = $this->insert('ranked', null, null);
            $this->activate($game, $ids);
            return ['game' => $game, 'count' => 4];
        }
        return ['game' => null, 'count' => count($queued)];
    }

    public function practice(int $user): int
    {
        $this->ensureAvailable($user);
        $game = $this->insert('practice', $user, null);
        $this->activate($game, [$user, null, null, null]);
        return $game;
    }

    public function openRoom(int $user): array
    {
        $existing = $this->current($user);
        if ($existing && $existing['status'] === 'waiting' && $existing['mode'] === 'private') {
            return $existing;
        }
        $this->ensureAvailable($user);
        $game = $this->insert('private', $user, bin2hex(random_bytes(6)));
        $this->db->run('DELETE FROM queue WHERE user_id=?', $user);
        $this->db->run('INSERT INTO seats(game_id,seat,user_id) VALUES(?,0,?)', $game, $user);
        return $this->db->one('SELECT * FROM games WHERE id=?', $game);
    }

    private function insert(string $mode, ?int $owner, ?string $code): int
    {
        $this->db->run(
            "INSERT INTO games(mode,status,owner_id,code,created_at,due_at) VALUES(?,'waiting',?,?,?,?)",
            $mode, $owner, $code, $this->now, $this->now + self::ROOM_SECONDS
        );
        return (int) $this->db->pdo->lastInsertId();
    }

    private function activate(int $game, array $users): void
    {
        [$players, $state] = Hokm::start($users);
        Hokm::automatic($state, $players);
        $before = array_column($this->members($game), 'telegram_message', 'user_id');
        $this->db->run('DELETE FROM seats WHERE game_id=?', $game);
        foreach ($players as $seat => $user) {
            $message = $user === null ? null : ($before[$user] ?? null);
            $this->db->run('INSERT INTO seats(game_id,seat,user_id,telegram_message) VALUES(?,?,?,?)', $game, $seat, $user, $message);
            if ($user !== null) {
                $this->db->run('DELETE FROM queue WHERE user_id=?', $user);
            }
        }
        $this->db->run("UPDATE games SET status='active',state=?,due_at=? WHERE id=?", encoded($state), $this->now + self::TURN_SECONDS, $game);
        $this->notify($game);
    }

    public function joinRoom(int $user, string $code): void
    {
        $game = $this->db->one("SELECT * FROM games WHERE status='waiting' AND code=? AND due_at>?", strtolower($code), $this->now);
        if (!$game) {
            throw new PlayError('این دعوت معتبر نیست یا میز پر شده.');
        }
        $existing = $this->current($user);
        if ($existing && $existing['id'] === $game['id']) {
            $this->notices->table($game['id'], $user, true);
            return;
        }
        $this->ensureAvailable($user);
        $members = $this->members($game['id']);
        $free = array_values(array_diff([0,1,2,3], array_column($members, 'seat')));
        $this->db->run('DELETE FROM queue WHERE user_id=?', $user);
        $this->db->run('INSERT INTO seats(game_id,seat,user_id) VALUES(?,?,?)', $game['id'], $free[0], $user);
        if (count($free) === 1) {
            $this->activate($game['id'], [...array_column($members, 'user_id'), $user]);
        } else {
            $this->notify($game['id']);
        }
    }

    public function invite(int $from, int $user, string $name): void
    {
        if ($from === $user) {
            throw new PlayError('این پروفایل خودت است.');
        }
        if ((int) $this->db->value('SELECT COUNT(*) FROM invites WHERE from_id=? AND created_at>?', $from, $this->now - 300) >= 5) {
            throw new PlayError('تا چند دقیقه دیگر دوباره دعوت بفرست.');
        }
        $game = $this->openRoom($from);
        if (!$this->db->run('INSERT OR IGNORE INTO invites VALUES(?,?,?,?)', $game['id'], $from, $user, $this->now)) {
            throw new PlayError('قبلاً دعوت این میز برای این بازیکن ارسال شده.');
        }
        $this->notices->text($user, '✉️ <b>دعوت به میز حکم</b>' . "\n" . escaped($name) . ' تو را به یک مسابقهٔ خصوصی دعوت کرده.', [
            [['text' => 'قبول دعوت', 'callback_data' => 'join:' . $game['code'], 'style' => 'success']],
        ]);
        $this->notices->table($game['id'], $from);
    }

    public function leaveWaiting(array $game, int $user): void
    {
        if ($game['owner_id'] === $user) {
            $this->cancel($game['id']);
            return;
        }
        $this->db->run('DELETE FROM seats WHERE game_id=? AND user_id=?', $game['id'], $user);
        $this->notify($game['id']);
    }

    private function cancel(int $game): void
    {
        $this->db->run("UPDATE games SET status='cancelled',due_at=NULL,ended_at=? WHERE id=?", $this->now, $game);
        $this->notify($game);
    }

    public function sweep(): void
    {
        $this->db->run('DELETE FROM queue WHERE joined_at<=?', $this->now - self::QUEUE_SECONDS);
        $overdue = $this->db->all("SELECT * FROM games WHERE status IN ('waiting','active') AND due_at<=? ORDER BY due_at LIMIT 12", $this->now);
        foreach ($overdue as $game) {
            if ($game['status'] === 'waiting') {
                $this->cancel($game['id']);
                continue;
            }
            $state = json_decode($game['state'], true, 32, JSON_THROW_ON_ERROR);
            if ($state['phase'] === 'bam') {
                $seat = $state['turn'];
                Hokm::action($state, $seat, 'bam', 0);
                $players = array_column($this->members($game['id']), 'user_id');
                Hokm::automatic($state, $players);
                $this->save($game, $state);
                continue;
            }
            Hokm::finish($state, 1 - $state['turn'] % 2, 'timeout');
            $this->save($game, $state);
        }
    }

    public function act(int $actor, int $gameId, int $version, string $verb, int $value): void
    {
        $game = $this->current($actor);
        if (!$game || $game['id'] !== $gameId || $game['status'] !== 'active') {
            throw new PlayError('این میز دیگر فعال نیست. «میز من» را باز کن.');
        }
        if ($game['due_at'] <= $this->now) {
            throw new PlayError('زمان این نوبت تمام شده. میز را دوباره باز کن.');
        }
        $players = array_column($this->members($gameId), 'user_id');
        $seat = array_search($actor, $players, true);
        $state = json_decode($game['state'], true, 32, JSON_THROW_ON_ERROR);
        if ($verb === 'vote') {
            if ($version !== $state['round']) {
                throw new PlayError('این رأی برای دست قبلی بود.');
            }
            $before = $state['v'];
            Hokm::vote($state, $seat);
            $this->save($game, $state, $before !== $state['v']);
            return;
        }
        if ($state['v'] !== $version) {
            $this->notices->table($gameId, $actor);
            throw new PlayError('میز به‌روز شد. با دکمه‌های آخرین پیام ادامه بده.');
        }
        if ($verb === 'resign') {
            Hokm::finish($state, 1 - $seat % 2, 'resign');
        } else {
            Hokm::action($state, $seat, $verb, $value);
            Hokm::automatic($state, $players);
        }
        $this->save($game, $state);
    }

    private function save(array $game, array $state, bool $progress = true): void
    {
        $id = $game['id'];
        if ($state['phase'] !== 'ended') {
            $due = $progress ? $this->now + self::TURN_SECONDS : $game['due_at'];
            $this->db->run('UPDATE games SET state=?,due_at=? WHERE id=?', encoded($state), $due, $id);
        } else {
            $this->db->run("UPDATE games SET status='ended',state=?,ended_at=?,due_at=NULL WHERE id=?", encoded($state), $this->now, $id);
            if ($game['mode'] !== 'practice' && $state['winner'] !== null) {
                $ranked = (int) ($game['mode'] === 'ranked' && in_array($state['reason'], ['score','bam'], true));
                $periods = array_map(fn(string $type): int => Period::key($type, $this->now), array_keys(Period::TYPES));
                foreach ($this->members($id) as $member) {
                    $this->db->run(
                        'INSERT INTO results VALUES(?,?,?,?,?,?,?,?)', $id, $member['user_id'],
                        (int) ($member['seat'] % 2 === $state['winner']), $ranked, $this->now, ...$periods
                    );
                }
            }
        }
        $this->notify($id);
    }

    private function notify(int $game): void
    {
        foreach ($this->members($game) as $player) {
            if ($player['user_id'] !== null) {
                $this->notices->table($game, $player['user_id']);
            }
        }
    }

    public function board(string $type, int $key, ?int $user = null, int $limit = 10): array
    {
        if (!isset(Period::TYPES[$type])) {
            throw new InvalidArgumentException('Invalid leaderboard period');
        }
        $where = $user === null ? '' : ' WHERE user_id=?';
        $params = $user === null ? [$key, $limit] : [$key, $user, $limit];
        return $this->db->all(
            "WITH stats AS (
                SELECT user_id,SUM(won) wins,SUM(1-won) losses,MIN(CASE WHEN won=1 THEN finished_at END) first_win
                FROM results WHERE ranked=1 AND $type=? GROUP BY user_id
            ), ranked_rows AS (
                SELECT stats.*,ROW_NUMBER() OVER(ORDER BY wins DESC,losses ASC,first_win ASC,user_id ASC) position FROM stats
            )
            SELECT * FROM ranked_rows JOIN users ON users.id=ranked_rows.user_id$where ORDER BY position LIMIT ?", ...$params
        );
    }

    public function prepareRewards(): void
    {
        foreach (array_keys(Period::TYPES) as $type) {
            $keys = $this->db->all(
                "SELECT DISTINCT r.$type period FROM results r
                 WHERE r.ranked=1 AND r.$type<?
                 AND NOT EXISTS (SELECT 1 FROM rewards a WHERE a.period=? AND a.period_start=r.$type)
                 ORDER BY r.$type DESC", Period::key($type, $this->now), $type
            );
            foreach ($keys as $key) {
                foreach ($this->board($type, $key['period'], null, 3) as $winner) {
                    $rank = $winner['position'];
                    $this->db->run(
                        'INSERT OR IGNORE INTO rewards(period,period_start,rank,user_id,cost,updated_at) VALUES(?,?,?,?,?,?)',
                        $type, $key['period'], $rank, $winner['user_id'], self::REWARD_COSTS[$rank - 1], $this->now
                    );
                }
            }
        }
    }
}
