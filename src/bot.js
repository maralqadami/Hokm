import { escape, fa, latin, shortText, unixTime } from './core.js';
import { GameError } from './game.js';
import { Payments } from './payments.js';
import { Notices, playerName, Tables } from './tables.js';
import { TelegramError } from './telegram.js';
import { button, home, Views } from './views.js';

const validUserId = id => Number.isSafeInteger(id) && id > 0;

export class Bot {
  constructor(db, api, config, starsEnabled, now = unixTime()) {
    Object.assign(this,{db,api,config,starsEnabled,now});
  }

  context(db = this.db) {
    const tables = new Tables(db,this.now);
    const payments = new Payments(db,this.now,this.starsEnabled);
    const notices = new Notices(db,this.now);
    const views = new Views({db,tables,payments,config:this.config,now:this.now});
    return {db,tables,payments,notices,views};
  }

  async receive(update) {
    if (!Number.isSafeInteger(update?.update_id)) return;
    const id = update.update_id;
    const result = await this.db.atomic(async db => {
      const saved = await db.one('SELECT answer FROM updates WHERE id=?',id);
      if (saved) return saved.answer ? JSON.parse(saved.answer) : null;
      const ack = await this.route(this.context(db),update);
      await db.run('INSERT INTO updates VALUES(?,?,?)',id,this.now,ack ? JSON.stringify(ack) : null);
      if (id % 211 === 0) {
        await db.run('DELETE FROM updates WHERE created_at<?',this.now-7*86400);
        await db.run('DELETE FROM outbox WHERE dead_at<?',this.now-14*86400);
      }
      return ack;
    });
    if (!result) return;
    const [method,data] = result;
    try {
      await this.api.call(method,data,method === 'answerPreCheckoutQuery' ? 4600 : 1800);
    } catch (error) {
      if (!(error instanceof TelegramError) || method === 'answerPreCheckoutQuery' && (error.uncertain || error.code === 429)) throw error;
    }
  }

  async user(db, from) {
    const id = from?.id;
    if (!validUserId(id) || from.is_bot) return null;
    const name = shortText([from.first_name,from.last_name].filter(Boolean).join(' '),44) || 'بازیکن';
    const username = shortText(from.username,32) || null;
    await db.run('INSERT INTO users(id,name,telegram_username,active_at,created_at) VALUES(?,?,?,?,?) '+
      'ON CONFLICT(id) DO UPDATE SET name=excluded.name,telegram_username=excluded.telegram_username,active_at=excluded.active_at',
      id,name,username,this.now,this.now);
    return db.one('SELECT * FROM users WHERE id=?',id);
  }

  async route(ctx, update) {
    const { db,tables,payments,notices } = ctx;
    if (update.pre_checkout_query) {
      const query = update.pre_checkout_query;
      if (typeof query.id !== 'string') return null;
      if (!this.starsEnabled) {
        return ['answerPreCheckoutQuery',{pre_checkout_query_id:query.id,ok:false,error_message:'فروش در این نسخه فعال نیست.'}];
      }
      const user = await this.user(db,query.from);
      return user ? ['answerPreCheckoutQuery',await payments.checkout(user.id,query)] : null;
    }
    const callback = update.callback_query;
    const message = update.message ?? callback?.message;
    if (message?.chat?.type !== 'private') return null;
    const id = message.chat.id;
    if (!callback && (message.refunded_payment || message.successful_payment)) {
      if (!validUserId(id)) return null;
      if (!(await db.scalar('SELECT 1 FROM users WHERE id=?',id)) && message.from?.id === id) await this.user(db,message.from);
      if (await db.scalar('SELECT 1 FROM users WHERE id=?',id)) {
        if (message.refunded_payment) await payments.onRefund(id,message.refunded_payment);
        else await payments.paid(id,message.successful_payment);
      }
      return null;
    }
    const from = callback?.from ?? message.from;
    if (from?.id !== id) return null;
    const user = await this.user(db,from);
    if (!user) return null;
    await tables.sweep();
    if (callback) {
      const ack = { callback_query_id:callback.id };
      try {
        await this.action(ctx,user,String(callback.data ?? ''));
      } catch (error) {
        if (!(error instanceof GameError)) throw error;
        ack.text = error.message;
        ack.show_alert = true;
      }
      return ['answerCallbackQuery',ack];
    }
    try {
      await this.message(ctx,user,String(message.text ?? '').trim());
    } catch (error) {
      if (!(error instanceof GameError)) throw error;
      await notices.text(id,escape(error.message),[[home()]]);
    }
    return null;
  }

  async show(notices, user, view) {
    const [html,buttons] = await view;
    await notices.text(user,html,buttons);
  }

  async message(ctx, user, text) {
    const { db,tables,notices,views } = ctx;
    const id = user.id;
    const command = /^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text);
    if (command) {
      const args = (command[2] ?? '').trim();
      const join = /^j_([a-f0-9]{12})$/.exec(args);
      if (command[1] === 'start' && join) {
        await tables.joinRoom(id,join[1]);
        return;
      }
      if (command[1] === 'invite' && args) {
        await this.search(ctx,user,args);
        return;
      }
      const redirects = {
        start:args === 'hokm-store' ? 'store' : 'home',menu:'home',
        rank:'board:day:0',rules:'help',invite:'search',
      };
      const name = Object.hasOwn(redirects,command[1]) ? redirects[command[1]] : command[1];
      await this.action(ctx,user,name);
      return;
    }
    if (!text) {
      await notices.text(id,'برای ادامه یکی از دکمه‌ها را بزن یا /start را بفرست.');
      return;
    }

    if (user.prompt?.startsWith('edit:')) {
      const field = user.prompt.slice(5);
      const limits = { nickname:32,alias:24,bio:110 };
      if (!Object.hasOwn(limits,field)) return;
      const limit = limits[field];
      let value = text === 'پاک' ? '' : shortText(text,limit+1);
      if (field === 'alias' && value) {
        value = latin(value).replace(/^@/,'').toLowerCase();
        if (!/^[a-z][a-z0-9_]{2,23}$/.test(value)) throw new GameError('نام کاربری باید ۳ تا ۲۴ حرف انگلیسی، عدد یا زیرخط باشد و با حرف شروع شود.');
        if (await db.scalar('SELECT 1 FROM users WHERE alias=? AND id<>?',value,id)) throw new GameError('این نام کاربری گرفته شده.');
      }
      if ([...value].length > limit) throw new GameError('حداکثر '+fa(limit)+' نویسه بنویس.');
      await db.run('UPDATE users SET '+field+'=?,prompt=NULL WHERE id=?',value || (field === 'bio' ? '' : null),id);
      await this.show(notices,id,views.profile(await db.one('SELECT * FROM users WHERE id=?',id)));
      return;
    }

    switch (user.prompt) {
      case 'search':
        await this.search(ctx,user,text);
        break;
      case 'feedback':
      case 'paysupport': {
        const content = shortText(text,700);
        if ([...content].length < 4) throw new GameError('چند کلمه بیشتر دربارهٔ موضوع بنویس.');
        const billing = user.prompt === 'paysupport';
        const row = await db.one('INSERT INTO feedback(user_id,kind,message,created_at) VALUES(?,?,?,?) RETURNING id',billing ? id : null,user.prompt,content,this.now);
        await db.run('UPDATE users SET prompt=NULL WHERE id=?',id);
        await notices.text(id,billing ? '✅ درخواست پرداخت ثبت شد. شمارهٔ پیگیری  '+fa(row.id) : '✅ بازخورد ناشناس ثبت شد. ممنون که گفتی.',[[home()]]);
        break;
      }
      default:
        await this.show(notices,id,views.main(user));
    }
  }

  async search({db,notices}, user, input) {
    const value = latin(input.trim());
    let person = null;
    if (/^[1-9]\d{1,15}$/.test(value) && validUserId(Number(value))) {
      person = await db.one('SELECT * FROM users WHERE id=?',Number(value));
    } else if (/^@?[a-zA-Z0-9_]{3,32}$/.test(value)) {
      const handle = value.replace(/^@/,'');
      const columns = value.startsWith('@') ? ['telegram_username','alias'] : ['alias','telegram_username'];
      for (const column of columns) {
        person = await db.one('SELECT * FROM users WHERE '+column+'=? ORDER BY active_at DESC LIMIT 1',handle);
        if (person) break;
      }
    }
    if (!person || person.id === user.id) throw new GameError('بازیکن پیدا نشد. دوستت باید دست‌کم یک بار /start زده باشد.');
    await db.run('UPDATE users SET prompt=NULL WHERE id=?',user.id);
    await notices.text(user.id,'👤 <b>'+escape(playerName(person))+'</b>'+(person.alias ? '\n<code>'+escape(person.alias)+'</code>' : ''),[
      [button('✉️ دعوت به میز','invite:'+person.id,'success')],[button('جست‌وجوی دوباره','search'),home()]
    ]);
  }

  async cancel({db,tables,notices,views}, user, leave) {
    const id = user.id;
    await db.run('UPDATE users SET prompt=NULL WHERE id=?',id);
    if (user.prompt && !leave) {
      await notices.text(id,'ورودی لغو شد.',[[home()]]);
      return;
    }
    if (await db.run('DELETE FROM queue WHERE user_id=?',id)) {
      await notices.text(id,'از صف حریف‌یابی خارج شدی.',[[button('بازی جدید','play'),home()]]);
      return;
    }
    const game = await tables.current(id);
    if (!game) {
      await this.show(notices,id,views.main(user));
      return;
    }
    if (game.status === 'waiting') {
      await tables.leaveWaiting(game,id);
      await notices.text(id,'از میز خصوصی خارج شدی.',[[home()]]);
      return;
    }
    const state = JSON.parse(game.state);
    await notices.text(id,'با انصراف، نتیجه برای تیم مقابل ثبت می‌شود. برای خروج دکمهٔ تأیید را بزن.',[
      [button('تأیید انصراف','act:'+game.id+':'+state.v+':resign:0','danger')],
      [button('ادامهٔ میز','table','success')]
    ]);
  }

  async action(ctx, user, action) {
    const { db,tables,payments,notices,views } = ctx;
    const id = user.id;
    const move = /^act:([1-9]\d{0,15}):([1-9]\d{0,8}):(cut|trump|card|redeal|vote|bam|resign):(\d{1,2})$/.exec(action);
    if (move) {
      await tables.act(id,Number(move[1]),Number(move[2]),move[3],Number(move[4]));
      return;
    }
    const board = /^board:(day|week|month):([01])$/.exec(action);
    if (board) {
      await this.show(notices,id,views.board(id,board[1],board[2] === '1'));
      return;
    }
    const join = /^join:([a-f0-9]{12})$/.exec(action);
    if (join) {
      await tables.joinRoom(id,join[1]);
      return;
    }
    const invite = /^invite:([1-9]\d{1,15})$/.exec(action);
    if (invite) {
      const target = Number(invite[1]);
      if (!validUserId(target) || !(await db.scalar('SELECT 1 FROM users WHERE id=?',target))) throw new GameError('این بازیکن پیدا نشد.');
      await tables.invite(id,target,playerName(user));
      await notices.text(id,'✉️ دعوت فرستاده شد.',[[button('میز من','table','primary')]]);
      return;
    }
    const purchase = /^(buy|theme):(classic|royal|emerald)$/.exec(action);
    if (purchase) {
      if (purchase[1] === 'buy') await payments.order(id,purchase[2]);
      else {
        await payments.theme(id,purchase[2]);
        await this.show(notices,id,views.store(await db.one('SELECT * FROM users WHERE id=?',id)));
      }
      return;
    }

    const view = {
      home:() => views.main(user),play:() => views.modes(),profile:() => views.profile(user),
      wallet:() => views.wallet(id),store:() => views.store(user),friends:() => views.friends(id),
      help:() => views.help(),history:() => views.history(id),
      privacy:() => ['🔐 <b>حریم خصوصی</b>\n\nشناسه، نام و نام کاربری برای ورود و دعوت، و نتایج بازی برای پروفایل و جدول ذخیره می‌شوند. '+
        (this.starsEnabled ? 'شناسه و مبلغ خرید برای صدور رسید نگه داشته می‌شود. ' : '')+
        'بازخورد عمومی بدون شناسه ثبت می‌شود. برای اصلاح یا حذف داده‌ها از /feedback استفاده کن.',[[home()]]],
    };
    if (Object.hasOwn(view,action)) {
      if (action === 'home') await db.run('UPDATE users SET prompt=NULL WHERE id=?',id);
      await this.show(notices,id,view[action]());
      return;
    }

    const prompts = {
      search:'🔍 شناسهٔ عددی، ‎@username تلگرام یا نام کاربری داخل میز حکم را بفرست.',
      'edit:nickname':'نام نمایشی تا ۳۲ نویسه را بفرست. برای برگشت به نام تلگرام، «پاک» را بفرست.',
      'edit:alias':'نام کاربری ۳ تا ۲۴ نویسه‌ای را با حرف انگلیسی شروع کن. عدد و زیرخط هم مجازند. برای حذف، «پاک» را بفرست.',
      'edit:bio':'یک معرفی کوتاه تا ۱۱۰ نویسه بنویس. برای حذف، «پاک» را بفرست.',
      feedback:'💬 پیشنهاد یا گزارش خطا را در یک پیام بفرست. این بازخورد بدون شناسه ثبت می‌شود.',
      paysupport:'🧾 شناسهٔ رسید /wallet و مشکل پرداخت را بنویس. پاسخ پشتیبانی در همین گفتگو می‌آید.',
    };
    if (Object.hasOwn(prompts,action)) {
      if (action === 'paysupport' && !this.starsEnabled) throw new GameError('برای گزارش مشکل از /feedback استفاده کن.');
      await db.run('UPDATE users SET prompt=? WHERE id=?',action,id);
      await notices.text(id,prompts[action],[[button('لغو','cancel','danger')]]);
      return;
    }
    switch (action) {
      case 'queue': {
        const queue = await tables.queue(id);
        if (!queue.game) await notices.text(id,
          '⚡ <b>دنبال حریف می‌گردیم</b>\n\nتعداد نفرات صف  '+fa(queue.count)+' از ۴\nبا کامل‌شدن میز پیام می‌رسد. مهلت صف ۱۲ دقیقه است.',
          [[button('خروج از صف','cancel','danger'),home()]]);
        break;
      }
      case 'practice':
        await tables.practice(id);
        break;
      case 'room': {
        const room = await tables.openRoom(id);
        await notices.table(room.id,id,true);
        break;
      }
      case 'table': {
        const game = await tables.current(id);
        if (game) await notices.table(game.id,id,true);
        else if (await db.scalar('SELECT 1 FROM queue WHERE user_id=?',id)) {
          await notices.text(id,'در صف حریف‌یابی هستی. وقتی میز تکمیل شد پیام می‌رسد.',[[button('خروج از صف','cancel','danger')]]);
        } else await this.show(notices,id,views.modes());
        break;
      }
      case 'cancel':
      case 'leave':
        await this.cancel(ctx,user,action === 'leave');
        break;
      default:
        throw new GameError('این میانبر در دسترس نیست. از /start وارد شو.');
    }
  }

  async drain(seconds = 8) {
    const stop = Date.now()+seconds*1000;
    let count = 0;
    while (count < 24 && Date.now() < stop) {
      const now = unixTime();
      const jobs = await this.db.all('UPDATE outbox SET lock_until=?,attempts=attempts+1 WHERE id IN ('+
        'SELECT o.id FROM outbox o WHERE o.dead_at IS NULL AND o.available_at<=? AND o.lock_until<=? '+
        'AND o.id=(SELECT MIN(p.id) FROM outbox p WHERE p.user_id=o.user_id AND p.dead_at IS NULL) '+
        'ORDER BY o.id LIMIT 4) RETURNING *',now+24,now,now);
      if (!jobs.length) break;
      count += jobs.length;
      const completed = await Promise.allSettled(jobs.map(job => this.deliver(job)));
      for (const [i,result] of completed.entries()) {
        await this.settle(jobs[i],result,now);
      }
    }
    return !(await this.db.scalar('SELECT 1 FROM outbox WHERE dead_at IS NULL LIMIT 1'));
  }

  async deliver(job) {
    const { views,payments } = this.context();
    const payload = JSON.parse(job.payload);
    if (job.kind === 'invoice') {
      await payments.issue(this.api,payload.id);
      return null;
    }
    if (job.kind === 'text') {
      await this.api.call('sendMessage',messageArgs(job.user_id,payload.html,payload.buttons));
      return null;
    }
    const view = await views.table(payload.game,job.user_id);
    if (!view) return null;
    const [html,buttons,message] = view;
    const args = messageArgs(job.user_id,html,buttons);
    if (message) {
      try {
        await this.api.call('editMessageText',{...args,message_id:message});
        return null;
      } catch (error) {
        if (!(error instanceof TelegramError)) throw error;
        if (error.message.includes('message is not modified')) return null;
        if (error.code !== 400 || !/message to edit not found|message can.t be edited|message_id_invalid|message identifier is not specified/i.test(error.message)) throw error;
      }
    }
    const sent = await this.api.call('sendMessage',args);
    return { game:payload.game,message:sent.message_id };
  }

  async settle(job, result, now) {
    await this.db.atomic(async db => {
      if (result.status === 'fulfilled') {
        if (result.value) {
          await db.run('UPDATE seats SET telegram_message=? WHERE game_id=? AND user_id=?',result.value.message,result.value.game,job.user_id);
        }
        await db.run('DELETE FROM outbox WHERE id=? AND version=?',job.id,job.version);
      } else {
        const error = result.reason;
        const retry = !(error instanceof TelegramError) || error.uncertain || error.code === 429;
        const next = now + Math.min(120,Math.max(error.retry ?? 0,2 ** job.attempts));
        const dead = retry && job.attempts < 7 ? null : now;
        const errorMessage = error instanceof TelegramError ? error.message : 'خطای موقت در آماده‌کردن پیام';
        const changed = await db.run('UPDATE outbox SET available_at=?,last_error=?,dead_at=? WHERE id=? AND version=?',
          next,errorMessage,dead,job.id,job.version);
        if (changed && dead && job.kind === 'invoice') {
          await db.run("UPDATE invoices SET status='issue_failed',updated_at=? WHERE status='pending' AND id=?",now,JSON.parse(job.payload).id);
        }
      }
      await db.run('UPDATE outbox SET lock_until=0 WHERE id=?',job.id);
    });
  }
}

function messageArgs(user, text, buttons) {
  return { chat_id:user,text,parse_mode:'HTML',link_preview_options:{is_disabled:true},
    ...(buttons.length ? {reply_markup:{inline_keyboard:buttons}} : {}) };
}
