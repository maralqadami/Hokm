import {
  access, activeTable, emptyTable, fa, friendRows, loading, lobby, previousTrick,
  profileView, rankings, tableView, text,
} from './views.js';

const tg = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const launch = tg?.initDataUnsafe?.start_param ?? params.get('tgWebAppStartParam') ?? '';
const rawCode = params.get('join') ?? /^j_([a-f0-9]{12})$/.exec(launch)?.[1];
const state = {
  boot:'loading', screen:'lobby', user:null, bot:null, table:null, queue:null,
  board:null, profile:null, period:'day', previous:false, clockOffset:0,
  error:'', canRetry:false, viewError:'', joinCode:/^[a-f0-9]{12}$/.test(rawCode) ? rawCode : '',
  busy:false,
};
const main = document.querySelector('#screen');
const avatar = document.querySelector('#avatar');
const sheet = document.querySelector('#sheet');
const sheetTitle = document.querySelector('#sheet-title');
const sheetContent = document.querySelector('#sheet-content');
const toast = document.querySelector('#toast');
let toastTimer;
let pollTimer;
let pollInFlight = false;
let revision = 0;
let viewRequest = 0;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; },4000);
}

function showSheet(title, markup) {
  sheetTitle.textContent = title;
  sheetContent.innerHTML = markup;
  if (!sheet.open) sheet.showModal();
  if (tg?.BackButton) tg.BackButton.show();
}

function closeSheet() {
  if (sheet.open) sheet.close();
}
sheet.addEventListener('close', () => tg?.BackButton?.hide());

const sheetButton = (label, action, attrs = '') =>
  '<button class="button primary" type="button" data-action="'+action+'" '+attrs+'>'+label+'</button>';

function updateClocks() {
  const now = Math.floor((Date.now()+state.clockOffset)/1000);
  for (const element of main.querySelectorAll('[data-deadline]')) {
    const left = Math.max(0,Number(element.dataset.deadline)-now);
    element.textContent = fa(Math.floor(left/60)+':'+String(left%60).padStart(2,'0'));
  }
}

function render() {
  const handScroll = main.querySelector('.hand-cards')?.scrollLeft ?? 0;
  let markup;
  if (state.screen === 'lobby') markup = lobby(state);
  else if (!state.user) markup = state.boot === 'loading' ? loading() : access(state);
  else if (state.viewError) {
    markup = '<section class="panel empty"><p>'+text(state.viewError)+'</p>'+sheetButton('تلاش دوباره','retry-view')+'</section>';
  } else if (state.screen === 'table') markup = state.table ? tableView(state.table) : emptyTable(state);
  else if (state.screen === 'rank') markup = rankings(state.board,state.period,state.previous);
  else markup = profileView(state.profile);

  main.innerHTML = markup;
  const hand = main.querySelector('.hand-cards');
  if (hand) hand.scrollLeft = handScroll;
  main.setAttribute('aria-busy',String(state.busy || state.boot === 'loading'));
  avatar.textContent = state.user ? Array.from(state.user.name.trim())[0] ?? '♣' : '♣';
  document.body.dataset.theme = state.user?.theme ?? 'classic';
  for (const nav of document.querySelectorAll('.dock [data-screen]')) {
    if (nav.dataset.screen === state.screen) nav.setAttribute('aria-current','page');
    else nav.removeAttribute('aria-current');
  }
  updateClocks();
}

async function request(action, payload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),12000);
  try {
    const getInfo = action === 'public';
    const response = await fetch('/api/miniapp',{
      method:getInfo ? 'GET' : 'POST',
      headers:getInfo ? {} : { 'Content-Type':'application/json', Authorization:'tma '+tg.initData },
      body:getInfo ? undefined : JSON.stringify({ action,...payload }),
      cache:'no-store', credentials:'omit', mode:'same-origin', signal:controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      const problem = new Error(data?.error ?? 'ارتباط با میز حکم کامل نشد. دوباره امتحان کن.');
      problem.status = response.status;
      throw problem;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function message(error) {
  return error.status ? error.message : 'ارتباط برقرار نشد. دوباره امتحان کن.';
}

function acceptSnapshot(data) {
  const old = JSON.stringify([state.table,state.queue]);
  const matched = state.queue && data.table?.status === 'active' && !activeTable(state.table);
  state.table = data.table;
  state.queue = data.queue;
  state.clockOffset = data.now*1000 - Date.now();
  if (matched) {
    state.screen = 'table';
    state.viewError = '';
    closeSheet();
    showToast('میز رقابتی آماده است.');
  }
  return old !== JSON.stringify([state.table,state.queue]);
}

function invalidate(error) {
  state.user = null;
  state.table = null;
  state.queue = null;
  state.boot = 'error';
  state.error = message(error);
  state.canRetry = false;
  closeSheet();
  render();
}

async function refreshState(announce = false) {
  if (pollInFlight || !state.user) return;
  pollInFlight = true;
  const current = revision;
  try {
    const data = await request('state',{ gameId:state.table?.id ?? null });
    if (revision !== current) return;
    if (acceptSnapshot(data) && ['lobby','table'].includes(state.screen)) render();
  } catch (error) {
    if (revision !== current) return;
    if (error.status === 401) invalidate(error);
    else if (announce) showToast(message(error));
  } finally {
    pollInFlight = false;
  }
}

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  const playing = activeTable(state.table);
  if (!state.user || state.busy || document.hidden || tg?.isActive === false || (!playing && !state.queue)) return;
  const interval = state.table?.mode === 'practice' ? 10000 : state.table?.status === 'active' ? 2600 : 4200;
  pollTimer = setTimeout(async () => {
    await refreshState();
    schedulePoll();
  },delay ?? interval);
}

async function loadView() {
  if (!state.user || !['rank','profile'].includes(state.screen)) return;
  const target = state.screen;
  const requestId = ++viewRequest;
  try {
    const data = target === 'profile' ? await request('profile') :
      await request('rank',{ period:state.period,previous:state.previous });
    if (requestId !== viewRequest || target !== state.screen) return;
    if (target === 'profile') {
      state.profile = data;
      state.user = data.user;
    } else state.board = data;
    state.viewError = '';
    render();
  } catch (error) {
    if (requestId !== viewRequest || target !== state.screen) return;
    if (error.status === 401) return invalidate(error);
    state.viewError = message(error);
    render();
  }
}

function openScreen(name) {
  closeSheet();
  viewRequest++;
  state.screen = name;
  state.viewError = '';
  render();
  window.scrollTo(0,0);
  if (name === 'rank' || name === 'profile') void loadView();
  if (name === 'table' && state.user) void refreshState(true);
}

async function boot() {
  state.boot = 'loading';
  state.error = '';
  render();
  try {
    if (!tg?.initData) {
      state.bot = (await request('public')).bot;
      state.boot = 'guest';
      return;
    }
    const data = await request('init');
    state.user = data.user;
    state.bot = data.bot;
    state.boot = 'ready';
    acceptSnapshot(data);
    const destination = params.get('view');
    if (['table','rank','profile'].includes(destination)) openScreen(destination);
    if (state.joinCode) {
      showSheet('دعوت به میز خصوصی',
        '<p>برای پیوستن به میز دوستت، دعوت را قبول کن.</p>'+
        sheetButton('پیوستن به میز','join','data-code="'+state.joinCode+'"'));
    } else if (['friends','rules','feedback'].includes(destination)) {
      void dispatch(destination,{});
    }
  } catch (error) {
    state.boot = 'error';
    state.error = message(error);
    state.canRetry = error.status !== 401;
  } finally {
    render();
    schedulePoll(500);
  }
}

function needPlayer() {
  if (state.user) return true;
  showSheet('ورود به میز حکم',access(state));
  return false;
}

async function run(action, payload, onDone) {
  if (!needPlayer() || state.busy) return;
  state.busy = true;
  revision++;
  main.setAttribute('aria-busy','true');
  try {
    const data = await request(action,payload);
    await onDone(data);
  } catch (error) {
    if (error.status === 401) invalidate(error);
    else {
      if (sheet.open) {
        let prompt = sheetContent.querySelector('[data-sheet-error]');
        if (!prompt) {
          prompt = document.createElement('p');
          prompt.className = 'inline-message bad';
          prompt.setAttribute('role','alert');
          prompt.dataset.sheetError = '';
          sheetContent.append(prompt);
        }
        prompt.textContent = message(error);
      } else showToast(message(error));
      if (error.status === 409 && ['move','queue','practice','room','leave','join'].includes(action)) {
        await refreshState();
      }
    }
  } finally {
    state.busy = false;
    main.setAttribute('aria-busy','false');
    schedulePoll();
  }
}

const playActions = new Set(['queue','unqueue','practice','room','join','leave','move','invite']);
function play(action, payload = {}) {
  if (['queue','practice','room'].includes(action) && activeTable(state.table)) {
    openScreen('table');
    return;
  }
  return run(action,payload,data => {
    const before = state.table;
    acceptSnapshot(data);
    if (action === 'invite') showToast('دعوت ثبت شد.');
    if (action === 'join') state.joinCode = '';
    if (data.table?.status === 'ended' && before?.status === 'active' && tg?.isVersionAtLeast?.('6.1')) {
      const won = data.table.winner === data.table.seat%2;
      tg.HapticFeedback?.notificationOccurred(won ? 'success' : 'warning');
    }
    if (action === 'move') {
      closeSheet();
      render();
    } else openScreen(['leave','unqueue'].includes(action) ? 'lobby' : 'table');
  });
}

function moveset(move, value) {
  const table = state.table;
  if (!table || table.status !== 'active') return;
  return play('move',{ gameId:table.id,version:move === 'vote' ? table.round : table.version,move,value:Number(value) });
}

async function showFriends() {
  if (!needPlayer()) return;
  showSheet('میز دوستانه',`
    <div class="actions">${sheetButton('ساخت میز خصوصی','room')}</div>
    <form data-form="join"><label>کد دعوت<input name="code" maxlength="12" required dir="ltr" autocomplete="off"
      autocapitalize="off" spellcheck="false" placeholder="کد ۱۲ نویسه‌ای"></label>
      <button class="button" type="submit">پیوستن با کد</button></form>
    <form data-form="search"><label>دعوت بازیکن<input name="query" maxlength="32" required dir="ltr"
      autocomplete="off" placeholder="نام کاربری یا شناسهٔ تلگرام"></label>
      <button class="button" type="submit">پیدا کردن بازیکن</button></form>
    <div class="rows" id="friend-result"></div><div class="rows" id="friend-invites"></div>`);
  const container = sheetContent.querySelector('#friend-invites');
  try {
    const data = await request('friends');
    if (container.isConnected) container.innerHTML = friendRows(data);
  } catch (error) {
    if (error.status === 401) return invalidate(error);
    if (container.isConnected) container.textContent = message(error);
  }
}

function showRules() {
  showSheet('راهنمای حکم',`<ul>
    <li>بازی با چهار نفر انجام می‌شود و یار تو روبه‌روی تو می‌نشیند. آس اول حاکم را مشخص می‌کند.</li>
    <li>بعد از کوپ، حاکم با دیدن پنج برگ اول، خال حکم را انتخاب می‌کند.</li>
    <li>اگر خال برگ اول را داری، باید همان خال را بازی کنی. برگ حکم از خال‌های دیگر بالاتر است.</li>
    <li>برندهٔ هر دست، دست بعد را شروع می‌کند. هفت دست یک دور و هفت امتیاز یک مسابقه را می‌برد.</li>
    <li>برد ۷ به ۰ «کت» است. تیم برنده می‌تواند برای برد ۱۳ به ۰ «بام» ادامه دهد.</li>
    <li>هر نوبت پنج دقیقه مهلت دارد. انصراف، برد را برای تیم مقابل ثبت می‌کند.</li>
  </ul>`);
}

function showStory() {
  showSheet('داستان تالار',`<img class="story-art" src="/mini/salon.webp" alt="">
    <p>در انتهای یک گذر قدیمی، هر شب یکی چراغ تالار را روشن می‌کند. چهار صندلی دور میز هست و کسی نمی‌داند آس اول به کدام دست می‌رسد.</p>
    <p>وقتی برگ‌ها پخش می‌شوند، داستان را حاکم و یارش می‌نویسند.</p>`);
}

function editProfile() {
  if (!state.profile) return;
  const fields = [['nickname','نام نمایشی',32],['alias','نام کاربری میز حکم',24],['bio','دربارهٔ من',110]];
  showSheet('ویرایش پروفایل',fields.map(([name,label,max]) => `<form data-form="edit" data-field="${name}">
    <label>${label}<input name="value" maxlength="${max}" value="${text(state.profile.user[name])}" ${name==='alias' ? 'dir="ltr"' : ''}></label>
    <button class="button" type="submit">ذخیرهٔ ${label}</button></form>`).join(''));
}

function setProfile(data) {
  viewRequest++;
  state.profile = data;
  state.user = data.user;
  closeSheet();
  render();
}

function purchase(sku) {
  if (!tg?.isVersionAtLeast?.('6.1') || !tg.openInvoice) {
    showToast('برای خرید تم، تلگرام را به‌روزرسانی کن.');
    return;
  }
  return run('purchase',{sku},data => {
    if (!/^https:\/\/t\.me\//.test(data.invoice)) return showToast('لینک فاکتور آماده نشد.');
    tg.openInvoice(data.invoice,status => {
      if (status === 'paid' || status === 'pending') {
        showToast('رسید پس از تأیید تلگرام در پروفایل ثبت می‌شود.');
        setTimeout(() => void loadView(),1500);
      } else if (status === 'failed') showToast('پرداخت کامل نشد.');
    });
  });
}

async function share() {
  const code = state.table?.code;
  if (!code || !/^[A-Za-z0-9_]{5,32}$/.test(state.bot ?? '')) return;
  const invite = 'https://t.me/'+state.bot+'?start=j_'+code;
  const link = 'https://t.me/share/url?'+new URLSearchParams({ url:invite,text:'بیا سر میز حکم.' });
  if (tg?.openTelegramLink) tg.openTelegramLink(link);
  else window.location.assign(link);
}

async function copyCode() {
  if (!state.table?.code) return;
  try {
    await navigator.clipboard.writeText(state.table.code);
    showToast('کد دعوت کپی شد.');
  } catch {
    const field = main.querySelector('.join-code');
    field?.focus();
    field?.select();
    showToast('کد انتخاب شد. از منوی گوشی کپی کن.');
  }
}

function dispatch(action, attrs) {
  switch (action) {
    case 'close': return closeSheet();
    case 'story': return showStory();
    case 'rules': return showRules();
    case 'retry': closeSheet(); return boot();
    case 'retry-view': state.viewError = ''; render(); return loadView();
    case 'show-table': return openScreen('table');
    case 'show-lobby': return openScreen('lobby');
    case 'friends': return showFriends();
    case 'join': return play('join',{ code:attrs.code });
    case 'invite': return play('invite',{ playerId:Number(attrs.playerId) });
    case 'move': return moveset(attrs.move,attrs.value);
    case 'leave': return play('leave',{ gameId:state.table?.id });
    case 'copy': return copyCode();
    case 'share': return share();
    case 'last-trick':
      if (state.table?.lastTrick) showSheet('دست قبلی',previousTrick(state.table));
      return;
    case 'leave-check':
      return showSheet('خروج از میز خصوصی','<p>با خروج میزبان، میز خصوصی بسته می‌شود.</p>'+sheetButton('تأیید خروج','leave'));
    case 'resign-check':
      return showSheet('انصراف از بازی','<p>با انصراف، برد برای تیم مقابل ثبت می‌شود.</p>'+
        sheetButton('تأیید انصراف','move','data-move="resign" data-value="0"'));
    case 'period':
    case 'previous':
      if (action === 'period') state.period = attrs.period;
      if (action === 'previous') state.previous = !state.previous;
      state.board = null;
      render();
      return loadView();
    case 'edit-check': return editProfile();
    case 'theme': return run('theme',{ sku:attrs.sku },setProfile);
    case 'purchase': return purchase(attrs.sku);
    case 'feedback':
      if (!needPlayer()) return;
      return showSheet('بازخورد ناشناس',`<form data-form="feedback">
        <label>پیشنهاد یا گزارش خطا<textarea name="message" minlength="4" maxlength="700" required></textarea></label>
        <button class="button primary" type="submit">ارسال بازخورد</button></form>`);
    default:
      if (playActions.has(action)) return play(action);
  }
}

document.addEventListener('click',event => {
  const control = event.target.closest('button[data-screen],button[data-action]');
  if (!control || control.disabled) return;
  if (control.dataset.screen) openScreen(control.dataset.screen);
  else void dispatch(control.dataset.action,control.dataset);
});

document.addEventListener('submit',event => {
  const form = event.target;
  const action = form.dataset.form;
  if (!action) return;
  event.preventDefault();
  const fields = new FormData(form);
  if (action === 'join') void play('join',{ code:fields.get('code') });
  if (action === 'edit') void run('edit',{ field:form.dataset.field,value:fields.get('value') },setProfile);
  if (action === 'feedback') void run('feedback',{ message:fields.get('message') },() => {
    closeSheet();
    showToast('بازخورد ثبت شد.');
  });
  if (action === 'search') void run('search',{ query:fields.get('query') },data => {
    const result = sheetContent.querySelector('#friend-result');
    if (!result) return;
    for (const error of sheetContent.querySelectorAll('[data-sheet-error]')) error.remove();
    result.innerHTML = '<div class="row"><strong class="title">'+text(data.friend.name)+'</strong>'+
      sheetButton('ارسال دعوت','invite','data-player-id="'+data.friend.id+'"')+'</div>';
  });
});

tg?.ready();
tg?.expand();
tg?.BackButton?.onClick(() => {
  if (sheet.open) closeSheet();
  else if (state.screen !== 'lobby') openScreen('lobby');
});
if (tg?.isVersionAtLeast?.('6.9')) {
  tg.setHeaderColor('#0d1815');
  tg.setBackgroundColor('#0b1512');
}
document.addEventListener('visibilitychange',() => schedulePoll(100));
if (tg?.isVersionAtLeast?.('8.0')) {
  tg.onEvent('activated',() => schedulePoll(100));
  tg.onEvent('deactivated',() => clearTimeout(pollTimer));
}
setInterval(updateClocks,1000);
void boot();
