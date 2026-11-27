import { fa, latin, shortText } from './core.js';
import { GameError } from './game.js';

export const validUserId = id => Number.isSafeInteger(id) && id > 0;

export async function registerPlayer(db, from, now) {
  if (!validUserId(from?.id) || from.is_bot) return null;
  const name = shortText([from.first_name,from.last_name].filter(Boolean).join(' '),44) || 'بازیکن';
  const username = shortText(from.username,32) || null;
  await db.run(
    'INSERT INTO users(id,name,telegram_username,active_at,created_at) VALUES(?,?,?,?,?) ' +
    'ON CONFLICT(id) DO UPDATE SET name=excluded.name,telegram_username=excluded.telegram_username,active_at=excluded.active_at',
    from.id,name,username,now,now
  );
  return db.one('SELECT * FROM users WHERE id=?',from.id);
}

export async function changePlayerField(db, userId, field, input) {
  const limits = { nickname:32,alias:24,bio:110 };
  if (typeof field !== 'string' || !Object.hasOwn(limits,field) || typeof input !== 'string') {
    throw new GameError('این فیلد قابل ویرایش نیست.');
  }
  const limit = limits[field];
  let value = shortText(input,limit+1);
  if (field === 'alias' && value) {
    value = latin(value).replace(/^@/,'').toLowerCase();
    if (!/^[a-z][a-z0-9_]{2,23}$/.test(value)) {
      throw new GameError('نام کاربری باید ۳ تا ۲۴ حرف انگلیسی، عدد یا زیرخط باشد و با حرف شروع شود.');
    }
    if (await db.scalar('SELECT 1 FROM users WHERE alias=? AND id<>?',value,userId)) {
      throw new GameError('این نام کاربری گرفته شده.');
    }
  }
  if ([...value].length > limit) throw new GameError('حداکثر '+fa(limit)+' نویسه بنویس.');
  await db.run('UPDATE users SET '+field+'=?,prompt=NULL WHERE id=?',value || (field === 'bio' ? '' : null),userId);
}

export async function findPlayer(db, input) {
  const value = latin(shortText(input,38));
  if (/^[1-9]\d{0,15}$/.test(value) && validUserId(Number(value))) {
    return db.one('SELECT * FROM users WHERE id=?',Number(value));
  }
  if (!/^@?[a-zA-Z0-9_]{3,32}$/.test(value)) return null;
  const handle = value.replace(/^@/,'');
  const columns = value.startsWith('@') ? ['telegram_username','alias'] : ['alias','telegram_username'];
  for (const column of columns) {
    const player = await db.one('SELECT * FROM users WHERE '+column+'=? ORDER BY active_at DESC LIMIT 1',handle);
    if (player) return player;
  }
  return null;
}
