<?php
declare(strict_types=1);

function encoded(mixed $value): string
{
    return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function escaped(mixed $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function fa(mixed $value): string
{
    return strtr((string) $value, ['0'=>'۰','1'=>'۱','2'=>'۲','3'=>'۳','4'=>'۴','5'=>'۵','6'=>'۶','7'=>'۷','8'=>'۸','9'=>'۹']);
}

function latin(string $value): string
{
    return strtr($value, array_combine(preg_split('//u', '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', -1, PREG_SPLIT_NO_EMPTY), str_split('01234567890123456789')));
}

function shortText(string $value, int $max): string
{
    $value = trim((string) preg_replace('/[\p{Cc}\x{202a}-\x{202e}\x{2066}-\x{2069}]+/u', ' ', $value));
    preg_match('/\A.{0,' . $max . '}/us', $value, $parts);
    return $parts[0] ?? '';
}

function configPath(): string
{
    $custom = __DIR__ . '/location.php';
    if (is_file($custom)) {
        return require $custom;
    }
    $root = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
    if (!$root) {
        throw new RuntimeException('مسیر ریشه وب مشخص نیست.');
    }
    $siteRoot = webTreeRoot($root);
    return dirname($siteRoot) . '/.miz-hokm-' . substr(hash('sha256', dirname(__DIR__)), 0, 14);
}

function config(): ?array
{
    $path = configPath() . '/settings.json';
    return is_file($path) ? json_decode(file_get_contents($path), true, 32, JSON_THROW_ON_ERROR) : null;
}

function webTreeRoot(string $root): string
{
    $top = $root;
    for ($path = $root; $path !== dirname($path); $path = dirname($path)) {
        if (in_array(strtolower(basename($path)), ['public_html','www','htdocs','httpdocs','wwwroot'], true)) {
            $top = $path;
        }
    }
    return $top;
}

function privateFolder(string $folder): string
{
    $root = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
    if (!$root || !str_starts_with($folder, '/') || preg_match('~(?:^|/)\.{1,2}(?:/|$)|[\p{Cc}]~u', $folder)) {
        throw new PlayError('مسیر پوشهٔ خصوصی معتبر نیست.');
    }
    $parent = realpath(dirname(rtrim($folder, '/')));
    if (!$parent) {
        throw new PlayError('پوشهٔ مادر مسیر خصوصی روی هاست پیدا نشد.');
    }
    $folder = $parent . '/' . basename($folder);
    $resolved = realpath($folder) ?: $folder;
    $top = webTreeRoot($root);
    if ($resolved === $top || str_starts_with($resolved, rtrim($top, '/') . '/') || str_starts_with($top, rtrim($resolved, '/') . '/') || is_link($folder)) {
        throw new PlayError('پوشهٔ داده باید بیرون از ریشهٔ عمومی وب باشد.');
    }
    if (!is_dir($folder) && !@mkdir($folder, 0700)) {
        throw new PlayError('هاست اجازهٔ ساخت پوشهٔ خصوصی را نداد. مسیر یک پوشهٔ قابل‌نوشتن بیرون از ریشهٔ وب را وارد کن.');
    }
    if (!is_writable($folder) || !@chmod($folder, 0700)) {
        throw new PlayError('هاست اجازهٔ نوشتن با دسترسی خصوصی را به PHP نداد.');
    }
    return $folder;
}

function safeWrite(string $path, string $contents): void
{
    $temp = tempnam(dirname($path), '.save-');
    if (!$temp) {
        throw new RuntimeException('ذخیرهٔ فایل تنظیمات ممکن نشد.');
    }
    try {
        if (!chmod($temp, 0600) || file_put_contents($temp, $contents) !== strlen($contents) || !rename($temp, $path)) {
            throw new RuntimeException('ذخیرهٔ فایل تنظیمات ممکن نشد.');
        }
    } finally {
        if (is_file($temp)) {
            @unlink($temp);
        }
    }
}

final class Period
{
    private const MONTHS = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
    public const TYPES = ['day' => 'روزانه', 'week' => 'هفتگی', 'month' => 'ماهانه'];

    public static function local(int $time): DateTimeImmutable
    {
        return (new DateTimeImmutable('@' . $time))->setTimezone(new DateTimeZone('Asia/Tehran'));
    }

    // Gregorian to Solar Hijri for contemporary dates.
    public static function persian(DateTimeImmutable $date): array
    {
        $year = (int) $date->format('Y') - 1600;
        $month = (int) $date->format('n');
        $leapYear = $year + (int) ($month > 2);
        $monthOffsets = [0,31,59,90,120,151,181,212,243,273,304,334];
        $days = 365 * $year + intdiv($leapYear + 3, 4) - intdiv($leapYear + 99, 100)
            + intdiv($leapYear + 399, 400) - 80 + (int) $date->format('j') + $monthOffsets[$month - 1];
        $persianYear = 979 + 33 * intdiv($days, 12053);
        $days %= 12053;
        $persianYear += 4 * intdiv($days, 1461);
        $days %= 1461;
        if ($days > 365) {
            $persianYear += intdiv($days - 1, 365);
            $days = ($days - 1) % 365;
        }
        if ($days < 186) {
            return [$persianYear, 1 + intdiv($days, 31), 1 + $days % 31];
        }
        return [$persianYear, 7 + intdiv($days - 186, 30), 1 + ($days - 186) % 30];
    }

    public static function key(string $type, int $time): int
    {
        $day = self::local($time)->setTime(0, 0);
        $offset = match ($type) {
            'day' => 0,
            'week' => ((int) $day->format('w') + 1) % 7,
            'month' => self::persian($day)[2] - 1,
        };
        return $day->modify('-' . $offset . ' days')->getTimestamp();
    }

    public static function title(string $type, int $time): string
    {
        [$year, $month, $day] = self::persian(self::local($time));
        $label = self::MONTHS[$month - 1] . ' ' . fa($year);
        return match ($type) {
            'month' => $label,
            'week' => 'هفتهٔ ' . fa($day) . ' ' . $label,
            'day' => fa($day) . ' ' . $label,
        };
    }

    public static function stamp(int $time): string
    {
        return self::title('day', $time) . '، ' . fa(self::local($time)->format('H:i'));
    }
}
