<?php
declare(strict_types=1);

require_once __DIR__ . '/app/boot.php';
require_once __DIR__ . '/app/Web.php';
webHeaders();
requireHttps();
$settings = config();
if (!$settings) {
    redirectTo('install.php');
}
webSession();
$db = new Db(configPath());
$api = new Telegram($settings['token']);
$now = time();
$error = '';
$authorized = isset($_SESSION['admin_at']) && $now - $_SESSION['admin_at'] < 43200;
if (!$authorized) {
    unset($_SESSION['admin_at']);
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && posted('action') === 'login') {
        try {
            checkCsrf();
            $fingerprint = hash_hmac('sha256', (string) ($_SERVER['REMOTE_ADDR'] ?? 'local'), $settings['secret']);
            $allowed = $db->write(function () use ($db, $fingerprint, $now): bool {
                $db->run('DELETE FROM login_attempts WHERE since<?', $now - 900);
                $tries = (int) $db->value('SELECT attempts FROM login_attempts WHERE fingerprint=?', $fingerprint);
                if ($tries >= 8) {
                    return false;
                }
                $db->run('INSERT INTO login_attempts VALUES(?,1,?)
                    ON CONFLICT(fingerprint) DO UPDATE SET attempts=login_attempts.attempts+1', $fingerprint, $now);
                return true;
            });
            if (!$allowed) {
                http_response_code(429);
                throw new PlayError('تلاش‌های ورود زیاد بوده. ۱۵ دقیقه دیگر امتحان کن.');
            }
            if (!password_verify(posted('password'), $settings['admin'])) {
                throw new PlayError('رمز پنل صحیح نیست.');
            }
            $db->run('DELETE FROM login_attempts WHERE fingerprint=?', $fingerprint);
            session_regenerate_id(true);
            $_SESSION['admin_at'] = $now;
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
            redirectTo('admin.php');
        } catch (Throwable $failure) {
            $error = webFailure($failure);
        }
    }
    webHead('ورود مدیر');
    flashBox($error);
    ?>
    <section class="panel narrow">
      <form method="post">
        <?= csrf() ?>
        <input type="hidden" name="action" value="login">
        <label>رمز پنل مدیریت
          <input type="password" name="password" dir="ltr" autocomplete="current-password" required>
        </label>
        <button type="submit">ورود به پنل</button>
      </form>
    </section>
    <?php
    webFoot();
    exit;
}

$_SESSION['admin_at'] = $now;
$tabs = ['overview' => 'نمای کلی', 'payments' => 'تراکنش‌ها', 'gifts' => 'گیفت‌ها', 'feedback' => 'پشتیبانی', 'settings' => 'تنظیمات'];
$view = $_GET['view'] ?? 'overview';
$view = is_string($view) && isset($tabs[$view]) ? $view : 'overview';
$page = max(1, min(100000, (int) (is_string($_GET['page'] ?? null) ? $_GET['page'] : 1)));
$flash = $_SESSION['flash'] ?? null;
unset($_SESSION['flash']);
$bot = new Bot($db, $api, $settings);
$tables = new Tables($db, $now);
$payments = new Payments($db, $now);
$assets = new Notices($db, $now);

function adminPost(string $action, string $caption, mixed $id = null, string $style = 'quiet'): string
{
    return '<form class="inline" method="post">' . csrf() . '<input type="hidden" name="action" value="' . escaped($action) . '">'
        . ($id === null ? '' : '<input type="hidden" name="id" value="' . escaped($id) . '">')
        . '<button class="' . escaped($style) . '" type="submit">' . escaped($caption) . '</button></form>';
}

function backupDb(Db $db): never
{
    $temp = tempnam(configPath(), '.backup-');
    if (!$temp) {
        throw new PlayError('ساخت فایل پشتیبان روی هاست ممکن نشد.');
    }
    try {
        $db->pdo->exec('VACUUM INTO ' . $db->pdo->quote($temp));
        clearstatcache(true, $temp);
        header('Content-Type: application/octet-stream');
        header('Content-Disposition: attachment; filename="miz-hokm-' . Period::local(time())->format('Y-m-d') . '.sqlite3"');
        header('Content-Length: ' . filesize($temp));
        readfile($temp);
    } finally {
        @unlink($temp);
    }
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        checkCsrf();
        $id = posted('id');
        $action = posted('action');
        $success = match ($action) {
            'sync' => (function () use ($api, $settings): string {
                $api->webhook($settings);
                $api->shortcuts();
                $info = $api->call('getWebhookInfo');
                if (($info['url'] ?? '') !== $settings['base'] . '/webhook.php') {
                    throw new PlayError('آدرس ثبت‌شدهٔ وبهوک با تنظیمات یکی نیست.');
                }
                return 'وبهوک و میانبرها همگام شدند. ' . fa($info['pending_update_count'] ?? 0) . ' پیام در انتظار دریافت است.';
            })(),
            'switches' => (function () use ($db): string {
                $db->write(function () use ($db): void {
                    foreach (['store_open','rewards_open'] as $key) {
                        $db->run('UPDATE settings SET value=? WHERE key=?', posted($key) === '1' ? '1' : '0', $key);
                    }
                });
                return 'تنظیمات ذخیره شد.';
            })(),
            'backup' => backupDb($db),
            'refund' => (function () use ($payments, $api, $bot, $id): string {
                $payments->refund($api, $id);
                $bot->drain(2.0);
                return 'بازگشت وجه در تلگرام تأیید و ثبت شد.';
            })(),
            'gift' => (function () use ($db, $api, $id, $now): string {
                Gifts::send($db, $api, (int) $id, $now);
                return 'گیفت ارسال شد.';
            })(),
            'gift_seen', 'gift_missing' => (function () use ($db, $action, $id, $now): string {
                $next = $action === 'gift_seen' ? 'sent' : 'failed';
                if (!$db->run("UPDATE rewards SET status=?,updated_at=? WHERE id=? AND (status='review' OR (status='sending' AND updated_at<?))",
                    $next, $now, (int) $id, $now - 120
                )) {
                    throw new PlayError('این گیفت در وضعیت بررسی نیست.');
                }
                return 'نتیجهٔ بررسی گیفت ثبت شد.';
            })(),
            'read' => (function () use ($db, $id, $now): string {
                $db->run('UPDATE feedback SET read_at=? WHERE id=?', $now, (int) $id);
                return 'پیام خوانده شد.';
            })(),
            'reply' => (function () use ($db, $id, $now, $assets, $bot): string {
                $reply = shortText(posted('reply'), 700);
                if ($reply === '') {
                    throw new PlayError('متن پاسخ را بنویس.');
                }
                $db->write(function () use ($db, $id, $now, $assets, $reply): void {
                    $ticket = $db->one("SELECT * FROM feedback WHERE id=? AND kind='paysupport' AND answered_at IS NULL", (int) $id);
                    if (!$ticket || !$ticket['user_id']) {
                        throw new PlayError('این درخواست قبلاً پاسخ گرفته یا در دسترس نیست.');
                    }
                    $db->run('UPDATE feedback SET reply=?,read_at=?,answered_at=? WHERE id=?', $reply, $now, $now, (int) $id);
                    $assets->text($ticket['user_id'], '🧾 پاسخ پشتیبانی · ' . fa($id) . "\n\n" . escaped($reply));
                });
                $delivered = $bot->drain(2.0);
                return $delivered ? 'پاسخ ثبت و به صف تلگرام ارسال شد.' : 'پاسخ ثبت شد و در صف ارسال است.';
            })(),
            'drain' => $bot->drain() ? 'صف پیام‌های آماده بررسی شد.' : 'بعضی پیام‌ها در انتظار ارسال‌اند.',
            'logout' => (function (): never {
                $_SESSION = [];
                session_destroy();
                redirectTo('admin.php');
            })(),
            default => throw new PlayError('درخواست پنل معتبر نیست.'),
        };
        $_SESSION['flash'] = [$success, true];
        redirectTo('admin.php?view=' . rawurlencode($view) . ($page > 1 ? '&page=' . $page : ''));
    } catch (Throwable $failure) {
        $error = webFailure($failure);
    }
}

$db->write(function () use ($tables, $payments, $db, $now, $view): void {
    $tables->sweep();
    $payments->expire();
    $db->run("UPDATE charges SET status='refund_review',updated_at=? WHERE status='refunding' AND updated_at<?", $now, $now - 120);
    if ($view === 'gifts') {
        $tables->prepareRewards();
    }
});

webHead('مدیریت ربات');
if ($flash) {
    flashBox($flash[0], $flash[1]);
}
flashBox($error);
?>
<nav class="tabs" aria-label="پنل مدیریت">
  <?php foreach ($tabs as $tab => $title): ?>
    <a href="?view=<?= escaped($tab) ?>" <?= $view === $tab ? 'aria-current="page"' : '' ?>><?= escaped($title) ?></a>
  <?php endforeach; ?>
  <?= adminPost('logout', 'خروج') ?>
</nav>
<?php if ($view === 'overview'):
    $metrics = [
        'بازیکن ثبت‌شده' => $db->value('SELECT COUNT(*) FROM users'),
        'میز فعال' => $db->value("SELECT COUNT(*) FROM games WHERE status='active'"),
        'مسابقه ثبت‌شده' => $db->value("SELECT COUNT(DISTINCT game_id) FROM results"),
        'خرید تم · استارز' => $db->value("SELECT COALESCE(SUM(stars),0) FROM invoices WHERE status='paid'"),
    ];
    ?>
    <div class="metrics">
      <?php foreach ($metrics as $label => $value): ?>
        <section class="tile"><span><?= escaped($label) ?></span><strong><?= fa($value) ?></strong></section>
      <?php endforeach; ?>
    </div>
    <section class="panel">
      <h2>ربات تلگرام</h2>
      <div class="actions">
        <a class="button" href="https://t.me/<?= escaped($settings['username']) ?>" rel="noopener noreferrer">باز کردن ربات</a>
        <?= adminPost('sync', 'همگام‌سازی اتصال و میانبرها') ?>
      </div>
      <p class="muted">برای شروع با یک حساب /start را بزن و میز تمرینی را باز کن. میز رقابتی با چهار حساب شروع می‌شود.</p>
    </section>
<?php elseif ($view === 'payments'):
    $charges = $db->all('SELECT c.*,i.sku,u.name,u.nickname FROM charges c LEFT JOIN invoices i ON i.id=c.invoice_id
        JOIN users u ON u.id=c.user_id ORDER BY c.updated_at DESC LIMIT 100');
    $invoices = $db->all('SELECT i.*,u.name,u.nickname FROM invoices i JOIN users u ON u.id=i.user_id ORDER BY i.created_at DESC LIMIT 100');
    ?>
    <section class="panel">
      <h2>دریافت‌ها و بازگشت وجه</h2>
      <?php if (!$charges): ?><p class="muted">هنوز تراکنشی از تلگرام دریافت نشده.</p><?php else: ?>
      <div class="table-wrap"><table><thead><tr><th>بازیکن</th><th>مبلغ</th><th>شناسهٔ تلگرام</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>
      <?php foreach ($charges as $charge): ?>
        <tr>
          <td><?= escaped(Screens::player($charge)) ?></td><td><?= fa($charge['total']) ?> <?= escaped($charge['currency']) ?></td>
          <td><code title="<?= escaped($charge['id']) ?>"><?= escaped(shortText($charge['id'], 24)) ?></code></td>
          <td><?= escaped(Payments::STATUS[$charge['status']] ?? $charge['status']) ?></td>
          <td><?php if ($charge['currency'] === 'XTR' && in_array($charge['status'], ['paid','duplicate','mismatch','refund_review'], true)): ?>
            <?= adminPost('refund', 'برگرداندن ' . fa($charge['total']) . ' ⭐', $charge['id'], 'red-button') ?>
          <?php endif; ?></td>
        </tr>
      <?php endforeach; ?>
      </tbody></table></div><?php endif; ?>
    </section>
    <section class="panel">
      <h2>فاکتورهای اخیر</h2>
      <?php if (!$invoices): ?><p class="muted">هنوز فاکتوری ایجاد نشده.</p><?php else: ?>
      <div class="table-wrap"><table><thead><tr><th>رسید</th><th>بازیکن</th><th>تم</th><th>مبلغ</th><th>وضعیت</th><th>زمان</th></tr></thead><tbody>
      <?php foreach ($invoices as $invoice): ?>
        <tr><td><code><?= escaped(substr($invoice['id'], 0, 10)) ?></code></td><td><?= escaped(Screens::player($invoice)) ?></td><td><?= escaped(Payments::THEMES[$invoice['sku']]['name']) ?></td><td><?= fa($invoice['stars']) ?> ⭐</td><td><?= escaped(Payments::STATUS[$invoice['status']] ?? $invoice['status']) ?></td><td><?= Period::stamp($invoice['created_at']) ?></td></tr>
      <?php endforeach; ?>
      </tbody></table></div><?php endif; ?>
    </section>
<?php elseif ($view === 'gifts'):
    $rewards = $db->all('SELECT r.*,u.name,u.nickname FROM rewards r JOIN users u ON u.id=r.user_id
        ORDER BY r.period_start DESC,r.period,r.rank LIMIT 31 OFFSET ?', ($page - 1) * 30);
    $nextPage = count($rewards) > 30;
    $rewards = array_slice($rewards, 0, 30);
    $open = $db->flag('rewards_open');
    ?>
    <section class="panel">
      <h2>گیفت‌های رتبه‌بندی</h2>
      <p class="muted">جایگاه ۱، ۲ و ۳ به‌ترتیب گیفت ۵۰، ۲۵ و ۱۵ استارزی دریافت می‌کنند. دکمهٔ ارسال همان مبلغ را از موجودی ربات خرج می‌کند. نتایج از بازه‌های بسته‌شده می‌آیند.</p>
      <?php if (!$open): ?><p class="notice">ارسال گیفت از تنظیمات غیرفعال است.</p><?php endif; ?>
      <?php if (!$rewards): ?><p class="muted">هنوز دورهٔ پایان‌یافته با نتیجهٔ رقابتی ثبت نشده.</p><?php else: ?>
      <div class="table-wrap"><table><thead><tr><th>بازه</th><th>رتبه</th><th>بازیکن</th><th>گیفت</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>
        <?php foreach ($rewards as $award): ?>
        <tr>
          <td><?= Period::TYPES[$award['period']] ?> · <?= Period::title($award['period'], $award['period_start']) ?></td>
          <td><?= fa($award['rank']) ?></td><td><?= escaped(Screens::player($award)) ?></td><td><?= fa($award['cost']) ?> ⭐</td>
          <td><?= Gifts::STATUS[$award['status']] ?></td>
          <td><?php if ($open && in_array($award['status'], ['pending','failed'], true)):
                echo adminPost('gift', 'ارسال گیفت ' . fa($award['cost']) . ' ⭐', $award['id']);
              elseif ($award['status'] === 'review' || ($award['status'] === 'sending' && $award['updated_at'] < $now - 120)):
                echo adminPost('gift_seen', 'تأیید ارسال‌شده', $award['id']);
                echo adminPost('gift_missing', 'تأیید ارسال‌نشده', $award['id']);
              endif; ?></td>
        </tr>
        <?php endforeach; ?>
      </tbody></table></div><?php endif; ?>
      <div class="actions">
        <?php if ($page > 1): ?><a class="button" href="?view=gifts&amp;page=<?= $page - 1 ?>">صفحهٔ قبل</a><?php endif; ?>
        <?php if ($nextPage): ?><a class="button" href="?view=gifts&amp;page=<?= $page + 1 ?>">صفحهٔ بعد</a><?php endif; ?>
      </div>
    </section>
<?php elseif ($view === 'feedback'):
    $tickets = $db->all('SELECT f.*,u.name,u.nickname FROM feedback f LEFT JOIN users u ON u.id=f.user_id ORDER BY f.created_at DESC,f.id DESC LIMIT 90');
    ?>
    <section class="panel">
      <h2>بازخورد و پیگیری خرید</h2>
      <?php if (!$tickets): ?><p class="muted">هنوز پیامی ثبت نشده.</p><?php endif; ?>
      <?php foreach ($tickets as $ticket): ?>
        <article class="ticket">
          <strong><?= $ticket['user_id'] ? 'پرداخت · ' . escaped(Screens::player($ticket)) : 'بازخورد ناشناس' ?> · <?= fa($ticket['id']) ?></strong>
          <small><?= Period::stamp($ticket['created_at']) ?></small>
          <p><?= escaped($ticket['message']) ?></p>
          <?php if ($ticket['reply'] !== null): ?>
            <p class="notice ok"><?= escaped($ticket['reply']) ?></p>
          <?php elseif ($ticket['user_id']): ?>
            <form method="post" class="reply">
              <?= csrf() ?><input type="hidden" name="action" value="reply"><input type="hidden" name="id" value="<?= $ticket['id'] ?>">
              <label>پاسخ در تلگرام<textarea name="reply" maxlength="700" required></textarea></label><button class="quiet" type="submit">ارسال پاسخ</button>
            </form>
          <?php elseif (!$ticket['read_at']): ?>
            <?= adminPost('read', 'علامت به‌عنوان خوانده‌شده', $ticket['id']) ?>
          <?php endif; ?>
        </article>
      <?php endforeach; ?>
    </section>
<?php elseif ($view === 'settings'):
    $pending = $db->value('SELECT COUNT(*) FROM outbox WHERE dead_at IS NULL');
    $dead = $db->all('SELECT kind,last_error,dead_at FROM outbox WHERE dead_at IS NOT NULL ORDER BY dead_at DESC LIMIT 8');
    ?>
    <div class="layout">
      <section class="panel">
        <h2>فروشگاه و گیفت</h2>
        <form method="post">
          <?= csrf() ?><input type="hidden" name="action" value="switches">
          <label class="check"><input type="checkbox" name="store_open" value="1" <?= $db->flag('store_open') ? 'checked' : '' ?>> فروش تم با استارز</label>
          <label class="check"><input type="checkbox" name="rewards_open" value="1" <?= $db->flag('rewards_open') ? 'checked' : '' ?>> نمایش و ارسال گیفت‌های جدول</label>
          <button type="submit">ذخیرهٔ تنظیمات</button>
        </form>
      </section>
      <section class="panel">
        <h2>اتصال و نسخهٔ پشتیبان</h2>
        <p>پیام در صف ارسال  <b><?= fa($pending) ?></b></p>
        <div class="actions"><?= adminPost('sync', 'همگام‌سازی اتصال') ?> <?= adminPost('drain', 'بررسی صف') ?> <?= adminPost('backup', 'دانلود نسخهٔ SQLite') ?></div>
        <?php if ($dead): ?>
          <details><summary>آخرین خطاهای ارسال</summary>
          <?php foreach ($dead as $log): ?><p><code><?= escaped($log['last_error']) ?></code> · <?= Period::stamp($log['dead_at']) ?></p><?php endforeach; ?>
          </details>
        <?php endif; ?>
      </section>
    </div>
<?php endif;
webFoot();
