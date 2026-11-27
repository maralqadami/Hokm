import { createHmac } from 'node:crypto';
import { equalSecret, periodNames, periodStart, periodTitle, shortText, stamp } from './core.js';
import { canRulerRedeal, GameError, legalCards, voteOpen } from './game.js';
import { paymentLabels, Payments, themes } from './payments.js';
import { changePlayerField, findPlayer, registerPlayer, validUserId } from './player.js';
import { giftCosts, modes, playerName, Tables } from './tables.js';
import { miniAppButton } from './telegram.js';

const inviteCode = /^[a-f0-9]{12}$/;
const moveNames = new Set(['cut','trump','card','redeal','vote','bam','resign']);
const tableActions = new Set(['queue','unqueue','practice','room','join','leave','move','invite']);

export class MiniAppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function verifyMiniUser(authorization, token, now) {
  const invalid = () => new MiniAppError(401,'برای ادامه، میز حکم را دوباره از تلگرام باز کن.');
  if (typeof authorization !== 'string' || !authorization.startsWith('tma ') || authorization.length > 12000) {
    throw invalid();
  }
  const data = new URLSearchParams(authorization.slice(4));
  const fields = [...data.keys()];
  if (new Set(fields).size !== fields.length || fields.some(key => !/^[a-z][a-z0-9_]*$/.test(key))) {
    throw invalid();
  }
  const hash = data.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw invalid();
  data.delete('hash');
  data.sort();
  const check = [...data].map(([key,value]) => key+'='+value).join('\n');
  const secret = createHmac('sha256','WebAppData').update(token).digest();
  const expected = createHmac('sha256',secret).update(check).digest('hex');
  if (!equalSecret(hash,expected)) throw invalid();
  const date = data.get('auth_date') ?? '';
  const age = now-Number(date);
  if (!/^\d{1,12}$/.test(date) || age < -90 || age > 86400) throw invalid();
  let user;
  try {
    user = JSON.parse(data.get('user'));
  } catch {
    throw invalid();
  }
  if (!validUserId(user?.id) || user.is_bot) throw invalid();
  return user;
}

function playerSummary(user) {
  return { name:playerName(user),nickname:user.nickname,alias:user.alias,bio:user.bio,theme:user.theme };
}

async function tableState(tables, game, userId) {
  if (!game) return null;
  const members = await tables.members(game.id);
  const me = members.find(row => row.user_id === userId);
  if (!me) return null;
  const state = game.state ? JSON.parse(game.state) : null;
  const table = {
    id:game.id, mode:game.mode, status:game.status, dueAt:game.due_at,
    seat:me.seat, owner:game.owner_id === userId,
    players:members.map(row => ({
      seat:row.seat, name:row.user_id === null ? 'ربات '+(row.seat+1) : playerName(row),
      bot:row.user_id === null,
    })),
  };
  if (game.status === 'waiting') table.code = game.code;
  if (!state) return table;
  const myTurn = game.status === 'active' && state.turn === me.seat;
  const hand = state.phase === 'ended' || (state.phase === 'choose' && state.ruler !== me.seat)
    ? [] : [...state.hands[me.seat]].sort((a,b) => a-b);
  return {
    ...table, phase:state.phase, turn:state.turn, ruler:state.ruler, trump:state.trump,
    score:state.score, tricks:state.tricks, trick:state.trick, lastTrick:state.lastTrick ?? null,
    round:state.round, version:state.v, notice:state.notice, winner:state.winner, reason:state.reason,
    hand, legal:myTurn && state.phase === 'play' ? legalCards(state,me.seat) : [],
    redeal:myTurn && canRulerRedeal(state),
    vote:game.status === 'active' && voteOpen(state) && !state.votes.includes(me.seat),
  };
}

async function snapshot(db, tables, userId, gameId) {
  let game = await tables.current(userId);
  if (!game && validUserId(gameId)) {
    game = await db.one('SELECT g.* FROM games g JOIN seats s ON s.game_id=g.id WHERE g.id=? AND s.user_id=?',
      gameId,userId);
  }
  return {
    table:await tableState(tables,game,userId),
    queue:game ? null : await tables.queued(userId),
    now:tables.now,
  };
}

async function profile(db, user, now, starsEnabled) {
  const stats = await db.one('SELECT COALESCE(SUM(won),0) wins,COALESCE(SUM(1-won),0) losses FROM results WHERE user_id=?',user.id);
  const rows = await db.all('SELECT r.won,r.finished_at,g.mode FROM results r JOIN games g ON g.id=r.game_id '+
    'WHERE r.user_id=? ORDER BY r.finished_at DESC,r.game_id DESC LIMIT 10',user.id);
  const payments = new Payments(db,now,starsEnabled);
  const storeOpen = starsEnabled && await db.flag('store_open');
  const styles = [];
  for (const [sku,item] of Object.entries(themes)) {
    styles.push({ sku,name:item.name,stars:item.stars,owned:await payments.owned(user.id,sku),storeOpen });
  }
  const receipts = starsEnabled ? await db.all('SELECT id,sku,stars,status,created_at FROM invoices '+
    'WHERE user_id=? ORDER BY created_at DESC LIMIT 6',user.id) : [];
  const extra = starsEnabled ? await db.all('SELECT c.id,c.total stars,c.status,c.created_at FROM charges c '+
    'LEFT JOIN invoices i ON i.primary_charge=c.id WHERE c.user_id=? AND i.id IS NULL '+
    'ORDER BY c.created_at DESC LIMIT 3',user.id) : [];
  return {
    user:playerSummary(user),stats,styles,starsEnabled,
    history:rows.map(row => ({ won:Boolean(row.won),mode:modes[row.mode],date:stamp(row.finished_at) })),
    receipts:[...receipts,...extra].map(row => ({
      id:row.id.slice(0,10),title:themes[row.sku]?.name ?? 'پرداخت تلگرام',stars:row.stars,
      status:paymentLabels[row.status] ?? 'در حال بررسی',date:stamp(row.created_at),
    })),
  };
}

async function board(tables, input, userId, rewardsOpen) {
  const kind = typeof input.period === 'string' && Object.hasOwn(periodNames,input.period) ? input.period : 'day';
  let boundary = periodStart(kind,tables.now);
  if (input.previous === true) boundary = periodStart(kind,boundary-1);
  const rows = await tables.board(kind,boundary);
  const [mine] = await tables.board(kind,boundary,userId,1);
  return {
    date:periodTitle(kind,boundary), myRank:mine?.position ?? null, gifts:rewardsOpen ? giftCosts : [],
    rows:rows.map(row => ({
      name:playerName(row),rank:row.position,wins:row.wins,losses:row.losses,mine:row.user_id === userId,
    })),
  };
}

async function friends(db, userId, now) {
  const rows = await db.all("SELECT g.code,u.name,u.nickname FROM invites i JOIN games g ON g.id=i.game_id "+
    "JOIN users u ON u.id=i.from_id WHERE i.user_id=? AND g.status='waiting' AND g.due_at>? ORDER BY i.created_at DESC LIMIT 5",
    userId,now);
  return { invites:rows.map(row => ({ name:playerName(row),code:row.code })) };
}

async function tableAction(db, tables, name, input, user, config) {
  await tables.sweep();
  const id = user.id;
  switch (name) {
    case 'queue': await tables.queue(id); break;
    case 'unqueue': await db.run('DELETE FROM queue WHERE user_id=?',id); break;
    case 'practice': await tables.practice(id); break;
    case 'room': await tables.openRoom(id); break;
    case 'join': {
      const code = typeof input.code === 'string' ? input.code.trim().toLowerCase() : '';
      if (!inviteCode.test(code)) throw new GameError('کد دعوت باید ۱۲ نویسه باشد.');
      const current = await tables.current(id);
      if (current?.code !== code) await tables.joinRoom(id,code);
      break;
    }
    case 'leave': {
      const game = await tables.current(id);
      if (game?.status !== 'waiting' || game.id !== input.gameId) {
        throw new GameError('این میز انتظار دیگر در دسترس نیست.');
      }
      await tables.leaveWaiting(game,id);
      break;
    }
    case 'move':
      if (!validUserId(input.gameId) || !validUserId(input.version) || !moveNames.has(input.move) ||
          !Number.isInteger(input.value) || input.value < 0 || input.value > 51) {
        throw new GameError('حرکت بازی معتبر نیست.');
      }
      await tables.act(id,input.gameId,input.version,input.move,input.value);
      break;
    case 'invite':
      if (!validUserId(input.playerId) || !(await db.scalar('SELECT 1 FROM users WHERE id=?',input.playerId))) {
        throw new GameError('بازیکن پیدا نشد.');
      }
      await tables.invite(id,input.playerId,playerName(user),
        code => miniAppButton(config,{join:code},'پیوستن به میز'));
      break;
  }
  return snapshot(db,tables,id,name === 'move' ? input.gameId : null);
}

export async function miniAction({db,config,now,starsEnabled,identity,api}, input) {
  const name = input.action;
  const tables = new Tables(db,now,false);
  if (name === 'init') {
    return db.atomic(async tx => {
      const user = await registerPlayer(tx,identity,now);
      return { user:playerSummary(user),bot:config.username,...await snapshot(tx,new Tables(tx,now,false),user.id,null) };
    });
  }
  const id = identity.id;
  if (name === 'state') {
    const read = tx => snapshot(tx,new Tables(tx,now,false),id,input.gameId);
    const view = await db.atomic(read,'read');
    if (view.table?.dueAt && view.table.dueAt <= now) {
      return db.atomic(async tx => {
        await new Tables(tx,now,false).sweep();
        return read(tx);
      });
    }
    return view;
  }
  if (name === 'rank') return board(tables,input,id,starsEnabled && await db.flag('rewards_open'));
  if (name === 'friends') return friends(db,id,now);
  if (name === 'search') {
    if (typeof input.query !== 'string') throw new MiniAppError(400,'نام کاربری یا شناسهٔ دوستت را وارد کن.');
    const person = await findPlayer(db,input.query);
    if (!person || person.id === id) throw new GameError('بازیکن پیدا نشد. دوستت یک بار میز حکم را باز کند.');
    return { friend:{ id:person.id,name:playerName(person),alias:person.alias } };
  }
  if (!tableActions.has(name) && !['profile','edit','theme','purchase','feedback'].includes(name)) {
    throw new MiniAppError(400,'این درخواست در میز حکم شناخته نشد.');
  }
  const user = await db.one('SELECT * FROM users WHERE id=?',id);
  if (!user) throw new MiniAppError(401,'میز حکم را دوباره از تلگرام باز کن.');
  if (tableActions.has(name)) {
    return db.atomic(tx => tableAction(tx,new Tables(tx,now,false),name,input,user,config));
  }
  if (name === 'profile') return profile(db,user,now,starsEnabled);
  if (name === 'purchase') {
    const invoiceId = await db.atomic(tx => new Payments(tx,now,starsEnabled).prepareOrder(id,input.sku));
    const invoice = await new Payments(db,now,starsEnabled).invoiceLink(api,invoiceId);
    return { invoice };
  }
  if (name === 'feedback') {
    if (typeof input.message !== 'string') throw new MiniAppError(400,'متن بازخورد را بنویس.');
    const content = shortText(input.message,700);
    if ([...content].length < 4) throw new GameError('چند کلمه بیشتر دربارهٔ موضوع بنویس.');
    await db.run("INSERT INTO feedback(kind,message,created_at) VALUES('feedback',?,?)",content,now);
    return { saved:true };
  }
  return db.atomic(async tx => {
    if (name === 'edit') await changePlayerField(tx,id,input.field,input.value);
    else await new Payments(tx,now,starsEnabled).theme(id,input.sku);
    const updated = await tx.one('SELECT * FROM users WHERE id=?',id);
    return profile(tx,updated,now,starsEnabled);
  });
}
