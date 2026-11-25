import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const unixTime = () => Math.floor(Date.now() / 1000);
export const nonce = (bytes = 16) => randomBytes(bytes).toString('hex');
const faDigits = '۰۱۲۳۴۵۶۷۸۹';
const arDigits = '٠١٢٣٤٥٦٧٨٩';
export const fa = value => String(value).replace(/[0-9]/g, digit => faDigits[digit]);
export const latin = value => String(value).replace(/[۰-۹٠-٩]/g, digit => String(Math.max(faDigits.indexOf(digit), arDigits.indexOf(digit))));

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);

export function shortText(value, max) {
  return [...String(value ?? '').replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]+/gu,' ').trim()].slice(0, max).join('');
}

export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isDbBusy(error) {
  return /SQLITE_(BUSY|LOCKED)/.test(String(error?.code)) || /database is locked/.test(String(error?.message));
}

export class Db {
  constructor(driver) { this.driver = driver; }
  async query(sql, ...args) { return this.driver.execute({ sql, args }); }
  async all(sql, ...args) { return (await this.query(sql, ...args)).rows; }
  async one(sql, ...args) { return (await this.all(sql, ...args))[0] ?? null; }
  async scalar(sql, ...args) {
    const rows = await this.query(sql, ...args);
    return rows.rows[0]?.[0] ?? null;
  }
  async run(sql, ...args) { return (await this.query(sql, ...args)).rowsAffected; }
  async flag(key) { return (await this.scalar('SELECT value FROM settings WHERE key=?', key)) === '1'; }
  async atomic(action, mode = 'write') {
    for (let attempt = 0; ; attempt++) {
      let tx;
      try {
        tx = await this.driver.transaction(mode);
        const result = await action(new Db(tx));
        await tx.commit();
        return result;
      } catch (error) {
        if (tx && !tx.closed) {
          try {
            await tx.rollback();
          } catch {
            throw error;
          }
        }
        // SQLite reports this conflict before committing. A transport timeout
        // has an unknown outcome and is left to Telegram's stable update ID.
        if (attempt >= 4 || !isDbBusy(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt + Math.random() * 20));
      } finally {
        tx?.close();
      }
    }
  }
  async migrate() {
    const source = await readFile(new URL('./schema.sql', import.meta.url),'utf8');
    const statements = source.split(';').map(s => s.trim()).filter(Boolean);
    await this.driver.batch(statements,'write');
  }
}

const timezone = 'Asia/Tehran';
const solar = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', {
  timeZone: timezone, day:'numeric', month:'long', year:'numeric',
});
const gregorian = new Intl.DateTimeFormat('en-GB', {
  timeZone: timezone, day:'numeric', month:'numeric', year:'numeric', timeZoneName:'shortOffset',
});
const clock = new Intl.DateTimeFormat('fa-IR', { timeZone: timezone, hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
const parts = (formatter, second) => Object.fromEntries(formatter.formatToParts(second * 1000).map(p => [p.type,p.value]));
export const periodNames = { day:'روزانه', week:'هفتگی', month:'ماهانه' };

function offsetSeconds(text) {
  const match = /GMT([+-])(\d{1,2})(?::(\d\d))?/.exec(text);
  return match ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 3600 + Number(match[3] ?? 0) * 60) : 0;
}

export function periodStart(kind, time) {
  const local = parts(gregorian,time);
  const midnight = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day)) / 1000;
  let daysBefore = 0;
  if (kind === 'week') daysBefore = (new Date(midnight * 1000).getUTCDay() + 1) % 7;
  if (kind === 'month') daysBefore = Number(parts(solar,time).day) - 1;
  const boundary = midnight - daysBefore * 86400;
  const boundaryLocal = parts(gregorian,boundary);
  return boundary - offsetSeconds(boundaryLocal.timeZoneName);
}

export function periodTitle(kind, time) {
  const date = parts(solar,time);
  if (kind === 'month') return date.month + ' ' + fa(date.year);
  const label = [fa(date.day),date.month,fa(date.year)].join(' ');
  return kind === 'week' ? 'هفتهٔ ' + label : label;
}

export const timeLabel = time => clock.format(time * 1000);
export const stamp = time => periodTitle('day',time) + '، ' + timeLabel(time);
