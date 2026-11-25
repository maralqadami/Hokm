import { shortText } from './core.js';

export const commands = {
  start:'خانه و منوی اصلی',play:'میز رقابتی، خصوصی یا تمرینی',table:'بازگشت به میز بازی',
  profile:'پروفایل و آمار بازی',friends:'پیدا کردن دوست و دعوت به میز',rank:'رتبه‌بندی روزانه، هفتگی و ماهانه',
  wallet:'تم‌ها و رسیدها',help:'قوانین بازی و راهنما',feedback:'ارسال بازخورد ناشناس',
  paysupport:'پیگیری خرید و بازگشت وجه',cancel:'لغو و خروج',privacy:'حریم خصوصی و داده‌ها',
};

export class TelegramError extends Error {
  constructor(code, message, retry = 0) {
    super(message);
    this.code = code;
    this.retry = retry;
  }
  get uncertain() { return this.code === 0 || this.code >= 500; }
}

export const validBotToken = value => /^\d{5,16}:[A-Za-z0-9_-]{30,70}$/.test(value);

export class Telegram {
  constructor(token, transport) {
    this.token = token;
    this.transport = transport;
  }

  async call(method, data = {}, timeout = 4800) {
    if (this.transport) return this.transport(method, data);
    let response;
    let payload;
    try {
      response = await fetch('https://api.telegram.org/bot' + this.token + '/' + method, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify(data), signal:AbortSignal.timeout(timeout), redirect:'error',
      });
      payload = await response.json();
    } catch {
      throw new TelegramError(response?.status >= 500 ? response.status : 0, 'ارتباط با تلگرام کامل نشد.');
    }
    if (!payload.ok) {
      const description = String(payload.description ?? 'Telegram API error').replaceAll(this.token,'[token]');
      throw new TelegramError(Number(payload.error_code ?? response.status),shortText(description,220),Number(payload.parameters?.retry_after ?? 0));
    }
    return payload.result;
  }

  async sync(config, starsEnabled) {
    const listed = Object.entries(commands)
      .filter(([name]) => starsEnabled || name !== 'paysupport')
      .map(([command,description]) => ({ command, description }));
    await this.call('setWebhook', {
      url: config.base + '/api/telegram', secret_token: config.webhook,
      allowed_updates:['message','callback_query','pre_checkout_query'], max_connections:4,
    },7500);
    await this.call('setMyCommands', { commands:listed, scope:{ type:'all_private_chats' } });
    await this.call('setChatMenuButton', { menu_button:{type:'commands'} });
  }
}
