<?php
declare(strict_types=1);

function webHeaders(): void
{
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    header('X-Robots-Tag: noindex, nofollow');
}

function requireHttps(): void
{
    if (in_array(strtolower((string) ($_SERVER['HTTPS'] ?? '')), ['1','on','true'], true) || (int) ($_SERVER['SERVER_PORT'] ?? 0) === 443) {
        return;
    }
    http_response_code(400);
    webHead('اتصال HTTPS');
    echo '<section class="panel"><h2>با HTTPS وارد شو</h2><p>آدرس این صفحه را با https:// باز کن. اگر HTTPS فعّال است، تنظیم HTTPS در هاست را بررسی کن.</p></section>';
    webFoot();
    exit;
}

function webSession(): void
{
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_name('mizhokm_' . substr(hash('sha256', dirname(__DIR__)), 0, 10));
    session_set_cookie_params([
        'path' => rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\') . '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    if (!session_start()) {
        http_response_code(503);
        webHead('نشست مرورگر');
        echo '<section class="panel"><h2>نشست PHP ایجاد نشد</h2><p>مسیر ذخیرهٔ نشست‌ها باید برای PHP روی هاست قابل‌نوشتن باشد.</p></section>';
        webFoot();
        exit;
    }
    $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
}

function csrf(): string
{
    return '<input type="hidden" name="csrf" value="' . escaped($_SESSION['csrf']) . '">';
}

function posted(string $name): string
{
    return is_string($_POST[$name] ?? null) ? $_POST[$name] : '';
}

function checkCsrf(): void
{
    if (!hash_equals($_SESSION['csrf'], posted('csrf'))) {
        throw new PlayError('مهلت فرم تمام شده. صفحه را دوباره باز کن.');
    }
}

function redirectTo(string $page): never
{
    header('Location: ' . $page, true, 303);
    exit;
}

function webHead(string $name): void
{
    echo '<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<title>' . escaped($name) . ' · میز حکم</title><link rel="stylesheet" href="style.css"></head><body><main class="shell">'
        . '<header class="mast"><div><div class="brand">♠ &nbsp; میز حکم</div><h1>' . escaped($name) . '</h1></div><div class="marks" aria-hidden="true">♠ <span>♥</span> ♣ <span>♦</span></div></header>';
}

function webFoot(): void
{
    echo '</main></body></html>';
}

function flashBox(string $message, bool $ok = false): void
{
    if ($message !== '') {
        echo '<p role="status" class="' . ($ok ? 'notice ok' : 'notice error') . '">' . escaped($message) . '</p>';
    }
}

function baseGuess(): string
{
    $host = $_SERVER['HTTP_HOST'] ?? '';
    if (!preg_match('/\A[A-Za-z0-9.-]+(?::443)?\z/', $host)) {
        return '';
    }
    return 'https://' . $host . rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\');
}

function baseAddress(string $value): string
{
    $value = rtrim(trim($value), '/');
    if (!filter_var($value, FILTER_VALIDATE_URL) || !preg_match('#\Ahttps://[A-Za-z0-9.-]+(?::443)?(?:/[a-zA-Z0-9_~-][a-zA-Z0-9._~-]*)*\z#D', $value)) {
        throw new PlayError('آدرس HTTPS پوشهٔ نصب را کامل و بدون نام فایل وارد کن.');
    }
    return $value;
}

function webFailure(Throwable $error): string
{
    if ($error instanceof PlayError || $error instanceof TelegramFailure) {
        return $error->getMessage();
    }
    error_log('Miz Hokm: ' . get_class($error) . ' (' . $error->getCode() . ')');
    return 'در انجام درخواست خطای هاست رخ داد. نسخهٔ PHP، افزونه‌ها و لاگ خطا را بررسی کن.';
}
