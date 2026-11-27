const escapeMap = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
export const text = value => String(value ?? '').replace(/[&<>"']/g,char => escapeMap[char]);
export const fa = value => String(value).replace(/[0-9]/g,digit => '۰۱۲۳۴۵۶۷۸۹'[digit]);

const suits = ['♠','♥','♣','♦'];
const suitNames = ['پیک','دل','گشنیز','خشت'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const modeNames = { ranked:'رقابتی',practice:'تمرینی',private:'خصوصی' };
const periods = { day:'روزانه',week:'هفتگی',month:'ماهانه' };
const seatPlaces = ['south','east','north','west'];
const title = (heading, extra = '') => '<div class="page-title"><h1>'+heading+'</h1>'+extra+'</div>';
export const activeTable = table => table && ['waiting','active'].includes(table.status);
const button = (label, action, style = '', extra = '') =>
  '<button class="button '+style+'" type="button" data-action="'+action+'" '+extra+'>'+label+'</button>';
const quiet = (label, action) => '<button class="text-button" type="button" data-action="'+action+'">'+label+'</button>';

export function loading(label = 'در حال دریافت…') {
  return '<div class="loading"><span aria-hidden="true">♠</span><p>'+text(label)+'</p></div>';
}

function mode(icon, label, description, action) {
  return `<button class="mode" type="button" data-action="${action}">
    <span class="mode-icon" aria-hidden="true">${icon}</span><span><strong>${label}</strong>
    <small>${description}</small></span><span class="mode-arrow" aria-hidden="true">‹</span>
  </button>`;
}

export function access(state) {
  const validBot = /^[A-Za-z0-9_]{5,32}$/.test(state.bot ?? '');
  const entry = state.joinCode ? '?start=j_'+state.joinCode : '';
  const link = validBot
    ? '<a class="button primary" href="https://t.me/'+state.bot+entry+'">باز کردن در تلگرام</a>'
    : '<p class="muted">از گفت‌وگوی میز حکم در تلگرام، دکمهٔ «بازی حکم» را بزن.</p>';
  const message = state.error || 'برای بازی، میز حکم را از داخل تلگرام باز کن.';
  const retry = state.canRetry ? button('تلاش دوباره','retry','primary') : link;
  return '<section class="inline-message"><p>'+text(message)+'</p>'+retry+'</section>';
}

export function lobby(state) {
  const primary = activeTable(state.table) ? button('ادامهٔ میز','show-table','primary')
    : button('تمرین با ربات‌ها','practice','primary');
  const queue = state.queue ? `<section class="panel queue">
      <div class="turnbar"><h2>در صف حریف‌یابی</h2><span class="timer" data-deadline="${state.queue.expiresAt}"></span></div>
      <p class="muted">${fa(state.queue.count)} نفر از ۴ نفر آماده‌اند. با تکمیل صف، میز باز می‌شود.</p>
      ${button('خروج از صف','unqueue')}
    </section>` : '';
  return `<section class="hero">
      <h1>حکم را تو تعیین کن.</h1>
      <p>چراغ‌های تالار روشن است و چهار صندلی منتظر بازیکن‌اند.</p>
      <div class="hero-actions">${primary}${quiet('داستان تالار','story')}</div>
    </section>
    ${state.user ? queue : state.boot === 'loading' ? loading('در حال اتصال به تلگرام…') : access(state)}
    <section>
      <div class="section-title"><h2>انتخاب میز</h2>${quiet('راهنمای بازی','rules')}</div>
      <div class="modes">
        ${mode('♛','بازی رقابتی','حریف‌یابی و ثبت نتیجه','queue')}
        ${mode('♣','میز دوستانه','ساخت یا ورود با کد دعوت','friends')}
        ${mode('♦','تمرین آزاد','بازی با سه ربات','practice')}
      </div>
    </section>`;
}

export function emptyTable(state) {
  if (!state.user) return title('میز من')+access(state);
  if (state.queue) return title('میز من')+`<section class="panel empty">
    <strong>در صف حریف‌یابی هستی</strong><p class="muted">${fa(state.queue.count)} بازیکن از ۴ نفر</p>
    <span class="timer" data-deadline="${state.queue.expiresAt}"></span>
    ${button('خروج از صف','unqueue')}
  </section>`;
  return title('میز من')+'<section class="panel empty"><p>میز فعالی نداری.</p>'+button('انتخاب میز','show-lobby','primary')+'</section>';
}

function waiting(table) {
  const seats = Array.from({length:4},(_,seat) => {
    const player = table.players.find(item => item.seat === seat);
    const name = player ? (seat === table.seat ? 'شما' : text(player.name)) : 'صندلی خالی';
    return '<div class="waiting-seat"><span aria-hidden="true">'+(player ? suits[seat] : '◇')+'</span><strong>'+name+'</strong></div>';
  }).join('');
  return `${title('میز دوستانه',quiet('خروج از میز','leave-check'))}
    <section class="panel">
      <div class="section-title"><h2>${fa(table.players.length)} نفر از ۴ نفر</h2><span class="timer" data-deadline="${table.dueAt}"></span></div>
      <div class="waiting-seats">${seats}</div>
      <p class="muted">بازی با نشستن نفر چهارم شروع می‌شود.</p>
      <label class="subhead">کد دعوت<input class="join-code" value="${text(table.code)}" readonly></label>
      <div class="actions">
        ${button('اشتراک لینک','share','primary')}${button('کپی کد','copy')}${button('دعوت بازیکن','friends')}
      </div>
    </section>`;
}

function card(cardId, { classes = '', pick = null, trump = null } = {}) {
  const suit = Math.floor(cardId/13);
  const rank = ranks[cardId%13];
  const mark = suits[suit];
  const label = rank+' '+suitNames[suit]+(suit === trump ? '، حکم' : '');
  const classesWithSuit = 'card '+classes+([1,3].includes(suit) ? ' red' : '')+(suit === trump ? ' trump-card' : '');
  const content = `<span class="rank" aria-hidden="true">${rank}</span><span aria-hidden="true">${mark}</span>
    <span class="rank-mirror" aria-hidden="true">${rank}</span>`;
  if (pick === null) return `<div class="${classesWithSuit}" role="img" aria-label="${label}">${content}</div>`;
  return `<button class="${classesWithSuit} ${pick ? 'pick' : ''}" type="button" data-action="move" data-move="card"
    data-value="${cardId}" aria-label="${label}" ${pick ? '' : 'disabled'}>${content}</button>`;
}

function score(table) {
  const team = table.seat%2;
  const trump = table.trump === null ? 'تعیین نشده' : suits[table.trump]+' '+suitNames[table.trump];
  return `<section class="scoreboard" aria-label="امتیاز و حکم">
    <div class="score-team"><small>تیم شما</small><strong>${fa(table.score[team])}</strong><small>دست ${fa(table.tricks[team])}</small></div>
    <div class="score-round"><small>دور ${fa(table.round)}</small><b>حکم ${trump}</b></div>
    <div class="score-team"><small>تیم حریف</small><strong>${fa(table.score[1-team])}</strong><small>دست ${fa(table.tricks[1-team])}</small></div>
  </section>`;
}

const place = (seat, me) => seatPlaces[(seat-me+4)%4];
function arena(table) {
  const players = table.players.map(player => {
    const position = place(player.seat,table.seat);
    const name = player.seat === table.seat ? 'شما' : text(player.name);
    const role = player.seat === table.ruler ? 'حاکم' : player.seat%2 === table.seat%2 ? 'تیم شما' : 'حریف';
    const turn = table.turn === player.seat;
    return `<div class="seat ${position}${turn ? ' now' : ''}">
      <strong title="${name}">${name}</strong><small>${role}${turn ? ' · نوبت' : ''}</small>
    </div>`;
  }).join('');
  const played = table.trick.map(([seat,id]) => card(id,{ classes:place(seat,table.seat),trump:table.trump })).join('');
  return '<section class="arena" aria-label="میز بازی"><div class="felt" aria-hidden="true"></div>'+
    players+'<div class="pile" aria-label="برگ‌های روی زمین">'+played+'</div></section>';
}

export function previousTrick(table) {
  const winner = table.players.find(player => player.seat === table.lastTrick.winner);
  return '<p>برندهٔ دست '+text(winner?.name)+' بود.</p><div class="hand-cards">'+
    table.lastTrick.cards.map(([,id]) => card(id)).join('')+'</div>';
}

const move = (label, name, value, style = '') => button(label,'move',style,'data-move="'+name+'" data-value="'+value+'"');
function turnControls(table) {
  if (table.turn !== table.seat) return '';
  switch (table.phase) {
    case 'cut':
      return '<div class="actions">'+move('ربع','cut',13)+move('وسط','cut',26,'primary')+
        move('سه‌چهارم','cut',39)+move('بدون کوپ','cut',0)+'</div>';
    case 'choose':
      return '<div class="trump-picker">'+suits.map((mark,index) =>
        move('<b>'+mark+'</b> '+suitNames[index],'trump',index,index%2 ? 'danger' : 'primary')).join('')+
        '</div>'+(table.redeal ? move('پخش دوباره','redeal',0) : '');
    case 'bam':
      return '<div class="actions">'+move('ثبت کت','bam',0,'primary')+move('ادامه برای بام','bam',1)+'</div>';
    default: return '';
  }
}

function finish(table) {
  if (table.status === 'cancelled') return title('میز بسته شد')+
    '<section class="panel empty"><p>این میز خصوصی پایان یافت.</p>'+button('انتخاب میز تازه','show-lobby','primary')+'</section>';
  const won = table.winner === table.seat%2;
  const reasons = { bam:'بام · ۱۳ دست پیاپی',timeout:'پایان مهلت نوبت',resign:'انصراف بازیکن',score:'پایان امتیازهای مسابقه' };
  const again = table.mode === 'practice' ? button('تمرین دوباره','practice','primary') : button('انتخاب میز تازه','show-lobby','primary');
  return `${title('نتیجهٔ بازی')}${score(table)}
    <section class="panel finish">
      <span class="medallion result-medal" aria-hidden="true">${won ? '♛' : '♠'}</span>
      <h2>${won ? 'تیم شما برد!' : 'تیم حریف برد.'}</h2><p class="muted">${reasons[table.reason] ?? ''}</p>
      ${again}
    </section>`;
}

export function tableView(table) {
  if (table.status === 'waiting') return waiting(table);
  if (table.status !== 'active') return finish(table);
  const myTurn = table.turn === table.seat;
  const player = table.players.find(player => player.seat === table.turn);
  const phases = { cut:'کوپ ورق',choose:'انتخاب خال حکم',play:'انداختن برگ',bam:'ثبت کت یا بام' };
  const instruction = myTurn ? 'نوبت توست' : 'نوبت '+text(player?.name);
  const hand = table.hand.length ? `<section class="panel hand">
    <div class="hand-heading"><h2>برگ‌های تو · ${fa(table.hand.length)}</h2>
    ${myTurn && table.phase === 'play' ? '<small class="good">یک برگ روشن را بزن</small>' : ''}</div>
    <div class="hand-cards">${table.hand.map(id => card(id,{ pick:table.legal.includes(id),trump:table.trump })).join('')}</div>
  </section>` : '';
  const controls = `<section class="panel">
      <div class="turnbar"><h2 class="${myTurn ? 'good' : ''}">${instruction}</h2>
      <span class="timer" data-deadline="${table.dueAt}" aria-label="زمان باقی‌مانده"></span></div>
      <p class="muted">${phases[table.phase]}</p>
      ${table.notice ? '<p class="inline-message">'+text(table.notice)+'</p>' : ''}
      ${turnControls(table)}
      ${table.vote ? move('رأی به پخش دوباره','vote',0) : ''}
      ${table.lastTrick ? quiet('دیدن دست قبلی','last-trick') : ''}
    </section>`;
  return title('میز '+modeNames[table.mode],quiet('انصراف','resign-check'))+score(table)+arena(table)+
    (table.phase === 'play' ? hand+controls : controls+hand);
}

export function rankings(board, period, previous) {
  const periodsMarkup = Object.entries(periods).map(([key,label]) =>
    button(label,'period','','data-period="'+key+'" aria-pressed="'+(period===key)+'"')).join('');
  const controls = '<div class="segment">'+periodsMarkup+'</div>';
  if (!board) return title('رتبه‌بندی')+controls+loading();
  const entries = board.rows.map(row => `<div class="row${row.mine ? ' mine' : ''}">
    <span class="position">${fa(row.rank)}</span><div class="title"><strong>${text(row.name)}</strong></div>
    <small>${fa(row.wins)} برد · ${fa(row.losses)} باخت</small></div>`).join('');
  return `${title('رتبه‌بندی')}${controls}
    <section class="panel"><div class="section-title"><h2>${text(board.date)}</h2>
    ${quiet(previous ? 'بازهٔ جاری' : 'بازهٔ قبلی','previous')}</div>
    <p class="muted">رتبهٔ شما ${board.myRank ? fa(board.myRank) : '—'}</p>
    <div class="rows">${entries || '<p class="muted">در این بازه هنوز نتیجهٔ رقابتی ثبت نشده.</p>'}</div>
    ${board.gifts.length ? '<p class="muted">گیفت رتبه‌های ۱ تا ۳ · '+board.gifts.map(fa).join('، ')+' استارز پس از تأیید مدیر.</p>' : ''}
    </section>`;
}

export function profileView(profile) {
  if (!profile) return title('پروفایل')+loading();
  const { user,stats,styles,history,receipts } = profile;
  const total = Number(stats.wins)+Number(stats.losses);
  const rate = total ? fa(Math.round(100*stats.wins/total))+'٪' : '—';
  const recent = history.map(match => `<div class="row"><strong class="${match.won ? 'good' : 'bad'}">${match.won ? 'برد' : 'باخت'}</strong>
    <div class="title">${text(match.mode)}<small>${text(match.date)}</small></div></div>`).join('');
  const themes = styles.map(theme => {
    const current = user.theme === theme.sku;
    const attr = 'data-sku="'+text(theme.sku)+'"';
    let action = '<small>فروش بسته است</small>';
    if (current) action = '<small class="good">فعال</small>';
    else if (theme.owned) action = button('انتخاب','theme','',attr);
    else if (theme.storeOpen) action = button(fa(theme.stars)+' ★','purchase','',attr);
    return '<div class="row"><strong>'+text(theme.name)+'</strong>'+action+'</div>';
  }).join('');
  const invoices = receipts.map(order => `<div class="row"><div class="title">
    <strong>${text(order.title)} · ${fa(order.stars)} ★</strong>
    <small>${text(order.date)} · <bdi>${text(order.id)}</bdi></small></div><small>${text(order.status)}</small></div>`).join('');
  return `${title('پروفایل',quiet('ویرایش','edit-check'))}
    <section class="panel">
      <div class="profile-intro"><span class="medallion" aria-hidden="true">♠</span><div>
        <h2>${text(user.name)}</h2>${user.alias ? '<p class="alias"><bdi>@'+text(user.alias)+'</bdi></p>' : ''}
      </div></div>
      ${user.bio ? '<p class="pitch">'+text(user.bio)+'</p>' : ''}
      <div class="metrics">
        <div class="metric"><strong>${fa(stats.wins)}</strong><span>برد</span></div>
        <div class="metric"><strong>${fa(stats.losses)}</strong><span>باخت</span></div>
        <div class="metric"><strong>${rate}</strong><span>نرخ برد</span></div>
      </div>
    </section>
    <section class="panel"><h2>آخرین بازی‌ها</h2><div class="rows">${recent || '<p class="muted">هنوز نتیجه‌ای ثبت نشده.</p>'}</div></section>
    <section class="panel"><h2>ظاهر میز</h2><div class="rows">${themes}</div></section>
    ${profile.starsEnabled ? '<section class="panel"><h2>رسیدها</h2><div class="rows">'+(invoices || '<p class="muted">رسیدی ثبت نشده.</p>')+'</div></section>' : ''}
    <div class="actions">${quiet('بازخورد ناشناس','feedback')}${quiet('راهنمای بازی','rules')}</div>`;
}

export function friendRows(data) {
  return data.invites.map(invite => `<div class="row"><span class="title">دعوت ${text(invite.name)}</span>
    ${button('پیوستن','join','','data-code="'+text(invite.code)+'"')}</div>`).join('');
}
