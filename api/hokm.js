import { createClient } from '@libsql/client/web';
import { Db } from '../src/core.js';
import { Telegram } from '../src/telegram.js';
import { createApp } from '../src/web.js';

let db;

export default createApp({
  database() {
    const url=process.env.TURSO_DATABASE_URL;
    const authToken=process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) return null;
    if (!db) db=new Db(createClient({url,authToken,intMode:'number',concurrency:12}));
    return db;
  },
  botToken:()=>process.env.TELEGRAM_BOT_TOKEN ?? '',
  setupKey:()=>process.env.HOKM_SETUP_KEY ?? '',
  productionUrl:()=>{
    if (process.env.HOKM_PUBLIC_URL) return process.env.HOKM_PUBLIC_URL.replace(/\/+$/,'');
    const domain=process.env.VERCEL_PROJECT_PRODUCTION_URL;
    return domain ? 'https://'+domain : '';
  },
  telegram:()=>new Telegram(process.env.TELEGRAM_BOT_TOKEN ?? ''),
  starsEnabled:()=>process.env.HOKM_ENABLE_STARS === '1',
});
