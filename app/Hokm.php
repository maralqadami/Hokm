<?php
declare(strict_types=1);

final class PlayError extends RuntimeException {}

final class Hokm
{
    public const SUITS = ['♠', '♥', '♣', '♦'];
    public const NAMES = ['پیک', 'دل', 'گشنیز', 'خشت'];
    private const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

    public static function deck(): array
    {
        $deck = range(0, 51);
        for ($i = 51; $i > 0; --$i) {
            $j = random_int(0, $i);
            [$deck[$i], $deck[$j]] = [$deck[$j], $deck[$i]];
        }
        return $deck;
    }

    public static function suit(int $card): int
    {
        return intdiv($card, 13);
    }

    public static function label(int $card): string
    {
        return self::SUITS[self::suit($card)] . self::RANKS[$card % 13];
    }

    public static function start(array $players): array
    {
        $first = random_int(0, 3);
        $ruler = null;
        $partner = null;
        while ($partner === null) {
            foreach (self::deck() as $offset => $card) {
                if ($card % 13 !== 12) {
                    continue;
                }
                $seat = ($first + $offset) % 4;
                if ($ruler === null) {
                    $ruler = $seat;
                } elseif ($seat !== $ruler) {
                    $partner = $seat;
                    break;
                }
            }
        }
        $others = array_values(array_diff([0, 1, 2, 3], [$ruler, $partner]));
        $seats = [$players[$ruler], $players[$others[0]], $players[$partner], $players[$others[1]]];
        $state = [
            'ruler' => 0, 'score' => [0, 0], 'round' => 0, 'v' => 0,
            'lastRound' => null, 'winner' => null, 'reason' => null, 'notice' => null,
        ];
        self::newRound($state);
        return [$seats, $state];
    }

    private static function newRound(array &$state, ?string $notice = null): void
    {
        $state['phase'] = 'cut';
        $state['turn'] = ($state['ruler'] + 2) % 4;
        $state['deck'] = self::deck();
        $state['hands'] = [[], [], [], []];
        $state['trump'] = null;
        $state['trick'] = [];
        $state['tricks'] = [0, 0];
        $state['lastWinner'] = null;
        $state['cut'] = false;
        $state['bam'] = false;
        $state['votes'] = [];
        $state['notice'] = $notice;
        $state['round']++;
        $state['v']++;
    }

    private static function packets(array &$state, int $size): void
    {
        for ($i = 0; $i < 4; ++$i) {
            $seat = ($state['ruler'] + $i) % 4;
            array_push($state['hands'][$seat], ...array_splice($state['deck'], 0, $size));
        }
    }

    public static function canRulerRedeal(array $state): bool
    {
        if ($state['phase'] !== 'choose' || $state['cut']) {
            return false;
        }
        foreach ($state['hands'][$state['ruler']] as $card) {
            if ($card % 13 > 8) {
                return false;
            }
        }
        return true;
    }

    public static function voteOpen(array $state): bool
    {
        return $state['phase'] === 'play' && array_sum($state['tricks']) === 0 && !$state['trick'];
    }

    public static function vote(array &$state, int $seat): void
    {
        if (!self::voteOpen($state) || in_array($seat, $state['votes'], true)) {
            throw new PlayError('رأی تکراری است یا اولین برگ بازی شده.');
        }
        foreach ($state['hands'][$state['ruler']] as $card) {
            if (self::suit($card) === $state['trump']) {
                throw new PlayError('این دست مشمول پخش دوباره با رأی نیست.');
            }
        }
        $state['votes'][] = $seat;
        if (count($state['votes']) === 2) {
            self::newRound($state, 'دو بازیکن به پخش دوباره رأی دادند.');
        }
    }

    public static function legal(array $state, int $seat): array
    {
        $hand = $state['hands'][$seat];
        if (!$state['trick']) {
            return $hand;
        }
        $lead = self::suit($state['trick'][0][1]);
        $follow = array_values(array_filter($hand, static fn(int $card): bool => self::suit($card) === $lead));
        return $follow ?: $hand;
    }

    private static function strength(int $card, int $lead, int $trump): int
    {
        $suit = self::suit($card);
        return match (true) {
            $suit === $trump => 26 + $card % 13,
            $suit === $lead => 13 + $card % 13,
            default => 0,
        };
    }

    private static function trickWinner(array $trick, int $trump): int
    {
        $lead = self::suit($trick[0][1]);
        $best = -1;
        $winner = $trick[0][0];
        foreach ($trick as [$seat, $card]) {
            $strength = self::strength($card, $lead, $trump);
            if ($strength > $best) {
                $best = $strength;
                $winner = $seat;
            }
        }
        return $winner;
    }

    private static function roundWin(array &$state, int $team, int $points): void
    {
        $state['score'][$team] += $points;
        $state['lastRound'] = ['team' => $team, 'points' => $points, 'tricks' => $state['tricks']];
        if ($state['score'][$team] >= 7) {
            self::finish($state, $team, 'score');
            return;
        }
        if ($team !== $state['ruler'] % 2) {
            $state['ruler'] = ($state['ruler'] + 1) % 4;
        }
        self::newRound($state);
    }

    public static function finish(array &$state, ?int $winner, string $reason): void
    {
        $state['phase'] = 'ended';
        $state['winner'] = $winner;
        $state['reason'] = $reason;
        $state['v']++;
    }

    public static function action(array &$state, int $seat, string $verb, int $value): void
    {
        if ($state['turn'] !== $seat || $state['phase'] === 'ended') {
            throw new PlayError('الان نوبت تو نیست.');
        }
        switch ($state['phase']) {
            case 'cut':
                if ($verb !== 'cut' || !in_array($value, [0, 13, 26, 39], true)) {
                    throw new PlayError('یکی از گزینه‌های کوپ را انتخاب کن.');
                }
                if ($value > 0) {
                    $top = array_splice($state['deck'], 0, $value);
                    array_push($state['deck'], ...$top);
                    $state['cut'] = true;
                }
                self::packets($state, 5);
                $state['phase'] = 'choose';
                $state['turn'] = $state['ruler'];
                break;

            case 'choose':
                if ($verb === 'redeal' && self::canRulerRedeal($state)) {
                    self::newRound($state, 'حاکم با برگ‌های پایین درخواست پخش دوباره کرد.');
                    return;
                }
                if ($verb !== 'trump' || !isset(self::SUITS[$value])) {
                    throw new PlayError('حاکم باید خال حکم را انتخاب کند.');
                }
                $state['trump'] = $value;
                self::packets($state, 4);
                self::packets($state, 4);
                foreach ($state['hands'] as $index => $hand) {
                    if ($index % 2 !== $seat % 2 && !array_filter($hand, static fn(int $card): bool => self::suit($card) === $value)) {
                        self::newRound($state, 'یکی از حریف‌ها خال حکم نداشت. دوباره کارت پخش می‌شود.');
                        return;
                    }
                }
                $state['phase'] = 'play';
                $state['notice'] = null;
                break;

            case 'bam':
                if ($verb !== 'bam' || !in_array($value, [0, 1], true)) {
                    throw new PlayError('کت را ثبت کن یا برای بام ادامه بده.');
                }
                if ($value === 0) {
                    self::roundWin($state, $seat % 2, $seat % 2 === $state['ruler'] % 2 ? 2 : 3);
                    return;
                }
                $state['bam'] = true;
                $state['phase'] = 'play';
                break;

            case 'play':
                if ($verb !== 'card' || !in_array($value, self::legal($state, $seat), true)) {
                    throw new PlayError('این برگ با خال زمینه یا دست فعلی سازگار نیست.');
                }
                $index = array_search($value, $state['hands'][$seat], true);
                array_splice($state['hands'][$seat], $index, 1);
                $state['trick'][] = [$seat, $value];
                $state['turn'] = ($seat + 1) % 4;
                if (count($state['trick']) === 4) {
                    $winner = self::trickWinner($state['trick'], $state['trump']);
                    $team = $winner % 2;
                    $state['lastWinner'] = $winner;
                    $state['trick'] = [];
                    $state['turn'] = $winner;
                    $state['tricks'][$team]++;
                    if ($state['bam'] && $state['tricks'][$team] === 13) {
                        $state['lastRound'] = ['team' => $team, 'points' => 0, 'tricks' => $state['tricks']];
                        self::finish($state, $team, 'bam');
                        return;
                    }
                    if ($state['bam']) {
                        $leader = $state['tricks'][0] >= 7 ? 0 : 1;
                        if ($state['tricks'][1 - $leader] > 0) {
                            self::roundWin($state, $leader, $leader === $state['ruler'] % 2 ? 2 : 3);
                            return;
                        }
                    } elseif ($state['tricks'][$team] === 7) {
                        if ($state['tricks'][1 - $team] === 0) {
                            $state['phase'] = 'bam';
                        } else {
                            self::roundWin($state, $team, 1);
                            return;
                        }
                    }
                }
                break;
        }
        $state['v']++;
    }

    public static function automatic(array &$state, array $players): void
    {
        for ($moves = 0; $moves < 120 && $state['phase'] !== 'ended' && $players[$state['turn']] === null; ++$moves) {
            $seat = $state['turn'];
            [$verb, $value] = match ($state['phase']) {
                'cut' => ['cut', 26],
                'choose' => ['trump', self::suggestTrump($state['hands'][$seat])],
                'bam' => ['bam', 0],
                'play' => ['card', self::suggestCard($state, $seat)],
            };
            self::action($state, $seat, $verb, $value);
        }
    }

    private static function suggestTrump(array $hand): int
    {
        $weights = [0, 0, 0, 0];
        foreach ($hand as $card) {
            $weights[self::suit($card)] += 15 + $card % 13;
        }
        return array_search(max($weights), $weights, true);
    }

    private static function suggestCard(array $state, int $seat): int
    {
        $cards = self::legal($state, $seat);
        usort($cards, static function (int $a, int $b) use ($state): int {
            return [self::suit($a) === $state['trump'], $a % 13] <=> [self::suit($b) === $state['trump'], $b % 13];
        });
        if (!$state['trick']) {
            return $cards[count($cards) - 1];
        }
        $best = self::trickWinner($state['trick'], $state['trump']);
        if ($best % 2 !== $seat % 2) {
            foreach ($cards as $card) {
                if (self::trickWinner([...$state['trick'], [$seat, $card]], $state['trump']) === $seat) {
                    return $card;
                }
            }
        }
        return $cards[0];
    }
}
