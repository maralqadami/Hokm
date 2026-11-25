import { escape, fa, nonce, periodNames, periodStart } from './core.js';
import { finishGame, GameError, playAction, runBots, startGame, voteRedeal } from './game.js';

export const modes = { ranked:'رقابتی', private:'خصوصی', practice:'تمرینی' };
export const giftCosts = [50,25,15];
const turnSeconds = 300;
const queueSeconds = 720;
const roomSeconds = 3600;

export class Notices {
  constructor(db, now) { this.db = db; this.now = now; }
  async add(kind, user, payload, route = null) {
    await this.db.run(
      'INSERT INTO outbox(route,kind,user_id,payload,available_at) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(route) DO UPDATE SET payload=excluded.payload,version=outbox.version+1, ' +
      'available_at=excluded.available_at,attempts=0,dead_at=NULL,last_error=NULL',
      route,kind,user,JSON.stringify(payload),this.now,
    );
  }
  async text(user, html, buttons = []) { await this.add('text',user,{html,buttons}); }
  async table(game, user, fresh = false) {
    await this.add('table',user,{game},'table:' + game + ':' + user);
    if (fresh) await this.db.run('UPDATE seats SET telegram_message=NULL WHERE game_id=? AND user_id=?',game,user);
  }
}

export class Tables {
  constructor(db, now) {
    this.db = db;
    this.now = now;
    this.notices = new Notices(db,now);
  }

  async current(user) {
    return this.db.one("SELECT g.* FROM games g JOIN seats s ON s.game_id=g.id WHERE s.user_id=? AND g.status IN ('waiting','active') ORDER BY g.id DESC LIMIT 1",user);
  }

  async members(game) {
    return this.db.all('SELECT s.*,u.name,u.nickname,u.alias,u.theme FROM seats s LEFT JOIN users u ON u.id=s.user_id WHERE s.game_id=? ORDER BY s.seat',game);
  }

  async available(user) {
    if (await this.current(user)) throw new GameError('یک میز باز داری. از «میز من» ادامه بده.');
  }

  async queue(user) {
    await this.available(user);
    await this.db.run('INSERT OR IGNORE INTO queue VALUES(?,?)',user,this.now);
    const queued = await this.db.all('SELECT user_id FROM queue WHERE joined_at>? ORDER BY joined_at,rowid LIMIT 4',this.now-queueSeconds);
    if (queued.length < 4) return { game:null,count:queued.length };
    const game = await this.insert('ranked',null,null);
    await this.activate(game,queued.map(row => row.user_id));
    return { game,count:4 };
  }

  async practice(user) {
    await this.available(user);
    const game = await this.insert('practice',user,null);
    await this.activate(game,[user,null,null,null]);
    return game;
  }

  async openRoom(user) {
    const existing = await this.current(user);
    if (existing?.status === 'waiting' && existing.mode === 'private') return existing;
    if (existing) throw new GameError('یک میز باز داری. از «میز من» ادامه بده.');
    const game = await this.insert('private',user,nonce(6));
    await this.db.run('DELETE FROM queue WHERE user_id=?',user);
    await this.db.run('INSERT INTO seats(game_id,seat,user_id) VALUES(?,0,?)',game,user);
    return this.db.one('SELECT * FROM games WHERE id=?',game);
  }

  async insert(mode, owner, code) {
    const result = await this.db.query("INSERT INTO games(mode,status,owner_id,code,created_at,due_at) VALUES(?,'waiting',?,?,?,?) RETURNING id",
      mode,owner,code,this.now,this.now+roomSeconds);
    return result.rows[0].id;
  }

  async activate(game, users) {
    const { seats, state } = startGame(users);
    runBots(state,seats);
    const before = new Map((await this.members(game)).map(row => [row.user_id,row.telegram_message]));
    await this.db.run('DELETE FROM seats WHERE game_id=?',game);
    for (const [seat,user] of seats.entries()) {
      await this.db.run('INSERT INTO seats(game_id,seat,user_id,telegram_message) VALUES(?,?,?,?)',game,seat,user,before.get(user) ?? null);
      if (user !== null) await this.db.run('DELETE FROM queue WHERE user_id=?',user);
    }
    await this.db.run("UPDATE games SET status='active',state=?,due_at=? WHERE id=?",JSON.stringify(state),this.now+turnSeconds,game);
    await this.notify(game,seats);
  }

  async joinRoom(user, code) {
    const game = await this.db.one("SELECT * FROM games WHERE status='waiting' AND code=? AND due_at>?",code,this.now);
    if (!game) throw new GameError('این دعوت معتبر نیست یا میز پر شده.');
    const current = await this.current(user);
    if (current?.id === game.id) {
      await this.notices.table(game.id,user,true);
      return;
    }
    if (current) throw new GameError('یک میز باز داری. از «میز من» ادامه بده.');
    const players = await this.members(game.id);
    const free = [0,1,2,3].filter(seat => !players.some(p => p.seat === seat));
    await this.db.run('DELETE FROM queue WHERE user_id=?',user);
    await this.db.run('INSERT INTO seats(game_id,seat,user_id) VALUES(?,?,?)',game.id,free[0],user);
    const users = [...players.map(r => r.user_id),user];
    if (free.length === 1) await this.activate(game.id,users);
    else await this.notify(game.id,users);
  }

  async invite(from, user, name) {
    if (from === user) throw new GameError('این پروفایل خودت است.');
    if (Number(await this.db.scalar('SELECT COUNT(*) FROM invites WHERE from_id=? AND created_at>?',from,this.now-300)) >= 5) {
      throw new GameError('تا چند دقیقه دیگر دوباره دعوت بفرست.');
    }
    const game = await this.openRoom(from);
    if (!(await this.db.run('INSERT OR IGNORE INTO invites VALUES(?,?,?,?)',game.id,from,user,this.now))) {
      throw new GameError('قبلاً دعوت این میز برای این بازیکن ارسال شده.');
    }
    await this.notices.text(user,'✉️ <b>دعوت به میز حکم</b>\n' + escape(name) + ' تو را به یک مسابقهٔ خصوصی دعوت کرده.',[
      [{text:'قبول دعوت',callback_data:'join:'+game.code,style:'success'}],
    ]);
    await this.notices.table(game.id,from);
  }

  async leaveWaiting(game, user) {
    if (game.owner_id === user) {
      await this.cancel(game.id);
      return;
    }
    await this.db.run('DELETE FROM seats WHERE game_id=? AND user_id=?',game.id,user);
    await this.notify(game.id);
  }

  async cancel(game) {
    await this.db.run("UPDATE games SET status='cancelled',due_at=NULL,ended_at=? WHERE id=?",this.now,game);
    await this.notify(game);
  }

  async sweep() {
    await this.db.run('DELETE FROM queue WHERE joined_at<=?',this.now-queueSeconds);
    const overdue = await this.db.all("SELECT * FROM games WHERE status IN ('waiting','active') AND due_at<=? ORDER BY due_at LIMIT 6",this.now);
    for (const game of overdue) {
      if (game.status === 'waiting') {
        await this.cancel(game.id);
        continue;
      }
      const state = JSON.parse(game.state);
      const seats = (await this.members(game.id)).map(row => row.user_id);
      if (state.phase === 'bam') {
        playAction(state,state.turn,'bam',0);
        runBots(state,seats);
      } else {
        finishGame(state,1-state.turn%2,'timeout');
      }
      await this.save(game,state,seats);
    }
  }

  async act(actor, gameId, version, action, value) {
    const game = await this.current(actor);
    if (!game || game.id !== gameId || game.status !== 'active') throw new GameError('این میز دیگر فعال نیست. «میز من» را باز کن.');
    if (game.due_at <= this.now) throw new GameError('زمان این نوبت تمام شده. میز را دوباره باز کن.');
    const members = await this.members(gameId);
    const seats = members.map(row => row.user_id);
    const seat = seats.indexOf(actor);
    const state = JSON.parse(game.state);
    if (action === 'vote') {
      if (version !== state.round) throw new GameError('این رأی برای دست قبلی بود.');
      const before = state.v;
      voteRedeal(state,seat);
      await this.save(game,state,seats,before !== state.v);
      return;
    }
    if (version !== state.v) {
      await this.notices.table(gameId,actor);
      throw new GameError('میز به‌روز شد. با دکمه‌های آخرین پیام ادامه بده.');
    }
    if (action === 'resign') finishGame(state,1-seat%2,'resign');
    else {
      playAction(state,seat,action,value);
      runBots(state,seats);
    }
    await this.save(game,state,seats);
  }

  async save(game, state, seats, progress = true) {
    if (state.phase !== 'ended') {
      const due = progress ? this.now + turnSeconds : game.due_at;
      await this.db.run('UPDATE games SET state=?,due_at=? WHERE id=?',JSON.stringify(state),due,game.id);
    } else {
      await this.db.run("UPDATE games SET status='ended',state=?,ended_at=?,due_at=NULL WHERE id=?",JSON.stringify(state),this.now,game.id);
      if (game.mode !== 'practice' && state.winner !== null) {
        const ranked = Number(game.mode === 'ranked' && ['score','bam'].includes(state.reason));
        const keys = Object.keys(periodNames).map(type => periodStart(type,this.now));
        for (const [seat,user] of seats.entries()) {
          await this.db.run('INSERT INTO results VALUES(?,?,?,?,?,?,?,?)',game.id,user,Number(seat%2 === state.winner),ranked,this.now,...keys);
        }
      }
    }
    await this.notify(game.id,seats);
  }

  async notify(game, seats = null) {
    const users = seats ?? (await this.members(game)).map(row => row.user_id);
    for (const user of users) if (user !== null) await this.notices.table(game,user);
  }

  async board(kind, boundary, user = null, limit = 10) {
    if (!Object.hasOwn(periodNames,kind)) throw new Error('Invalid leaderboard period');
    const where = user === null ? '' : ' WHERE user_id=?';
    const args = user === null ? [boundary,limit] : [boundary,user,limit];
    return this.db.all('WITH stats AS (' +
      'SELECT user_id,SUM(won) wins,SUM(1-won) losses,MIN(CASE WHEN won=1 THEN finished_at END) first_win ' +
      'FROM results WHERE ranked=1 AND ' + kind + '=? GROUP BY user_id),' +
      ' ranks AS (SELECT stats.*,ROW_NUMBER() OVER(ORDER BY wins DESC,losses ASC,first_win ASC,user_id ASC) position FROM stats) ' +
      'SELECT * FROM ranks JOIN users ON users.id=ranks.user_id' + where + ' ORDER BY position LIMIT ?',...args);
  }

  async prepareGifts() {
    for (const kind of Object.keys(periodNames)) {
      const periods = await this.db.all('SELECT DISTINCT r.'+kind+' period FROM results r ' +
        'WHERE r.ranked=1 AND r.'+kind+'<? AND NOT EXISTS(SELECT 1 FROM rewards a WHERE a.period=? AND a.period_start=r.'+kind+') ' +
        'ORDER BY r.'+kind+' DESC LIMIT 30',periodStart(kind,this.now),kind);
      for (const period of periods) {
        for (const winner of await this.board(kind,period.period,null,3)) {
          const rank = winner.position;
          await this.db.run('INSERT OR IGNORE INTO rewards(period,period_start,rank,user_id,cost,updated_at) VALUES(?,?,?,?,?,?)',
            kind,period.period,rank,winner.user_id,giftCosts[rank-1],this.now);
        }
      }
    }
  }
}

export const playerName = profile => profile.nickname || profile.name || 'بازیکن';
