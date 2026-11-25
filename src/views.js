import { escape, fa, periodNames, periodStart, periodTitle, shortText, stamp, timeLabel } from './core.js';
import { canRulerRedeal, cardLabel, legalCards, SUIT_NAMES, SUITS, suit, voteOpen } from './game.js';
import { paymentLabels, themes } from './payments.js';
import { modes, playerName } from './tables.js';

export function button(text, callback_data, style = null) {
  return { text,callback_data,...(style ? {style} : {}) };
}
export const home = () => button('⌂ منوی اصلی','home');

export class Views {
  constructor({db,tables,payments,config,now}) { Object.assign(this,{db,tables,payments,config,now}); }

  main(user) {
    const theme = themes[user.theme] ?? themes.classic;
    const color = user.theme === 'emerald' ? 'success' : 'primary';
    return [
      theme.icon+' <b>میز حکم</b>\n\n'+escape(playerName(user))+'، خوش اومدی! میز بعدی‌ات همین‌جاست.',
      [
        [button('🂡 شروع بازی','play',color)],
        [button('♠️ میز من','table','success'),button('🏆 رتبه‌بندی','board:day:0','primary')],
        [button('✉️ دوستان','friends'),button('👤 پروفایل','profile')],
        [button(this.payments.enabled ? '⭐ کیف پول و تم‌ها' : '🎨 تم‌های میز','wallet','primary')],
        [button('📖 قوانین','help'),button('💬 بازخورد','feedback')],
      ],
    ];
  }

  modes() {
    return [
      '🂡 <b>چه میزی می‌خوای؟</b>\n\nرقابتی · حریف‌یابی و ثبت نتیجه در جدول\nخصوصی · بازی با لینک یا دعوت مستقیم\nتمرینی · بازی با سه ربات به‌محض ورود',
      [[button('⚡ پیدا کردن حریف','queue','success')],[button('🔗 ساخت میز خصوصی','room','primary')],
        [button('🤖 تمرین با ربات‌ها','practice','primary')],[button('♠️ میز من','table'),home()]],
    ];
  }

  async profile(user) {
    const stats = await this.db.one('SELECT COALESCE(SUM(won),0) wins,COALESCE(SUM(1-won),0) losses FROM results WHERE user_id=?',user.id);
    const ranks = [];
    for (const [kind,name] of Object.entries(periodNames)) {
      const [row] = await this.tables.board(kind,periodStart(kind,this.now),user.id,1);
      ranks.push(name+' '+(row ? 'رتبهٔ '+fa(row.position) : '—'));
    }
    const count = stats.wins + stats.losses;
    const rate = count ? fa(Math.round(stats.wins*100/count))+'٪' : '—';
    const theme = themes[user.theme] ?? themes.classic;
    const alias = user.alias ? '<code>'+escape(user.alias)+'</code>' : 'هنوز انتخاب نشده';
    const text = theme.icon+' <b>'+escape(playerName(user))+'</b>\n'+(user.bio ? escape(user.bio)+'\n' : '')+'\n'+
      'نام کاربری میز حکم  '+alias+'\nشناسهٔ تلگرام  <code>'+user.id+'</code>\nتم فعال  '+theme.name+'\n\n'+
      'برد  '+fa(stats.wins)+'  •  باخت  '+fa(stats.losses)+'  •  نرخ برد  '+rate+'\n'+ranks.join('  |  ');
    return [text,[
      [button('✏️ نام نمایشی','edit:nickname'),button('🔖 نام کاربری','edit:alias')],
      [button('📝 دربارهٔ من','edit:bio'),button('📊 آخرین بازی‌ها','history')],[button('🎨 ظاهر میز','wallet','primary'),home()],
    ]];
  }

  async history(user) {
    const matches = await this.db.all('SELECT r.*,g.mode FROM results r JOIN games g ON g.id=r.game_id WHERE r.user_id=? ' +
      'ORDER BY r.finished_at DESC,r.game_id DESC LIMIT 10',user);
    const lines = matches.map(m => (m.won ? '✅ برد' : '✖️ باخت')+' · '+modes[m.mode]+' · '+stamp(m.finished_at));
    return ['📊 <b>آخرین بازی‌ها</b>\n\n'+(lines.join('\n') || 'هنوز نتیجه‌ای ثبت نشده.'),[[button('پروفایل','profile'),home()]]];
  }

  async board(user, kind, previous) {
    let key = periodStart(kind,this.now);
    if (previous) key = periodStart(kind,key-1);
    const players = await this.tables.board(kind,key);
    const [mine] = await this.tables.board(kind,key,user,1);
    const medals = {1:'🥇',2:'🥈',3:'🥉'};
    const rows = players.map(row => {
      const name = escape(playerName(row));
      return (medals[row.position] ?? fa(row.position)+' •')+' '+(row.user_id === user ? '<b>'+name+'</b>' : name)+
        '  ·  '+fa(row.wins)+' برد، '+fa(row.losses)+' باخت';
    });
    let text = '🏆 <b>جدول '+periodNames[kind]+'</b> · '+periodTitle(kind,key)+'\n\n'+
      (rows.join('\n') || 'هنوز نتیجهٔ رقابتی کاملی در این بازه ثبت نشده.')+'\n\n'+
      (mine ? 'رتبهٔ تو  <b>'+fa(mine.position)+'</b>' : 'رتبهٔ تو  —');
    if (this.payments.enabled && await this.db.flag('rewards_open')) {
      text += '\n\n🎁 گیفت‌های رتبه‌های ۱ تا ۳ به قیمت ۵۰، ۲۵ و ۱۵ استارز. ارسال بعد از پایان بازه با تأیید مدیر.';
    }
    const tabs = Object.entries(periodNames).map(([key,label]) => button(label,'board:'+key+':'+Number(previous),key === kind ? 'primary' : null));
    return [text,[tabs,[button(previous ? 'بازهٔ جاری' : 'بازهٔ قبلی','board:'+kind+':'+Number(!previous))],[home()]]];
  }

  async wallet(user) {
    if (!this.payments.enabled) {
      return this.store(await this.db.one('SELECT * FROM users WHERE id=?',user));
    }
    await this.payments.expire();
    const net = await this.db.scalar("SELECT COALESCE(SUM(stars),0) FROM invoices WHERE user_id=? AND status='paid'",user);
    const orders = await this.db.all('SELECT * FROM invoices WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 6',user);
    const extra = await this.db.all('SELECT c.* FROM charges c LEFT JOIN invoices i ON i.primary_charge=c.id ' +
      'WHERE c.user_id=? AND i.id IS NULL ORDER BY c.created_at DESC LIMIT 3',user);
    let text = '⭐ <b>کیف پول میز حکم</b>\n\nپرداخت‌های تم  <b>'+fa(net)+' استارز</b>\n';
    for (const order of orders) {
      text += '\n'+themes[order.sku].name+' · '+fa(order.stars)+' ⭐ · '+paymentLabels[order.status]+
        '\n<code>'+order.id.slice(0,10)+'</code> · '+stamp(order.created_at)+'\n';
    }
    for (const charge of extra) text += '\n'+fa(charge.total)+' ⭐ · '+paymentLabels[charge.status]+'\n';
    if (!orders.length && !extra.length) text += '\nهنوز رسیدی نداری.';
    return [text,[[button('🎨 تم‌های میز و پروفایل','store','primary')],[button('💬 پشتیبانی پرداخت','paysupport'),home()]]];
  }

  async store(user) {
    const open = this.payments.enabled && await this.db.flag('store_open');
    const rows = [];
    for (const [sku,item] of Object.entries(themes)) {
      if (user.theme === sku) rows.push([button('✓ '+item.name+' · فعال','store')]);
      else if (await this.payments.owned(user.id,sku)) rows.push([button(item.icon+' فعال کن · '+item.name,'theme:'+sku,'success')]);
      else if (open) rows.push([button(item.icon+' '+item.name+' · '+fa(item.stars)+' ⭐','buy:'+sku,'primary')]);
    }
    rows.push(this.payments.enabled ? [button('کیف پول','wallet'),home()] : [home()]);
    const details = this.payments.enabled ? (open ? '' : '\n\nصدور فاکتور جدید غیرفعال است.') : '\n\nهمهٔ تم‌های این نسخه رایگان‌اند.';
    return ['🎨 <b>تم‌های میز حکم</b>\n\nتم دلخواهت را برای ظاهر پروفایل و میز انتخاب کن.'+details,rows];
  }

  async friends(user) {
    const invites = await this.db.all("SELECT g.code,u.name,u.nickname FROM invites i JOIN games g ON g.id=i.game_id " +
      "JOIN users u ON u.id=i.from_id WHERE i.user_id=? AND g.status='waiting' AND g.due_at>? ORDER BY i.created_at DESC LIMIT 5",user,this.now);
    const rows = [[button('🔍 جستجوی بازیکن','search','primary')],[button('🔗 ساخت میز و لینک دعوت','room','success')]];
    for (const invitation of invites) rows.push([button('✉️ دعوت '+shortText(playerName(invitation),38),'join:'+invitation.code)]);
    rows.push([home()]);
    return ['✉️ <b>دعوت به میز</b>\n\nدوستت را با شناسهٔ عددی تلگرام، ‎@username یا نام کاربری میز حکم پیدا کن.',rows];
  }

  help() {
    return [
      '📖 <b>قوانین حکم چهارنفره</b>\n\n'+
      '• یارها روبه‌روی هم‌اند. آس اول حاکم و آس اولِ بازیکن دیگر، یار او را مشخص می‌کند.\n'+
      '• بعد از کوپ، همه پنج برگ می‌گیرند. حاکم خال حکم را انتخاب می‌کند و دو بستهٔ چهارتایی می‌رسد.\n'+
      '• حاکم دور اول را باز می‌کند. تا خال زمینه را داری باید همان را بازی کنی. حکم از خال‌های دیگر بالاتر است. آس بالاترینِ هر خال است.\n'+
      '• برندهٔ هر دست، دست بعد را باز می‌کند. هفت دست یک دور را می‌برد. هفت امتیاز نتیجهٔ مسابقه را تعیین می‌کند.\n'+
      '• برد ۷ به ۰ کت است. کت عادی ۲ امتیاز دارد و کت کردن تیم حاکم ۳ امتیاز. تیم برنده می‌تواند برای برد ۱۳ به ۰ و بام ادامه دهد.\n'+
      '• حاکم با برد تیمش می‌ماند. اگر تیمش ببازد، حاکم به نفر بعد می‌رسد. هر نوبت ۵ دقیقه مهلت دارد.\n\n'+
      '<a href="https://fa.wikipedia.org/wiki/%D8%AD%DA%A9%D9%85_(%D8%A8%D8%A7%D8%B2%DB%8C)">مرجع قوانین حکم</a>',
      [[button('🎮 شروع بازی','play','primary'),home()]],
    ];
  }

  async table(gameId, user) {
    const game = await this.db.one('SELECT * FROM games WHERE id=?',gameId);
    if (!game) return null;
    const members = await this.tables.members(gameId);
    const me = members.find(row => row.user_id === user);
    if (!me) return null;
    const message = me.telegram_message;
    const names = Object.fromEntries(members.map(p => [p.seat,p.user_id === null ? 'ربات '+fa(p.seat+1) : playerName(p)]));
    const theme = themes[me.theme] ?? themes.classic;
    const title = theme.icon+' <b>'+(me.theme === 'royal' ? 'میز شاهانه' : 'میز')+' · '+modes[game.mode]+'</b> · '+fa(gameId);
    const primary = me.theme === 'emerald' ? 'success' : 'primary';
    if (game.status === 'cancelled') return [title+'\n\nمیز بسته شد.',[[button('میز تازه','play',primary),home()]],message];
    if (game.status === 'waiting') {
      const link = 'https://t.me/'+this.config.username+'?start=j_'+game.code;
      return [title+'\n\nبازیکن حاضر  '+fa(members.length)+' از ۴\n'+escape(Object.values(names).join(' · '))+'\n\n<code>'+escape(link)+'</code>',[
        [{text:'🔗 اشتراک لینک میز',url:'https://t.me/share/url?url='+encodeURIComponent(link),style:primary}],
        [button('🔍 پیدا کردن دوست','search'),button('خروج از میز','leave','danger')]],message];
    }
    const state = JSON.parse(game.state);
    const seat = me.seat;
    const team = seat%2;
    let text = title+'\nیار تو  <b>'+escape(names[(seat+2)%4])+'</b>\nحریف‌ها  '+
      escape(names[(seat+1)%4]+' و '+names[(seat+3)%4])+'\n\nامتیاز دورها  <b>'+
      fa(state.score[team])+' – '+fa(state.score[1-team])+'</b>  (شما – حریف)\n';
    if (game.status === 'ended') {
      const reasons = {bam:'بام · ۱۳ دست پیاپی',timeout:'پایان مهلت نوبت',resign:'انصراف بازیکن',score:'پایان امتیازهای مسابقه'};
      text += '\n'+(state.winner === team ? '🏅 <b>تیم تو برنده شد!</b>' : '♠️ <b>تیم حریف برنده شد.</b>')+'\n'+reasons[state.reason];
      return [text,[[button('بازی دوباره','play','success'),button('پروفایل','profile')],[home()]],message];
    }
    if (state.lastRound) {
      text += (state.lastRound.team === team ? 'دور قبلی برای شما' : 'دور قبلی برای حریف')+' · '+fa(state.lastRound.points)+' امتیاز\n';
    }
    text += 'حاکم  '+escape(names[state.ruler])+' · حکم  '+(state.trump === null ? '—' : SUITS[state.trump]+' '+SUIT_NAMES[state.trump])+'\n';
    if (state.notice) text += '\n'+escape(state.notice)+'\n';
    if (['play','bam'].includes(state.phase)) {
      text += 'دست‌های همین دور  '+fa(state.tricks[team])+' – '+fa(state.tricks[1-team])+'\n';
      if (state.trick.length) {
        text += 'زمین  '+state.trick.map(([s,c]) => escape(names[s])+' <code>'+cardLabel(c)+'</code>').join(' · ')+'\n';
      } else if (state.lastWinner !== null) text += 'دست قبلی برای '+escape(names[state.lastWinner])+'\n';
    }
    const mine = state.turn === seat;
    const phases = {cut:'کوپِ ورق',choose:'انتخاب خال حکم',bam:'انتخاب بام یا ثبت کت',play:'انداختن برگ'};
    text += '\n'+(mine ? '🟢 <b>نوبت توست</b>' : '⏳ نوبت '+escape(names[state.turn]))+' · '+phases[state.phase]+
      '\nتا ساعت '+timeLabel(game.due_at)+' به وقت تهران';
    const hand = state.phase === 'choose' && seat !== state.ruler ? [] : state.hands[seat];
    if (hand.length) text += '\n\nبرگ‌های تو  <code>'+[...hand].sort((a,b) => a-b).map(cardLabel).join('  ')+'</code>';
    const action = 'act:'+gameId+':'+state.v+':';
    const rows = [];
    if (mine) {
      switch (state.phase) {
        case 'cut':
          rows.push([button('ربع',action+'cut:13'),button('وسط',action+'cut:26',primary),button('سه‌چهارم',action+'cut:39')],
            [button('قبول بر · بدون کوپ',action+'cut:0')]);
          break;
        case 'choose':
          rows.push(SUITS.map((mark,i) => button(mark+' '+SUIT_NAMES[i],action+'trump:'+i,[1,3].includes(i) ? 'danger' : primary)));
          if (canRulerRedeal(state)) rows.push([button('درخواست پخش دوباره',action+'redeal:0')]);
          break;
        case 'bam':
          rows.push([button('ثبت کت',action+'bam:0','success'),button('ادامه برای بام',action+'bam:1',primary)]);
          break;
        case 'play': {
          const cards = [...legalCards(state,seat)].sort((a,b) => a-b);
          const buttons = cards.map(c => button(cardLabel(c),action+'card:'+c,
            suit(c) === state.trump ? 'success' : [1,3].includes(suit(c)) ? 'danger' : primary));
          for (let i=0; i<buttons.length; i+=4) rows.push(buttons.slice(i,i+4));
          break;
        }
      }
    }
    if (voteOpen(state) && !state.votes.includes(seat)) rows.push([button('رأی به پخش دوباره','act:'+gameId+':'+state.round+':vote:0')]);
    rows.push([home(),button('انصراف','leave','danger')]);
    return [text,rows,message];
  }
}
