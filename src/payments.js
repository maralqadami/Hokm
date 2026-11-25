import { fa, nonce } from './core.js';
import { GameError } from './game.js';
import { TelegramError } from './telegram.js';
import { Notices } from './tables.js';

export const themes = {
  classic:{name:'کلاسیک',icon:'♠️',stars:0,description:'تم پایهٔ میز و پروفایل'},
  emerald:{name:'مخمل سبز',icon:'🟢',stars:35,description:'رنگ سبز دکمه‌های میز و نشان مخمل سبز در پروفایل'},
  royal:{name:'شاهانه',icon:'👑',stars:50,description:'نشان تاج در پروفایل و میز و منوی بازی'},
};
export const paymentLabels = {
  pending:'در انتظار پرداخت',authorized:'در انتظار تأیید نهایی تلگرام',
  expired:'منقضی',checkout_expired:'پایان مهلت تأیید',issue_failed:'خطا در صدور فاکتور',
  paid:'پرداخت‌شده',refunded:'بازگشت وجه',mismatch:'مغایرت، نیازمند بررسی',
  duplicate:'پرداخت اضافه، نیازمند بررسی',refunding:'در حال بازگشت وجه',refund_review:'بازگشت وجه نیازمند بررسی',
};
export const rewardLabels = {
  pending:'در انتظار ارسال',sending:'در حال ارسال',sent:'ارسال‌شده',failed:'خطا در ارسال',review:'نیازمند بررسی ارسال',
};
const invoiceSeconds = 1500;

export class Payments {
  constructor(db, now, enabled) {
    this.db = db;
    this.now = now;
    this.enabled = enabled;
    this.notices = new Notices(db,now);
  }

  async expire() {
    await this.db.run("UPDATE invoices SET status='expired',updated_at=? WHERE status='pending' AND created_at<=?",
      this.now,this.now-invoiceSeconds);
    await this.db.run("UPDATE invoices SET status='checkout_expired',updated_at=? WHERE status='authorized' AND updated_at<=?",
      this.now,this.now-3600);
  }

  async owned(user, sku) {
    return !this.enabled || sku === 'classic' || Boolean(await this.db.scalar(
      "SELECT 1 FROM invoices WHERE user_id=? AND sku=? AND status='paid' LIMIT 1",user,sku));
  }

  async theme(user, sku) {
    if (!Object.hasOwn(themes,sku) || !(await this.owned(user,sku))) throw new GameError('این تم هنوز برای پروفایلت فعال نشده.');
    await this.db.run('UPDATE users SET theme=? WHERE id=?',sku,user);
  }

  async order(user, sku) {
    const item = themes[sku];
    if (!this.enabled || !item?.stars || !(await this.db.flag('store_open'))) {
      throw new GameError('فروش این تم در حال حاضر فعال نیست.');
    }
    if (await this.owned(user,sku)) throw new GameError('این تم قبلاً برایت فعال شده.');
    await this.expire();
    const old = await this.db.one("SELECT * FROM invoices WHERE user_id=? AND sku=? AND status IN ('pending','authorized') LIMIT 1",user,sku);
    if (old?.status === 'authorized') throw new GameError('تلگرام هنوز پرداخت فاکتور را تأیید نکرده است.');
    const id = old?.id ?? nonce();
    if (!old) {
      await this.db.run("INSERT INTO invoices(id,user_id,sku,stars,status,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)",
        id,user,sku,item.stars,this.now,this.now);
    }
    await this.notices.add('invoice',user,{id},'invoice:'+id);
  }

  async checkout(user, query) {
    const id = String(query.id ?? '');
    const reject = { pre_checkout_query_id:id, ok:false, error_message:'این فاکتور قابل پرداخت نیست. فروشگاه را دوباره باز کن.' };
    if (!this.enabled) return reject;
    await this.expire();
    const invoice = await this.db.one('SELECT * FROM invoices WHERE id=?',String(query.invoice_payload ?? ''));
    if (!invoice || invoice.user_id !== user || query.currency !== 'XTR' || query.total_amount !== invoice.stars) return reject;
    const accept = { pre_checkout_query_id:id,ok:true };
    if (invoice.status === 'authorized' && invoice.checkout_id === id) return accept;
    if (invoice.status !== 'pending' || !(await this.db.flag('store_open')) || await this.owned(user,invoice.sku)) return reject;
    await this.db.run("UPDATE invoices SET status='authorized',checkout_id=?,updated_at=? WHERE id=?",id,this.now,invoice.id);
    return accept;
  }

  async paid(user, payment) {
    const id = String(payment.telegram_payment_charge_id ?? '');
    if (!id || await this.db.scalar('SELECT 1 FROM charges WHERE id=?',id)) return;
    const payload = String(payment.invoice_payload ?? '');
    const amount = Number(payment.total_amount ?? 0);
    const currency = String(payment.currency ?? '');
    const invoice = await this.db.one('SELECT * FROM invoices WHERE id=?',payload);
    let status = 'mismatch';
    if (invoice?.user_id === user && currency === 'XTR' && amount === invoice.stars) {
      const purchased = await this.db.scalar("SELECT 1 FROM invoices WHERE user_id=? AND sku=? AND status='paid' LIMIT 1",user,invoice.sku);
      if (purchased || invoice.primary_charge) status = 'duplicate';
      else if (['authorized','checkout_expired'].includes(invoice.status)) status = 'paid';
    }
    await this.db.run('INSERT INTO charges(id,invoice_id,user_id,payload,currency,total,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id,invoice?.id ?? null,user,payload,currency,amount,status,this.now,this.now);
    if (status !== 'paid') {
      await this.notices.text(user,'🧾 پرداخت ثبت شد و در حال بررسی است. برای پیگیری /paysupport را بزن.');
      return;
    }
    await this.db.run("UPDATE invoices SET status='paid',primary_charge=?,updated_at=? WHERE id=?",id,this.now,invoice.id);
    await this.theme(user,invoice.sku);
    await this.notices.text(user,'✅ تم <b>'+themes[invoice.sku].name+'</b> فعال شد. رسید در /wallet.');
  }

  async onRefund(user, payment) {
    const id = String(payment.telegram_payment_charge_id ?? '');
    if (!id || payment.currency !== 'XTR') return;
    const amount = Number(payment.total_amount ?? 0);
    const charge = await this.db.one('SELECT * FROM charges WHERE id=?',id);
    if (charge) {
      if (charge.user_id === user && charge.total === amount) await this.confirmRefund(charge);
      return;
    }
    const payload = String(payment.invoice_payload ?? '');
    const invoice = await this.db.one('SELECT * FROM invoices WHERE id=? AND user_id=?',payload,user);
    await this.db.run("INSERT INTO charges(id,invoice_id,user_id,payload,currency,total,status,created_at,updated_at) VALUES(?,?,?,?,'XTR',?,'refunded',?,?)",
      id,invoice?.id ?? null,user,payload,amount,this.now,this.now);
    if (invoice && !invoice.primary_charge && invoice.stars === amount) {
      await this.db.run("UPDATE invoices SET status='refunded',primary_charge=?,updated_at=? WHERE id=?",id,this.now,invoice.id);
    }
  }

  async confirmRefund(charge) {
    if (charge.status === 'refunded') return;
    await this.db.run("UPDATE charges SET status='refunded',updated_at=? WHERE id=?",this.now,charge.id);
    const invoice = await this.db.one('SELECT * FROM invoices WHERE primary_charge=?',charge.id);
    if (invoice) {
      await this.db.run("UPDATE invoices SET status='refunded',updated_at=? WHERE id=?",this.now,invoice.id);
      await this.db.run("UPDATE users SET theme='classic' WHERE id=? AND theme=? AND NOT EXISTS " +
        "(SELECT 1 FROM invoices WHERE user_id=? AND sku=? AND status='paid')",charge.user_id,invoice.sku,charge.user_id,invoice.sku);
    }
    await this.notices.text(charge.user_id,'↩️ بازگشت '+fa(charge.total)+' استارز ثبت شد. جزئیات در /wallet.');
  }

  async issue(api, id) {
    if (!this.enabled) return;
    const row = await this.db.one("SELECT * FROM invoices WHERE id=? AND status='pending' AND created_at>?",id,this.now-invoiceSeconds);
    if (!row) return;
    const item = themes[row.sku];
    await api.call('sendInvoice',{
      chat_id:row.user_id,title:'تم '+item.name,description:item.description+'. انتخاب تم روی نتیجه و جدول اثری ندارد.',
      payload:id,provider_token:'',currency:'XTR',prices:[{label:item.name,amount:row.stars}],start_parameter:'hokm-store',
    });
  }

  async refund(api, id) {
    const row = await this.db.atomic(async tx => {
      const charge = await tx.one('SELECT * FROM charges WHERE id=?',id);
      if (charge?.currency !== 'XTR' || !['paid','mismatch','duplicate','refund_review'].includes(charge.status)) {
        throw new GameError('این تراکنش آمادهٔ بازگشت وجه نیست.');
      }
      const previous = charge.status === 'refund_review' ? charge.before_refund : charge.status;
      await tx.run("UPDATE charges SET status='refunding',before_refund=?,updated_at=? WHERE id=?",previous,this.now,id);
      return {...charge,previous};
    });
    try {
      await api.call('refundStarPayment',{user_id:row.user_id,telegram_payment_charge_id:id},7000);
    } catch (error) {
      if (!(error instanceof TelegramError) || !error.message.toUpperCase().includes('ALREADY_REFUNDED')) {
        const next = error instanceof TelegramError && !error.uncertain ? row.previous : 'refund_review';
        await this.db.run("UPDATE charges SET status=?,updated_at=? WHERE id=? AND status='refunding'",next,this.now,id);
        throw error;
      }
    }
    await this.db.atomic(async tx => {
      const charge = await tx.one('SELECT * FROM charges WHERE id=?',id);
      await new Payments(tx,this.now,this.enabled).confirmRefund(charge);
    });
  }

  async gift(api, id) {
    const reward = await this.db.one('SELECT * FROM rewards WHERE id=?',id);
    if (!this.enabled || !(await this.db.flag('rewards_open')) || !['pending','failed'].includes(reward?.status)) {
      throw new GameError('این گیفت آمادهٔ ارسال نیست.');
    }
    const catalog = (await api.call('getAvailableGifts'))?.gifts ?? [];
    const item = catalog.find(gift => gift.star_count === reward.cost && !gift.total_count && !gift.is_premium && !gift.is_premium_required);
    if (!item) throw new GameError('در کاتالوگ، گیفت عادیِ '+fa(reward.cost)+' استارزی موجود نیست.');
    const claimed = await this.db.run("UPDATE rewards SET status='sending',gift_id=?,updated_at=? WHERE id=? AND status IN ('pending','failed')",
      item.id,this.now,id);
    if (!claimed) throw new GameError('ارسال این جایزه قبلاً شروع شده.');
    try {
      await api.call('sendGift',{user_id:reward.user_id,gift_id:item.id,
        text:'رتبهٔ '+fa(reward.rank)+' جدول میز حکم مبارک! ♠️'},8000);
    } catch (error) {
      const status = error instanceof TelegramError && !error.uncertain ? 'failed' : 'review';
      await this.db.run("UPDATE rewards SET status=?,updated_at=? WHERE id=? AND status='sending'",status,this.now,id);
      throw error;
    }
    await this.db.run("UPDATE rewards SET status='sent',updated_at=? WHERE id=? AND status='sending'",this.now,id);
  }
}
