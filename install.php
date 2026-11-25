<?php
declare(strict_types=1);

if (PHP_VERSION_ID < 80100 || PHP_INT_SIZE < 8) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    exit('نسخهٔ ۶۴ بیتی PHP حداقل 8.1 لازم است.');
}
require_once __DIR__ . '/app/boot.php';
require_once __DIR__ . '/app/Web.php';
webHeaders();
requireHttps();
webSession();

$installed = config();
if ($installed) {
    webHead('نصب میز حکم');
    echo '<section class="panel narrow"><h2>نصب ثبت شده است</h2><a class="button" href="admin.php">ورود به مدیریت</a></section>';
    webFoot();
    exit;
}
$sqliteVersion = extension_loaded('pdo_sqlite')
    ? ((new PDO('sqlite::memory:'))->query('SELECT sqlite_version()')->fetchColumn() ?: '0')
    : '0';
$requirements = [
    'PHP 8.1+ (64-bit)' => true,
    'PDO_SQLite / SQLite 3.27+' => version_compare($sqliteVersion, '3.27.0', '>='),
    'cURL' => extension_loaded('curl'),
    'OpenSSL' => extension_loaded('openssl'),
];
$error = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        checkCsrf();
        if (in_array(false, $requirements, true)) {
            throw new PlayError('افزونه‌های لازم را در بخش PHP هاست فعال کن.');
        }
        $key = require __DIR__ . '/app/install_key.php';
        if (!hash_equals($key, hash('sha256', strtoupper(trim(posted('setup')))))) {
            usleep(300000);
            throw new PlayError('کد نصب صحیح نیست.');
        }
        $token = trim(posted('token'));
        if (!Telegram::validToken($token)) {
            throw new PlayError('فرمت توکن تلگرام معتبر نیست.');
        }
        $password = posted('password');
        if (strlen($password) < 12 || strlen($password) > 72 || str_contains($password, "\0")) {
            throw new PlayError('رمز مدیر باید ۱۲ تا ۷۲ بایت باشد.');
        }
        $base = baseAddress(posted('base'));
        $api = new Telegram($token);
        $lockFile = __DIR__ . '/app/.install.lock';
        $lock = @fopen($lockFile, 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
            throw new PlayError('نصب دیگری در جریان است یا پوشهٔ app قابل نوشتن نیست.');
        }
        try {
            @chmod($lockFile, 0600);
            if (config()) {
                redirectTo('admin.php');
            }
            $me = $api->call('getMe');
            if (empty($me['is_bot']) || !preg_match('/\A[a-zA-Z0-9_]{5,32}\z/', (string) ($me['username'] ?? ''))) {
                throw new PlayError('اطلاعات این ربات از تلگرام تأیید نشد.');
            }
            $custom = trim(posted('private'));
            $dir = privateFolder($custom ?: configPath());
            if (is_file($dir . '/settings.json')) {
                throw new PlayError('این پوشه به یک نصب موجود تعلق دارد. پوشهٔ دیگری انتخاب کن.');
            }
            $db = new Db($dir, true);
            $existingBot = $db->value("SELECT value FROM settings WHERE key='bot_id'");
            if ($existingBot !== null && $existingBot !== (string) $me['id']) {
                throw new PlayError('این پایگاه داده به یک ربات دیگر تعلق دارد.');
            }
            $db->run("INSERT OR IGNORE INTO settings VALUES('bot_id',?)", (string) $me['id']);
            $db->run('UPDATE settings SET value=? WHERE key=?', posted('store') === '1' ? '1' : '0', 'store_open');
            $db->run('UPDATE settings SET value=? WHERE key=?', posted('rewards') === '1' ? '1' : '0', 'rewards_open');
            $settings = [
                'token' => $token, 'secret' => bin2hex(random_bytes(32)), 'base' => $base,
                'username' => $me['username'], 'admin' => password_hash($password, PASSWORD_DEFAULT),
            ];
            if ($custom !== '') {
                safeWrite(__DIR__ . '/app/location.php', '<?php return ' . var_export($dir, true) . ';');
            }
            safeWrite($dir . '/settings.json', encoded($settings));
            session_regenerate_id(true);
            $_SESSION['admin_at'] = time();
            try {
                $api->webhook($settings);
                $api->shortcuts();
                $_SESSION['flash'] = ['ربات متصل شد و میانبرها ثبت شدند.', true];
            } catch (TelegramFailure $failure) {
                $_SESSION['flash'] = ['نصب محلی انجام شد. در «تنظیمات» اتصال تلگرام را دوباره همگام کن. ' . $failure->getMessage(), false];
            }
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        redirectTo('admin.php');
    } catch (Throwable $failure) {
        $error = webFailure($failure);
    }
}
webHead('نصب مرورگری');
flashBox($error);
?>
<div class="layout">
  <section class="panel">
    <h2>اتصال ربات</h2>
    <form method="post">
      <?= csrf() ?>
      <label>آدرس HTTPS پوشهٔ نصب
        <input type="url" name="base" dir="ltr" required value="<?= escaped(posted('base') ?: baseGuess()) ?>" placeholder="https://example.com/hokm">
      </label>
      <label>کد نصب
        <input type="password" name="setup" dir="ltr" required autocomplete="off">
      </label>
      <label>توکن تازهٔ BotFather
        <input type="password" name="token" dir="ltr" required autocomplete="off">
      </label>
      <label>رمز پنل مدیریت
        <input type="password" name="password" dir="ltr" minlength="12" maxlength="72" required autocomplete="new-password">
      </label>
      <details>
        <summary>مسیر خصوصی و امکانات فروش</summary>
        <label>مسیر داده، خارج از پوشهٔ وب <span class="muted">اختیاری</span>
          <input type="text" name="private" dir="ltr" placeholder="خودکار" value="<?= escaped(posted('private')) ?>">
        </label>
        <label class="check"><input type="checkbox" name="store" value="1" <?= $_SERVER['REQUEST_METHOD'] === 'GET' || posted('store') === '1' ? 'checked' : '' ?>> فروش تم با Telegram Stars</label>
        <label class="check"><input type="checkbox" name="rewards" value="1" <?= $_SERVER['REQUEST_METHOD'] === 'GET' || posted('rewards') === '1' ? 'checked' : '' ?>> نمایش گیفت‌های جدول</label>
      </details>
      <button type="submit" <?= in_array(false, $requirements, true) ? 'disabled' : '' ?>>نصب و اتصال تلگرام</button>
    </form>
  </section>
  <aside class="panel">
    <h2>آمادگی هاست</h2>
    <ul class="requirements">
      <?php foreach ($requirements as $module => $ready): ?>
      <li><b dir="ltr"><?= escaped($module) ?></b><span class="pill <?= $ready ? 'green' : 'red' ?>"><?= $ready ? 'آماده' : 'غیرفعال' ?></span></li>
      <?php endforeach; ?>
    </ul>
    <p class="muted">شناسه‌ها، بازی‌ها و رسیدها در SQLite ساخته می‌شوند. تأیید گیفت از پنل مدیر انجام می‌شود.</p>
  </aside>
</div>
<?php webFoot();
