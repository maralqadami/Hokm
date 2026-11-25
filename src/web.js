import { createHmac, scrypt as nodeScrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { equalSecret, escape, fa, nonce, periodNames, periodTitle, shortText, stamp, unixTime } from './core.js';
import { GameError } from './game.js';
import { paymentLabels, Payments, rewardLabels, themes } from './payments.js';
import { Notices, playerName, Tables } from './tables.js';
import { TelegramError, validBotToken } from './telegram.js';
import { Bot } from './bot.js';

const scrypt = promisify(nodeScrypt);
const sessionCookie = 'hokm_admin';
const sessionHours = 12;
const routes = { '/':'home','/install':'install','/admin':'admin','/api/telegram':'telegram' };
const legacy = { '/install.php':'/install','/installer.php':'/install','/admin.php':'/admin' };
const tabs = { overview:'نمای کلی',feedback:'بازخورد',settings:'تنظیمات',payments:'تراکنش‌ها',gifts:'گیفت‌ها' };

class RequestError extends Error {
  constructor(status,message) { super(message); this.status=status; }
}

function headers(res, type) {
  res.setHeader('Content-Type',type);
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Robots-Tag','noindex, nofollow');
}

function respond(res,status,body,type='text/html; charset=utf-8') {
  headers(res,type);
  res.statusCode=status;
  res.end(body);
}

function redirect(res, url, status = 303) {
  res.setHeader('Location',url);
  respond(res,status,'','text/plain; charset=utf-8');
}

function shell(title, body) {
  return '<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>'+escape(title)+
    ' · میز حکم</title><link rel="stylesheet" href="/style.css"></head><body><main class="shell">'+
    '<header class="mast"><div><div class="brand">♠ &nbsp; میز حکم</div><h1>'+escape(title)+
    '</h1></div><div class="marks" aria-hidden="true">♠ <span>♥</span> ♣ <span>♦</span></div></header>'+body+'</main></body></html>';
}

const panel = (title,body) => '<section class="panel"><h2>'+escape(title)+'</h2>'+body+'</section>';
const notice = (message,ok=false) => message ? '<p role="status" class="notice '+(ok?'ok':'error')+'">'+escape(message)+'</p>' : '';
const link = (text,url) => '<a class="button" href="'+escape(url)+'">'+escape(text)+'</a>';
const hmac = (key, data) => createHmac('sha256',key).update(data).digest('hex');

function cookieFrom(req, name) {
  const field = String(req.headers.cookie ?? '').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='));
  return field ? field.slice(name.length+1) : '';
}

function setSession(res, config, seconds = sessionHours*3600) {
  const value = nonce()+'.'+(unixTime()+seconds);
  const signed = seconds ? value+'.'+hmac(config.session,value) : '';
  res.setHeader('Set-Cookie',sessionCookie+'='+signed+'; Path=/; Max-Age='+seconds+'; Secure; HttpOnly; SameSite=Strict');
}

function session(req,config) {
  const value = cookieFrom(req,sessionCookie);
  const match = /^([a-f0-9]{32}\.\d{10,12})\.([a-f0-9]{64})$/.exec(value);
  if (!match || !equalSecret(hmac(config.session,match[1]),match[2])) return '';
  return Number(match[1].split('.')[1]) >= unixTime() ? match[1] : '';
}

async function passwordHash(password) {
  const salt = nonce();
  return salt+'.'+(await scrypt(password,salt,32)).toString('hex');
}

async function matchesPassword(password, record) {
  if (Buffer.byteLength(password)>128) return false;
  const [salt,data] = record.split('.');
  return equalSecret((await scrypt(password,salt,32)).toString('hex'),data);
}

function originFor(req, options) {
  let origin;
  try {
    origin = new URL((options.allowHttp?'http://':'https://') + req.headers.host);
  } catch {
    throw new RequestError(400,'آدرس درخواست معتبر نیست.');
  }
  if (origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) {
    throw new RequestError(400,'آدرس درخواست معتبر نیست.');
  }
  return origin.origin;
}

function correctOrigin(req, origin, production = '') {
  // Vercel may expose the production alias separately from the host used
  // by the function runtime. Accept only the request host or configured
  // production URL, and fall back to Referer when Origin is omitted.
  const allowed = new Set([origin, production].filter(Boolean));
  const originHeader = req.headers.origin;
  if (originHeader) {
    try {
      if (allowed.has(new URL(originHeader).origin)) return;
    } catch {}
    throw new RequestError(403,'فرم را از آدرس اصلی پروژه باز کن.');
  }
  const referer = req.headers.referer;
  if (referer) {
    try {
      if (allowed.has(new URL(referer).origin)) return;
    } catch {}
  }
  throw new RequestError(403,'فرم را از آدرس اصلی پروژه باز کن.');
}

async function rawBody(req, max) {
  if (Number(req.headers['content-length'] ?? 0)>max) throw new RequestError(413,'اندازهٔ درخواست بیش از حد مجاز است.');
  if (req.body !== undefined && req.body !== null) {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    if (data.length>max) throw new RequestError(413,'اندازهٔ درخواست بیش از حد مجاز است.');
    return data.toString('utf8');
  }
  const chunks = [];
  let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if (size>max) throw new RequestError(413,'اندازهٔ درخواست بیش از حد مجاز است.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function form(req) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new RequestError(415,'فرمت فرم پشتیبانی نمی‌شود.');
  }
  if (req.body && typeof req.body==='object' && !Buffer.isBuffer(req.body)) {
    await rawBody(req,8192);
    return new URLSearchParams(Object.entries(req.body).filter(([,value])=>typeof value==='string'));
  }
  return new URLSearchParams(await rawBody(req,8192));
}

async function readConfig(db) {
  if (!db) return null;
  try {
    const data = await db.scalar("SELECT value FROM settings WHERE key='app_config'");
    return data ? JSON.parse(data) : null;
  } catch (error) {
    if (/no such table:\s*(?:main\.)?settings/i.test(String(error.message))) return null;
    throw error;
  }
}

function statusMessage(error) {
  if (error instanceof GameError || error instanceof TelegramError || error instanceof RequestError) return error.message;
  console.error('miz-hokm:',error?.code ?? error?.name ?? 'error');
  return 'ارتباط کامل نشد. اتصال Turso و تنظیمات پروژه را بررسی کن.';
}

function adminForm(action, caption, csrf, id=null, style='quiet') {
  return '<form method="post" class="inline"><input type="hidden" name="csrf" value="'+escape(csrf)+'">'+
    '<input type="hidden" name="action" value="'+escape(action)+'">'+
    (id===null ? '' : '<input type="hidden" name="id" value="'+escape(id)+'">')+
    '<button class="'+style+'" type="submit">'+escape(caption)+'</button></form>';
}

function dataTable(headers, rows, empty) {
  if (!rows.length) return '<p class="muted">'+escape(empty)+'</p>';
  const head = headers.map(label=>'<th>'+escape(label)+'</th>').join('');
  return '<div class="table-wrap"><table><thead><tr>'+head+'</tr></thead><tbody>'+
    rows.map(row=>'<tr>'+row.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
}

export function createApp(options) {
  async function install(req,res,origin) {
    const db = options.database();
    const apiReady = validBotToken(options.botToken());
    const key = options.setupKey();
    const keyReady = Buffer.byteLength(key)>=16 && Buffer.byteLength(key)<=160;
    let databaseReady = false;
    let config = null;
    let message = '';
    let status = 200;
    try {
      if (db) {
        await db.scalar('SELECT 1');
        databaseReady = true;
        config = await readConfig(db);
      }
    } catch (error) {
      databaseReady = false;
      message = statusMessage(error);
    }
    if (config) {
      return respond(res,200,shell('نصب میز حکم',panel('نصب ثبت شده است',link('ورود به مدیریت','/admin'))));
    }
    const production = options.productionUrl();
    if (req.method === 'POST') {
      try {
        correctOrigin(req,origin,options.productionUrl());
        if (production && origin !== production) throw new RequestError(403,'نصب را روی دامنهٔ اصلی '+production+' انجام بده.');
        if (!databaseReady || !apiReady || !keyReady) throw new RequestError(503,'مقادیر لازم را در Vercel تنظیم و دوباره Deploy کن.');
        const fields = await form(req);
        if (!equalSecret(key,fields.get('setup') ?? '')) throw new RequestError(403,'کد نصب صحیح نیست.');
        const password = fields.get('password') ?? '';
        const length = Buffer.byteLength(password);
        if (length<12 || length>128) throw new RequestError(400,'رمز مدیر باید ۱۲ تا ۱۲۸ بایت باشد.');
        const api = options.telegram();
        const me = await api.call('getMe');
        if (!me?.is_bot || !Number.isSafeInteger(me.id) || !/^[a-zA-Z0-9_]{5,32}$/.test(me.username ?? '')) {
          throw new RequestError(400,'اطلاعات ربات از تلگرام تأیید نشد.');
        }
        await db.migrate();
        const data = {base:origin,username:me.username,botId:me.id,webhook:nonce(32),
          session:nonce(32),password:await passwordHash(password)};
        const stored = await db.run("INSERT OR IGNORE INTO settings(key,value) VALUES('app_config',?)",JSON.stringify(data));
        if (!stored) return redirect(res,'/admin');
        setSession(res,data);
        try {
          await api.sync(data,options.starsEnabled());
          return redirect(res,'/admin');
        } catch (error) {
          return respond(res,200,shell('اتصال تلگرام',panel('دیتابیس آماده شد',
            notice(statusMessage(error))+'<p>در پنل مدیر روی «همگام‌سازی اتصال» بزن.</p>'+link('باز کردن پنل','/admin'))));
        }
      } catch (error) {
        status = error.status ?? 500;
        message = statusMessage(error);
      }
    }

    const ready = [['اتصال Turso',databaseReady],['توکن ربات در Vercel',apiReady],['کد نصب در Vercel',keyReady]];
    const checklist = '<ul class="requirements">'+ready.map(([label,on])=>'<li><b>'+escape(label)+
      '</b><span class="pill '+(on?'green':'red')+'">'+(on?'آماده':'تنظیم لازم')+'</span></li>').join('')+'</ul>';
    const fields = '<form method="post"><label>کد نصب<input type="password" name="setup" autocomplete="off" dir="ltr" required></label>'+
      '<label>رمز دلخواه پنل مدیریت<input type="password" name="password" minlength="12" maxlength="128" autocomplete="new-password" dir="ltr" required></label>'+
      '<button type="submit"'+(ready.every(([,ok])=>ok)?'':' disabled')+'>ساخت دیتابیس و اتصال تلگرام</button></form>';
    const body = notice(message)+'<div class="layout">'+panel('اتصال ربات',fields)+panel('آمادگی پروژه',
      checklist+'<p class="muted">کد نصب همان مقدار HOKM_SETUP_KEY در تنظیمات Vercel است.</p>')+'</div>';
    return respond(res,status,shell('نصب مرورگری',body));
  }

  async function login(req,res,url,origin,db,config) {
    let message = '';
    let status = 200;
    if (req.method === 'POST') {
      try {
        correctOrigin(req,origin,options.productionUrl());
        const fields = await form(req);
        if (fields.get('action')!=='login') throw new RequestError(403,'ابتدا وارد پنل شو.');
        const now = unixTime();
        const client = String(req.headers['x-vercel-forwarded-for'] ?? req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'local').slice(0,120);
        const fingerprint = hmac(config.session,client);
        const record = await db.one('INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(fingerprint) DO UPDATE SET '+
          'attempts=CASE WHEN login_attempts.since<? THEN 1 ELSE login_attempts.attempts+1 END, '+
          'since=CASE WHEN login_attempts.since<? THEN excluded.since ELSE login_attempts.since END RETURNING attempts',
          fingerprint,now,now-900,now-900);
        if (record.attempts>8) throw new RequestError(429,'تعداد تلاش‌های ورود زیاد است. ۱۵ دقیقه دیگر امتحان کن.');
        if (!(await matchesPassword(fields.get('password') ?? '',config.password))) throw new RequestError(401,'رمز پنل صحیح نیست.');
        await db.run('DELETE FROM login_attempts WHERE fingerprint=? OR since<?',fingerprint,now-86400);
        setSession(res,config);
        return redirect(res,'/admin');
      } catch (error) {
        status=error.status ?? 500;
        message=statusMessage(error);
      }
    }
    const loginForm='<form action="/admin" method="post"><input type="hidden" name="action" value="login">'+
      '<label>رمز پنل مدیریت<input type="password" name="password" dir="ltr" autocomplete="current-password" required></label>'+
      '<button type="submit">ورود به پنل</button></form>';
    return respond(res,status,shell('ورود مدیر',notice(message)+panel('مدیریت ربات',loginForm)));
  }

  async function admin(req,res,url,origin) {
    const db = options.database();
    const config = await readConfig(db);
    if (!config) return redirect(res,'/install');
    const sessionId = session(req,config);
    if (!sessionId) return login(req,res,url,origin,db,config);
    const csrf = hmac(config.session,'csrf:'+sessionId);
    const stars = options.starsEnabled();
    const api = options.telegram();
    const now = unixTime();
    const payments = new Payments(db,now,stars);
    const bot = new Bot(db,api,config,stars,now);
    const allowed = Object.keys(tabs).filter(tab => stars || !['payments','gifts'].includes(tab));
    const requested = url.searchParams.get('view') ?? 'overview';
    const current = allowed.includes(requested) ? requested : 'overview';
    let banner = '';
    if (req.method==='POST') {
      try {
        correctOrigin(req,origin,options.productionUrl());
        const fields = await form(req);
        if (!equalSecret(csrf,fields.get('csrf'))) throw new RequestError(403,'مهلت فرم تمام شده. صفحه را دوباره باز کن.');
        const action = fields.get('action');
        const id = fields.get('id') ?? '';
        if (action === 'logout') {
          setSession(res,config,0);
          return redirect(res,'/admin');
        }
        if (action === 'backup') {
          const exportData = await db.atomic(async tx => {
            const data={};
            for (const table of ['users','games','seats','results','invoices','charges','rewards','feedback']) data[table]=await tx.all('SELECT * FROM '+table);
            return JSON.stringify({created:new Date().toISOString(),data});
          },'read');
          if (Buffer.byteLength(exportData)>4_000_000) throw new GameError('حجم خروجی بیش از حد دانلود است. از بخش پشتیبان Turso استفاده کن.');
          res.setHeader('Content-Disposition','attachment; filename="miz-hokm-backup.json"');
          return respond(res,200,exportData,'application/json; charset=utf-8');
        }
        if (action === 'sync') {
          const me = await api.call('getMe');
          if (me?.id !== config.botId) throw new GameError('توکن فعلی متعلق به ربات این پروژه نیست.');
          await api.sync(config,stars);
          const info = await api.call('getWebhookInfo');
          if (info?.url !== config.base+'/api/telegram') throw new GameError('آدرس وبهوک تلگرام با آدرس نصب یکسان نیست.');
          banner=notice('اتصال و میانبرها همگام شدند. '+fa(info.pending_update_count ?? 0)+' پیام در انتظار دریافت است.',true);
        } else if (action === 'drain') {
          await db.atomic(tx=>new Tables(tx,now).sweep());
          const clean = await bot.drain();
          banner=notice(clean?'صف پیام‌ها بررسی شد.':'بعضی پیام‌ها هنوز در صف ارسال‌اند.',true);
        } else if (action === 'read') {
          await db.run('UPDATE feedback SET read_at=? WHERE id=?',now,Number(id));
          banner=notice('پیام خوانده شد.',true);
        } else if (action === 'refund' && stars) {
          await payments.refund(api,id);
          await bot.drain(2);
          banner=notice('بازگشت وجه در تلگرام ثبت شد.',true);
        } else if (action === 'gift' && stars) {
          await payments.gift(api,Number(id));
          banner=notice('گیفت ارسال شد.',true);
        } else if (['gift_seen','gift_missing'].includes(action) && stars) {
          const state = action === 'gift_seen' ? 'sent' : 'failed';
          const updated = await db.run("UPDATE rewards SET status=?,updated_at=? WHERE id=? AND (status='review' OR (status='sending' AND updated_at<?))",
            state,now,Number(id),now-120);
          if (!updated) throw new GameError('این گیفت در وضعیت بررسی نیست.');
          banner=notice('نتیجهٔ بررسی گیفت ثبت شد.',true);
        } else if (action === 'switches' && stars) {
          await db.atomic(async tx=>{
            for (const key of ['store_open','rewards_open']) {
              await tx.run('UPDATE settings SET value=? WHERE key=?',fields.get(key)==='1'?'1':'0',key);
            }
          });
          banner=notice('تنظیمات ذخیره شد.',true);
        } else if (action === 'reply' && stars) {
          const reply = shortText(fields.get('reply'),700);
          if (!reply) throw new GameError('متن پاسخ را بنویس.');
          await db.atomic(async tx=>{
            const ticket = await tx.one("SELECT * FROM feedback WHERE id=? AND kind='paysupport' AND answered_at IS NULL",Number(id));
            if (!ticket?.user_id) throw new GameError('درخواست در دسترس نیست یا قبلاً پاسخ گرفته.');
            await tx.run('UPDATE feedback SET reply=?,read_at=?,answered_at=? WHERE id=?',reply,now,now,ticket.id);
            await new Notices(tx,now).text(ticket.user_id,'🧾 پاسخ پشتیبانی · '+fa(id)+'\n\n'+escape(reply));
          });
          await bot.drain(2);
          banner=notice('پاسخ ثبت و برای تلگرام صف شد.',true);
        } else {
          throw new GameError('درخواست پنل معتبر نیست.');
        }
      } catch (error) {
        banner=notice(statusMessage(error));
      }
    }

    const nav = '<nav class="tabs" aria-label="پنل مدیریت">'+allowed.map(tab=>
      '<a href="/admin?view='+tab+'"'+(tab===current?' aria-current="page"':'')+'>'+tabs[tab]+'</a>').join('')+
      adminForm('logout','خروج',csrf)+'</nav>';
    const content = await adminPage(current,{db,config,now,csrf,stars,url});
    return respond(res,200,shell('مدیریت ربات',banner+nav+content));
  }

  async function adminPage(view,{db,config,now,csrf,stars,url}) {
    switch (view) {
      case 'overview': {
        const counts = await db.one("SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM games WHERE status='active') active,"+
          "(SELECT COUNT(DISTINCT game_id) FROM results) played, (SELECT COUNT(*) FROM queue) queued");
        const items = [['بازیکن ثبت‌شده',counts.users],['میز فعال',counts.active],['مسابقه ثبت‌شده',counts.played],['بازیکن در صف',counts.queued]];
        const meters = '<div class="metrics">'+items.map(([label,value])=>'<section class="tile"><span>'+label+
          '</span><strong>'+fa(value)+'</strong></section>').join('')+'</div>';
        return meters+panel('ربات تلگرام','<div class="actions">'+link('باز کردن ربات','https://t.me/'+config.username)+
          adminForm('sync','همگام‌سازی اتصال و میانبرها',csrf)+'</div><p class="muted">برای تست یک‌نفره، /start را بزن و بازی تمرینی را باز کن.</p>');
      }
      case 'feedback': {
        const list = await db.all('SELECT f.*,u.name,u.nickname FROM feedback f LEFT JOIN users u ON u.id=f.user_id ORDER BY f.created_at DESC,f.id DESC LIMIT 90');
        const notes = list.map(ticket=> {
          let action = '';
          if (ticket.reply) action=notice(ticket.reply,true);
          else if (ticket.user_id && stars) {
            action='<form method="post"><input type="hidden" name="csrf" value="'+csrf+
              '"><input type="hidden" name="action" value="reply"><input type="hidden" name="id" value="'+ticket.id+
              '"><label>پاسخ در تلگرام<textarea name="reply" maxlength="700" required></textarea></label><button type="submit">ارسال پاسخ</button></form>';
          } else if (!ticket.read_at) action=adminForm('read','علامت به‌عنوان خوانده‌شده',csrf,ticket.id);
          return '<article class="ticket"><strong>'+escape(ticket.user_id ? 'پرداخت · '+playerName(ticket) : 'بازخورد ناشناس')+
            ' · '+fa(ticket.id)+'</strong><small>'+stamp(ticket.created_at)+'</small><p>'+escape(ticket.message)+'</p>'+action+'</article>';
        });
        return panel('بازخورد و پیگیری',notes.join('') || '<p class="muted">هنوز پیامی ثبت نشده.</p>');
      }
      case 'payments': {
        await new Payments(db,now,stars).expire();
        await db.run("UPDATE charges SET status='refund_review',updated_at=? WHERE status='refunding' AND updated_at<?",now,now-120);
        const charges=await db.all('SELECT c.*,u.name,u.nickname FROM charges c JOIN users u ON u.id=c.user_id ORDER BY c.updated_at DESC LIMIT 100');
        const invoices=await db.all('SELECT i.*,u.name,u.nickname FROM invoices i JOIN users u ON u.id=i.user_id ORDER BY i.created_at DESC LIMIT 100');
        return panel('دریافت و بازگشت وجه',dataTable(['بازیکن','مبلغ','وضعیت','عملیات'],charges.map(row=>[
          escape(playerName(row)),fa(row.total)+' '+escape(row.currency),escape(paymentLabels[row.status]),
          row.currency==='XTR' && ['paid','mismatch','duplicate','refund_review'].includes(row.status)
            ? adminForm('refund','برگرداندن '+fa(row.total)+' ⭐',csrf,row.id,'red-button') : '',
        ]),'هنوز تراکنشی دریافت نشده.'))+
          panel('فاکتورهای اخیر',dataTable(['رسید','بازیکن','تم','وضعیت','زمان'],invoices.map(row=>[
            '<code>'+escape(row.id.slice(0,10))+'</code>',escape(playerName(row)),escape(themes[row.sku]?.name),escape(paymentLabels[row.status]),stamp(row.created_at),
          ]),'هنوز فاکتوری ایجاد نشده.'));
      }
      case 'gifts': {
        await db.atomic(tx=>new Tables(tx,now).prepareGifts());
        const page=Math.max(1,Math.min(10000,Number.parseInt(url.searchParams.get('page') ?? '1',10) || 1));
        const records=await db.all('SELECT a.*,u.name,u.nickname FROM rewards a JOIN users u ON u.id=a.user_id ORDER BY a.period_start DESC,a.period,a.rank LIMIT 31 OFFSET ?',(page-1)*30);
        const nav=(page>1 ? link('صفحهٔ قبل','/admin?view=gifts&page='+(page-1)) : '')+(records.length>30 ? link('صفحهٔ بعد','/admin?view=gifts&page='+(page+1)) : '');
        const open=await db.flag('rewards_open');
        return panel('گیفت‌های رتبه‌بندی','<p class="muted">ارسال هر گیفت، هزینهٔ مشخص‌شده را از موجودی ربات خرج می‌کند.</p>'+
          dataTable(['بازه','رتبه','بازیکن','قیمت','وضعیت','عملیات'],records.slice(0,30).map(row=>{
            let action='';
            if (open && ['pending','failed'].includes(row.status)) action=adminForm('gift','ارسال '+fa(row.cost)+' ⭐',csrf,row.id);
            if (row.status==='review' || row.status==='sending' && row.updated_at<now-120) {
              action=adminForm('gift_seen','تأیید ارسال‌شده',csrf,row.id)+adminForm('gift_missing','تأیید ارسال‌نشده',csrf,row.id);
            }
            return [periodNames[row.period]+' · '+periodTitle(row.period,row.period_start),fa(row.rank),escape(playerName(row)),fa(row.cost)+' ⭐',escape(rewardLabels[row.status]),action];
          }),'هنوز دورهٔ پایان‌یافته با نتیجهٔ رقابتی ثبت نشده.')+'<div class="actions">'+nav+'</div>');
      }
      case 'settings': {
        const pending=await db.scalar('SELECT COUNT(*) FROM outbox WHERE dead_at IS NULL');
        const dead=await db.all('SELECT last_error,dead_at FROM outbox WHERE dead_at IS NOT NULL ORDER BY dead_at DESC LIMIT 5');
        let settings='';
        if (stars) {
          settings=panel('فروشگاه و گیفت','<form method="post"><input type="hidden" name="csrf" value="'+csrf+
            '"><input type="hidden" name="action" value="switches"><label class="check"><input type="checkbox" name="store_open" value="1"'+
            (await db.flag('store_open')?' checked':'')+'> فروش تم با استارز</label>'+
            '<label class="check"><input type="checkbox" name="rewards_open" value="1"'+(await db.flag('rewards_open')?' checked':'')+
            '> نمایش و ارسال گیفت</label><button type="submit">ذخیرهٔ تنظیمات</button></form>');
        }
        return settings+panel('اتصال و داده‌ها','<p>پیام در صف ارسال  <b>'+fa(pending)+'</b></p><div class="actions">'+
          adminForm('sync','همگام‌سازی اتصال',csrf)+adminForm('drain','بررسی صف',csrf)+adminForm('backup','دانلود داده‌ها',csrf)+'</div>'+
          (dead.length?'<details><summary>آخرین خطاهای ارسال</summary>'+dead.map(row=>'<p><code>'+escape(row.last_error)+'</code> · '+stamp(row.dead_at)+'</p>').join('')+'</details>':''));
      }
    }
    return '';
  }

  async function telegram(req,res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow','POST');
      return respond(res,405,'Method not allowed','text/plain; charset=utf-8');
    }
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (typeof secret !== 'string' || !secret) return respond(res,403,'Forbidden','text/plain; charset=utf-8');
    const db=options.database();
    const config=await readConfig(db);
    if (!config || !equalSecret(config.webhook,secret)) return respond(res,403,'Forbidden','text/plain; charset=utf-8');
    let update;
    try {
      update=JSON.parse(await rawBody(req,262144));
    } catch (error) {
      if (error instanceof RequestError) throw error;
      return respond(res,400,'Bad JSON','text/plain; charset=utf-8');
    }
    if (!update || typeof update !== 'object' || Array.isArray(update)) return respond(res,400,'Bad update','text/plain; charset=utf-8');
    const bot=new Bot(db,options.telegram(),config,options.starsEnabled());
    await bot.receive(update);
    const done=await bot.drain();
    return respond(res,done?200:503,done?'OK':'Delivery queued','text/plain; charset=utf-8');
  }

  return async function handler(req,res) {
    let page;
    try {
      const origin=originFor(req,options);
      const url=new URL(req.url,origin);
      if (Object.hasOwn(legacy,url.pathname)) return redirect(res,legacy[url.pathname],302);
      page=Object.hasOwn(routes,url.pathname)?routes[url.pathname]:null;
      if (url.pathname==='/api/hokm') page=url.searchParams.get('page');
      if (page==='telegram') return await telegram(req,res);
      if (!['GET','POST','HEAD'].includes(req.method)) return respond(res,405,'Method not allowed','text/plain; charset=utf-8');
      if (page==='install') return await install(req,res,origin);
      if (page==='admin') return await admin(req,res,url,origin);
      if (page==='home') return redirect(res,'/admin',302);
      return respond(res,404,shell('صفحه در دسترس نیست',panel('میز حکم',link('باز کردن نصب‌گر','/install'))));
    } catch (error) {
      const status=error.status ?? 503;
      const message=statusMessage(error);
      if (page==='telegram') return respond(res,status,status===503?'Temporarily unavailable':message,'text/plain; charset=utf-8');
      return respond(res,status,shell('میز حکم',panel('خطای ارتباط',notice(message)+link('باز کردن نصب‌گر','/install'))));
    }
  };
}
