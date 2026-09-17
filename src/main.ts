import './style.css';
import { supabase } from './supabase';

const app = document.querySelector<HTMLDivElement>('#app')!;
let uid = '', pair = '', members: any[] = [], expenses: any[] = [], balances: any[] = [], settlements: any[] = [];
let currentMonth = 'all'; 
let utilViewMode: 'trend' | 'average' = 'trend'; 
let currentTab = 'entry'; // 現在のタブを記憶してシームレスに切り替える

const getToday = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

const yen = (n: number) => `¥${Math.round(n).toLocaleString('ja-JP')}`;
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const fmtTime = (raw: string) => {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// iPhoneカレンダーに登録するためのICSファイルを生成
const getIcsUrl = (title: string, date: string) => {
  const d = date.replace(/-/g, '');
  const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:${d}\nDTEND;VALUE=DATE:${d}\nSUMMARY:${title}\nEND:VEVENT\nEND:VCALENDAR`;
  return `data:text/calendar;charset=utf8,${encodeURIComponent(ics)}`;
};

async function boot() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return authView();
  uid = session.user.id;
  const { data, error } = await supabase.from('pair_members').select('pair_id').eq('user_id', uid).maybeSingle();
  if (error) return fail(error.message);
  if (!data) return pairView();
  pair = data.pair_id;
  await load();
  render(); 
}

function authView(msg = '') {
  app.innerHTML = `<main class="app"><div class="brand" style="text-align: center; margin-bottom: 20px;">♥ PairPocket</div>${msg ? `<div class="notice">${esc(msg)}</div>` : ''}<div class="card"><h2>ふたりのお財布へ</h2><input id="email" class="field" type="email" placeholder="メール"><input id="pw" class="field" type="password" placeholder="パスワード"><div class="grid"><button id="up" class="ghost">新規登録</button><button id="in" class="primary">ログイン</button></div></div></main>`;
  q('#up').onclick = () => login(true);
  q('#in').onclick = () => login(false);
}

async function login(up: boolean) {
  const email = val('#email'), password = val('#pw');
  const r = up ? await supabase.auth.signUp({ email, password }) : await supabase.auth.signInWithPassword({ email, password });
  if (r.error) return authView(r.error.message);
  boot();
}

function pairView(msg = '') {
  app.innerHTML = `<main class="app"><div class="brand" style="text-align: center; margin-bottom: 20px;">♥ PairPocket</div>${msg ? `<div class="notice">${esc(msg)}</div>` : ''}<div class="card"><h2>ふたりの部屋を作る</h2><input id="pn" class="field" value="ふたりの家計"><button id="make" class="primary full">作成</button></div><div class="card"><h2>招待コードで参加</h2><input id="code" class="field"><button id="join" class="dark full">参加</button></div><button id="out" class="ghost full" style="margin-top: 15px;">ログアウト</button></main>`;
  q('#out').onclick = logout;
  q('#make').onclick = async () => {
    const { error } = await supabase.rpc('create_pair', { pair_name: val('#pn') });
    error ? pairView(error.message) : boot();
  };
  q('#join').onclick = async () => {
    const { error } = await supabase.rpc('join_pair', { input_invite_code: val('#code') });
    error ? pairView(error.message) : boot();
  };
}

async function load() {
  const [m, e, b, s] = await Promise.all([
    supabase.from('pair_members').select('user_id,role,profiles(display_name)').eq('pair_id', pair),
    supabase.from('expenses').select('*').eq('pair_id', pair), 
    supabase.from('pair_balances').select('*').eq('pair_id', pair),
    supabase.from('settlements').select('*').eq('pair_id', pair)
  ]);
  const er = m.error || e.error || b.error || s.error;
  if (er) return fail(er.message);
  members = m.data || [];
  expenses = e.data || [];
  balances = b.data || [];
  settlements = s.data || [];
}

// タブを超高速で切り替えるための関数（再描画しないのでラグゼロ！）
function setTab(tab: string) {
  currentTab = tab;
  ['entry', 'home', 'history', 'settings', 'utilities', 'schedule'].forEach(x => {
    const el = q('#sec-' + x);
    if (el) el.style.display = (x === tab) ? 'block' : 'none';
  });
  
  // スライドメニューを閉じる
  q('#menuDrawer')?.classList.add('hide');

  // 下のタブバーの色を更新
  document.querySelectorAll('.tabs button').forEach((b: any) => {
    if (['entry', 'home', 'history', 'settings'].includes(b.dataset.tab)) {
      b.style.fontWeight = b.dataset.tab === tab ? '900' : 'normal';
      b.style.color = b.dataset.tab === tab ? '#e7617d' : '#9b7783';
    }
  });
}

// 画面全体を作る関数（データが変更された時だけ呼ばれる）
async function render() {
  const { data: p } = await supabase.from('pairs').select('name,invite_code').eq('id', pair).single();
  const name = (id: string) => members.find(x => x.user_id === id)?.profiles?.display_name || balances.find(x => x.user_id === id)?.display_name || 'メンバー';
  
  let bals: Record<string, number> = {};
  members.forEach(m => bals[m.user_id] = 0);

  expenses.forEach(e => {
    if (typeof e.title === 'string' && e.title.startsWith('[削除済]')) return;
    const pId = e.payer_id;
    const oId = members.find(m => m.user_id !== pId)?.user_id;
    if (pId && bals[pId] !== undefined) bals[pId] += Number(e.amount);
    if (oId && bals[oId] !== undefined) bals[oId] -= Number(e.amount);
  });

  settlements.forEach(s => {
    const fId = s.from_user_id;
    const tId = s.to_user_id;
    if (fId && bals[fId] !== undefined) bals[fId] += Number(s.amount);
    if (tId && bals[tId] !== undefined) bals[tId] -= Number(s.amount);
  });

  let amount = 0;
  let receiver = members[0]?.user_id;
  let sender = members[1]?.user_id;

  if (members.length === 2) {
    const u1 = members[0].user_id;
    const u2 = members[1].user_id;
    if (bals[u1] > 0) {
      receiver = u1; sender = u2; amount = bals[u1];
    } else {
      receiver = u2; sender = u1; amount = Math.abs(bals[u2] || 0);
    }
  }

  const stateObj = { amount, sender, receiver };

  const months = Array.from(new Set([
    ...expenses.map(e => (e.expense_date || '').slice(0, 7)),
    ...settlements.map(s => new Date(s.settled_at).toISOString().slice(0, 7))
  ])).filter(Boolean).sort().reverse();

  const filteredExpenses = expenses.filter(e => currentMonth === 'all' || e.expense_date?.startsWith(currentMonth));
  const filteredSettlements = settlements.filter(s => currentMonth === 'all' || new Date(s.settled_at).toISOString().startsWith(currentMonth));
  const myName = members.find(m => m.user_id === uid)?.profiles?.display_name || '';
  
  const subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
  const utils = JSON.parse(localStorage.getItem(`utils_${pair}`) || '[]');
  const schedules = JSON.parse(localStorage.getItem(`sched_${pair}`) || '[]');

  // 水道・光熱費グラフの生成
  const utilsMap: Record<string, {water: number, energy: number}> = {};
  utils.forEach((u: any) => {
    if (!utilsMap[u.month]) utilsMap[u.month] = { water: 0, energy: 0 };
    if (u.type === 'water') utilsMap[u.month].water += Number(u.amount);
    if (u.type === 'energy') utilsMap[u.month].energy += Number(u.amount);
  });
  const sortedUtilMonths = Object.keys(utilsMap).sort();
  let maxUtilAmt = 1;
  sortedUtilMonths.forEach(m => {
    if (utilsMap[m].water > maxUtilAmt) maxUtilAmt = utilsMap[m].water;
    if (utilsMap[m].energy > maxUtilAmt) maxUtilAmt = utilsMap[m].energy;
  });

  let graphHtml = '';
  if (sortedUtilMonths.length === 0) {
    graphHtml = '<p class="muted" style="width:100%; text-align:center; padding: 20px 0;">データがありません</p>';
  } else if (utilViewMode === 'trend') {
    const width = 320; const height = 130;
    const padX = 30; const padY = 20;
    const usableW = width - padX * 2;
    const usableH = height - padY * 2;
    const step = sortedUtilMonths.length > 1 ? usableW / (sortedUtilMonths.length - 1) : usableW / 2;
    
    const waterPts = sortedUtilMonths.map((m, i) => `${sortedUtilMonths.length > 1 ? padX + i * step : padX + step},${height - padY - (utilsMap[m].water / maxUtilAmt) * usableH}`);
    const energyPts = sortedUtilMonths.map((m, i) => `${sortedUtilMonths.length > 1 ? padX + i * step : padX + step},${height - padY - (utilsMap[m].energy / maxUtilAmt) * usableH}`);

    const circlesHtml = sortedUtilMonths.map((m, i) => {
      const x = sortedUtilMonths.length > 1 ? padX + i * step : padX + step;
      const yw = height - padY - (utilsMap[m].water / maxUtilAmt) * usableH;
      const ye = height - padY - (utilsMap[m].energy / maxUtilAmt) * usableH;
      return `
        <circle cx="${x}" cy="${yw}" r="5" fill="#7ab8e6" stroke="#fff" stroke-width="2" />
        <circle cx="${x}" cy="${ye}" r="5" fill="#ffaa77" stroke="#fff" stroke-width="2" />
        <text x="${x}" y="${height - 2}" font-size="11" fill="#9b8d93" text-anchor="middle" font-weight="bold">${m.split('-')[1]}月</text>
      `;
    }).join('');

    graphHtml = `<div style="width: 100%; overflow-x: auto; padding-top: 5px;"><svg viewBox="0 0 ${width} ${height}" style="width: 100%; height: ${height}px; min-width: ${width}px; overflow: visible;"><polyline points="${waterPts.join(' ')}" fill="none" stroke="#7ab8e6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /><polyline points="${energyPts.join(' ')}" fill="none" stroke="#ffaa77" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />${circlesHtml}</svg></div>`;
  } else {
    let totalWater = 0; let totalEnergy = 0;
    sortedUtilMonths.forEach(m => { totalWater += utilsMap[m].water; totalEnergy += utilsMap[m].energy; });
    const avgWater = Math.round(totalWater / sortedUtilMonths.length);
    const avgEnergy = Math.round(totalEnergy / sortedUtilMonths.length);
    graphHtml = `<div style="padding: 15px 0; text-align: center;"><div class="muted" style="margin-bottom: 5px;">全期間の月平均</div><div style="font-size: 32px; font-weight: 850; color: #e7617d; margin-bottom: 20px;">${yen(avgWater + avgEnergy)}<span style="font-size:14px; font-weight:bold; color:#9b8d93;"> /月</span></div><div style="display: flex; justify-content: center; gap: 40px; margin-top: 15px;"><div><div style="color: #7ab8e6; font-size: 13px; font-weight: bold; margin-bottom: 4px;">水道代 平均</div><div style="font-size: 18px; font-weight: 800;">${yen(avgWater)}</div></div><div><div style="color: #ffaa77; font-size: 13px; font-weight: bold; margin-bottom: 4px;">光熱費 平均</div><div style="font-size: 18px; font-weight: 800;">${yen(avgEnergy)}</div></div></div></div>`;
  }

  // タイムライン構築
  const timeline: any[] = [];
  filteredExpenses.forEach(e => timeline.push({ type: 'expense', raw: e.created_at || (e.expense_date + 'T00:00:00Z'), data: e }));
  filteredSettlements.forEach(s => timeline.push({ type: 'settlement', raw: s.settled_at, data: s }));

  timeline.sort((a, b) => {
    const tA = new Date(a.raw).getTime(); const tB = new Date(b.raw).getTime();
    if (!isNaN(tA) && !isNaN(tB)) return tB - tA; return 0; 
  });

  let timelineHtml = '';
  timeline.forEach(item => {
    const tStr = fmtTime(item.raw); 
    if (item.type === 'settlement') {
      const s = item.data;
      timelineHtml += `<div style="border-top: 2px dashed #d95875; margin: 28px 0 20px; position: relative;">
        <span style="position: absolute; top: -11px; left: 50%; transform: translateX(-50%); background: #fff; padding: 0 12px; color: #d95875; font-size: 11px; font-weight: bold; white-space: nowrap; border-radius: 12px; border: 1px solid #d95875;">
          ✂️ 精算完了: ${yen(s.amount)} (${tStr})
        </span>
      </div>`;
    } else {
      const e = item.data;
      const isDel = typeof e.title === 'string' && e.title.startsWith('[削除済]');
      let displayTitle = e.title;
      let delName = '';
      if (isDel) {
        const parts = e.title.replace('[削除済] ', '').split('::');
        delName = name(parts[0]); 
        displayTitle = parts.slice(1).join('::');
      }

      timelineHtml += `<div class="expense ${isDel ? 'deleted-log' : ''}">
        <div class="expense-left">
          ${isDel ? `<del style="color:#b5a6ac;"><b class="break-text">${esc(displayTitle)}</b></del>` : `<b class="break-text">${esc(displayTitle)}</b>`}
          <div class="muted break-text" style="margin-top: 4px; font-size: 12px;">
            ${isDel ? `<span class="deleted-badge">削除者: ${esc(delName)}</span>` : ''}
            ${esc(name(e.payer_id))}・${tStr}
          </div>
        </div>
        <div class="expense-right">
          ${isDel ? `<del style="color:#b5a6ac;"><b>${yen(e.amount)}</b></del>` : `<b>${yen(e.amount)}</b>`}
          <div style="margin-top: 6px;">
            ${!isDel 
              ? `<button class="del ghost" data-id="${e.id}" style="padding: 4px 10px; font-size: 12px; color: #bf4f68; border-radius: 8px;">削除</button>` 
              : `<button class="restore ghost" data-id="${e.id}" style="padding: 4px 10px; font-size: 12px; color: #765d8b; border-radius: 8px;">戻す</button>`}
          </div>
        </div>
      </div>`;
    }
  });

  if (timeline.length === 0) timelineHtml = '<p class="muted" style="text-align: center; padding: 20px 0;">まだありません</p>';

  // HTMLの骨組み（これ以降は基本的に再構築せず、表示非表示だけ切り替える）
  app.innerHTML = `
    <main class="app">
      <div class="top" style="margin-top: 10px; position: relative;">
        <div><div class="brand">♥ PairPocket</div><div class="muted" style="margin-left: 2px;">${esc(p?.name || 'ふたりの家計')}</div></div>
        <button id="menuBtn" class="ghost" style="padding: 8px 14px; font-size: 20px; position: absolute; right: 0; top: 0; border-radius: 12px;">☰</button>
      </div>
      
      <!-- スライドメニュー（ドロワー） -->
      <div id="menuDrawer" class="hide" style="position: fixed; top: 0; right: 0; bottom: 0; left: 0; background: rgba(0,0,0,0.4); z-index: 9999; backdrop-filter: blur(2px);">
        <div style="position: absolute; top: 0; right: 0; bottom: 0; width: 260px; background: #fffcfc; padding: 20px; box-shadow: -4px 0 15px rgba(0,0,0,0.1);">
          <button id="closeDrawerBtn" class="ghost" style="position: absolute; top: max(20px, env(safe-area-inset-top)); right: 20px; border-radius: 50%; width: 40px; height: 40px; padding: 0; display:flex; align-items:center; justify-content:center; font-size: 20px;">×</button>
          <div style="margin-top: calc(max(20px, env(safe-area-inset-top)) + 50px);">
            <div class="muted" style="margin-bottom: 10px; font-weight: bold;">便利機能</div>
            <button data-nav="schedule" class="ghost full" style="margin-bottom: 12px; text-align: left; font-size: 16px; padding: 16px;"><span style="font-size: 20px; margin-right: 8px;">📅</span> ふたりの予定</button>
            <button data-nav="utilities" class="ghost full" style="margin-bottom: 12px; text-align: left; font-size: 16px; padding: 16px;"><span style="font-size: 20px; margin-right: 8px;">💧</span> 水道・光熱費</button>
          </div>
        </div>
      </div>

      <!-- 入力タブ -->
      <section id="sec-entry">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 15px; margin-bottom: 15px; padding: 0 4px;">
          <h2 style="margin: 0; font-size: 20px; color: #3e3438;">新しく追加</h2>
          <button id="saveTop" class="primary" style="padding: 12px 24px; font-size: 16px; border-radius: 20px; box-shadow: 0 4px 12px rgba(255, 130, 156, 0.4);">追加する</button>
        </div>

        ${subs.length > 0 ? `
          <div style="overflow-x: auto; white-space: nowrap; padding-bottom: 8px; margin-bottom: 15px;">
            ${subs.map((s:any) => `<div class="sub-fill-btn sub-chip" data-id="${s.id}">${esc(s.title)}</div>`).join('')}
          </div>
        ` : ''}

        <div class="card" style="margin-top: 0;">
          <label class="muted">相手への請求額</label>
          <div class="money" style="margin-top: 8px;">
            <span>¥</span>
            <input type="text" id="amount" inputmode="numeric" placeholder="1200+350">
          </div>
          
          <div class="calc-buttons">
            <button type="button" data-op="+">＋</button><button type="button" data-op="-">－</button>
            <button type="button" data-op="*">×</button><button type="button" data-op="/">÷</button>
          </div>

          <div id="result" class="result">計算結果：¥0</div>
          
          <div class="quick">
            <button data-plus="100">+100</button><button data-plus="500">+500</button>
            <button data-plus="1000">+1,000</button><button id="clear">クリア</button>
          </div>
          
          <button id="split" class="split">÷ 2人で割り勘</button>
          
          <label class="muted" style="margin-top: 20px; display: block;">立て替えた人</label>
          <div class="payer-buttons">${members.map((m) => `<button type="button" class="payer-btn ${m.user_id === uid ? 'selected' : ''}" data-payer="${m.user_id}">${esc(name(m.user_id))}</button>`).join('')}</div>
          <input id="payer" type="hidden" value="${uid}">
          
          <div style="border-top: 1px solid #f0dfe4; margin: 20px 0 15px;"></div>

          <label class="muted">内容（任意）</label>
          <input id="title" class="field" placeholder="例：カフェ、スーパー">
          
          <label class="muted">カテゴリー</label>
          <select id="cat" class="field">
            <option value="" selected>カテゴリーなし</option>
            ${['食費', '外食', '生活', '家賃', '光熱費', '交通', '娯楽', '旅行', 'その他'].map(x => `<option value="${x}">${x}</option>`).join('')}
          </select>
        </div>
      </section>

      <!-- 精算タブ -->
      <section id="sec-home">
        <div class="card hero" style="padding: 24px; text-align: center; margin-top: 20px;">
          <div class="muted" style="margin-bottom: 12px;">現在の精算</div>
          ${members.length < 2 ? '<h2>相手の参加待ち</h2>' : amount < 1 ? '<div class="big" style="font-size: 28px; margin: 15px 0;">ぴったり ✓</div>' : `
            <h2 style="font-size: 22px; margin-bottom: 10px;">${esc(name(sender))} → ${esc(name(receiver))}</h2>
            <div class="big" style="margin-bottom: 20px;">${yen(amount)}</div>
            <div style="border-top: 1px solid rgba(255,255,255,0.3); padding-top: 20px; text-align: left;">
              <label style="font-size: 12px; color: rgba(255,255,255,0.8);">今回精算する金額</label>
              <div style="display: flex; gap: 8px; margin-top: 6px;">
                <input type="number" id="settleAmount" class="field" style="margin: 0; flex: 1; font-size: 18px; font-weight: bold; color:#3e3438;" value="${amount}">
                <button id="settleFullBtn" style="background: rgba(255,255,255,0.2); color: #fff; border:0; border-radius:12px; padding:0 15px; font-weight:bold;">全額</button>
              </div>
              <button id="settleBtn" class="settle" style="background: #fff; color: #e7617d; margin-top: 15px; font-size: 16px;">この金額で精算する</button>
            </div>
          `}
        </div>
      </section>

      <!-- 履歴タブ -->
      <section id="sec-history">
        <div class="card" style="padding: 10px 18px; margin-top: 20px;">
          <select id="monthSelect" class="field" style="margin:0; font-weight:bold;">
            <option value="all" ${currentMonth === 'all' ? 'selected' : ''}>すべての履歴を表示</option>
            ${months.map(m => `<option value="${m}" ${currentMonth === m ? 'selected' : ''}>${m.split('-')[0]}年${m.split('-')[1]}月</option>`).join('')}
          </select>
        </div>
        <div class="card history-scroll">
          <h2 style="position: sticky; top: 0; background: #fff; padding-bottom: 5px; margin-top: 0; z-index: 1;">タイムライン</h2>
          <div style="margin-top: 10px;">${timelineHtml}</div>
        </div>
        <div class="card history-scroll">
          <h2 style="position: sticky; top: 0; background: #fff; padding-bottom: 5px; margin-top: 0; z-index: 1;">精算履歴 (取り消し用)</h2>
          ${filteredSettlements.map(s => `<div class="expense"><div class="expense-left"><b class="break-text">${esc(name(s.from_user_id))} → ${esc(name(s.to_user_id))}</b><div class="muted">${new Date(s.settled_at).toLocaleDateString('ja-JP')}</div></div><div class="expense-right"><b style="font-size: 16px;">${yen(s.amount)}</b><br><button class="undo-settle ghost" data-id="${s.id}" style="color:#bf4f68; padding:4px 10px; font-size:11px; margin-top:6px; border-radius:6px;">取り消す</button></div></div>`).join('') || '<p class="muted">まだありません</p>'}
        </div>
      </section>

      <!-- スケジュールタブ（新機能） -->
      <section id="sec-schedule">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; margin-top: 10px;">
          <h2 style="margin: 0; font-size: 18px;">📅 ふたりの予定</h2>
        </div>
        <div class="card" style="background: #fffafb; border: 1px solid #f0dfe4;">
          <h2>新しい予定を登録</h2>
          <input id="schedTitle" class="field" placeholder="予定 (例: ディズニー旅行)">
          <div style="display:flex; gap:8px;">
            <input id="schedDate" type="date" class="field" style="margin-bottom:0;" value="${getToday()}">
            <button id="addSchedBtn" class="primary" style="white-space:nowrap;">登録</button>
          </div>
        </div>
        <div class="card">
          <h2>今後の予定</h2>
          <p class="muted" style="margin-top:0;">「カレンダーに登録」を押すとスマホの標準カレンダーに保存され、OSからの通知を受け取れます。</p>
          ${schedules.slice().sort((a:any, b:any) => a.date.localeCompare(b.date)).map((s:any) => `
            <div style="padding: 12px 0; border-bottom: 1px solid #f5e9ed; display:flex; justify-content:space-between; align-items:center;">
              <div>
                <b style="font-size: 16px; color:#e7617d;">${esc(s.title)}</b>
                <div class="muted" style="font-weight:bold; margin-top:2px;">${s.date.replace(/-/g, '/')}</div>
              </div>
              <div style="text-align:right;">
                <a href="${getIcsUrl(s.title, s.date)}" download="${s.title}.ics" class="ghost" style="display:inline-block; padding: 6px 12px; font-size: 11px; text-decoration: none; border-radius: 8px; font-weight:bold;">📅 カレンダーに登録</a>
                <br><button class="del-sched ghost" data-id="${s.id}" style="color:#bf4f68; padding:4px 10px; font-size:11px; margin-top:6px; border-radius:6px; background:transparent;">削除</button>
              </div>
            </div>
          `).join('') || '<p class="muted" style="text-align:center; padding:10px 0;">まだ予定はありません</p>'}
        </div>
      </section>

      <!-- 水道光熱費タブ -->
      <section id="sec-utilities">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; margin-top: 10px;">
          <h2 style="margin: 0; font-size: 18px;">💧 水道・光熱費</h2>
        </div>
        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <div class="muted">推移・平均</div>
            <button id="utilModeToggle" class="ghost" style="padding: 6px 12px; font-size: 12px; border-radius: 8px; font-weight: bold;">${utilViewMode === 'trend' ? '平均を見る ⇄' : 'グラフを見る ⇄'}</button>
          </div>
          ${graphHtml}
        </div>
        <div class="card">
          <h2>記録を追加</h2>
          <div style="display: flex; gap: 6px; margin-top: 10px;">
            <input type="month" id="utilMonth" class="field" style="margin:0; flex:1;" value="${new Date().toISOString().slice(0,7)}">
            <select id="utilType" class="field" style="margin:0; width: 110px;">
              <option value="water">水道代</option><option value="energy">光熱費</option>
            </select>
          </div>
          <input type="number" id="utilAmount" class="field" placeholder="金額を入力" style="margin-top: 10px;">
          <button id="addUtilBtn" class="dark full">追加する</button>
        </div>
        <div class="card">
          <h2>履歴</h2>
          ${utils.slice().reverse().map((u:any) => `<div style="display:flex; justify-content:space-between; align-items:center; padding: 12px 0; border-bottom:1px solid #f5e9ed;"><div><b style="font-size:15px; color:${u.type==='water'?'#5995bd':'#d88c5f'}">${u.type === 'water' ? '水道代' : '光熱費'}</b><div class="muted" style="font-size:12px; margin-top: 2px;">${u.month}</div></div><div style="text-align:right;"><b style="font-size: 16px;">${yen(u.amount)}</b><br><button class="del-util ghost" data-id="${u.id}" style="color:#bf4f68; padding:4px 10px; font-size:11px; margin-top:6px; border-radius:6px;">削除</button></div></div>`).join('') || '<p class="muted" style="text-align:center; padding:10px 0;">まだありません</p>'}
        </div>
      </section>

      <!-- 設定タブ -->
      <section id="sec-settings">
        <div class="card" style="margin-top: 20px;">
          <h2>招待コード</h2>
          <div class="big" style="color: #e7617d;">${esc(p?.invite_code)}</div><p class="muted">${members.length}/2人</p>
        </div>
        <div class="card">
          <h2>サブスク・定額の管理</h2>
          <p class="muted" style="font-size:12px; margin-top:0;">登録しておくと、金額追加画面でワンタップで入力できます。</p>
          <div id="subsList" style="margin-bottom: 12px;">
            ${subs.map((s:any) => `<div style="display:flex; justify-content:space-between; align-items:center; padding: 10px 0; border-bottom:1px solid #f5e9ed;"><div><b style="font-size:14px;">${esc(s.title)}</b><br><span class="muted" style="font-size:12px;">${yen(s.amount)} (毎月${s.date ? s.date + '日' : '-'} / 支払: ${esc(name(s.payer_id))})</span></div><button class="del-sub ghost" data-id="${s.id}" style="color:#bf4f68; padding:6px 10px; font-size:12px; border-radius: 8px;">削除</button></div>`).join('') || '<p class="muted" style="text-align:center; padding: 10px 0;">登録されていません</p>'}
          </div>
          <div style="background: #fffafb; padding: 12px; border-radius: 12px; border: 1px solid #f0dfe4;">
            <label class="muted" style="font-size:12px;">新しいサブスクを登録</label>
            <div style="display:flex; gap:6px; margin-top:4px;">
              <input id="subTitle" class="field" placeholder="名前" style="margin:0; flex:1;">
              <input id="subAmount" type="number" class="field" placeholder="金額" style="margin:0; width:90px;">
              <input id="subDate" type="number" class="field" placeholder="日" min="1" max="31" style="margin:0; width:60px;">
            </div>
            <select id="subPayer" class="field" style="margin:8px 0 0 0;">
              ${members.map((m) => `<option value="${m.user_id}" ${m.user_id === uid ? 'selected' : ''}>${esc(name(m.user_id))}が支払う</option>`).join('')}
            </select>
            <button id="addSubBtn" class="dark full" style="margin-top:8px;">登録する</button>
          </div>
        </div>
        <div class="card">
          <h2>プロフィール設定</h2>
          <div style="display:flex; gap:8px; margin-top:6px;">
            <input id="myName" class="field" style="margin:0;" value="${esc(myName)}" placeholder="あなたの名前">
            <button id="updateNameBtn" class="dark" style="min-width:70px;">更新</button>
          </div>
        </div>
        <div class="card" style="border: 2px solid #ffe5e9; background: #fffcfc;">
          <h2 style="color:#a13c52; margin-top:0;">危険な操作</h2>
          <button id="delAllBtn" class="ghost full" style="color:#a13c52; background:#ffe5e9; margin-bottom: 12px;">すべての履歴を削除する</button>
          <button id="resetUtilsBtn" class="ghost full" style="color:#a13c52; background:#ffe5e9;">水道代・光熱費の記録をすべて削除</button>
        </div>
        <button id="out" class="ghost full">ログアウト</button>
      </section>

      <nav class="tabs">
        <button data-tab="entry">＋ 入力</button>
        <button data-tab="home">精算</button>
        <button data-tab="history">履歴</button>
        <button data-tab="settings">設定</button>
      </nav>
    </main>
  `;

  wire(stateObj);
  setTab(currentTab); // 描画後に現在のタブを復元
}

function calc() {
  let raw = val('#amount').replace(/,/g, '');
  if (!raw) return 0;
  raw = raw.replace(/[+\-*/.]+$/, ''); 
  if (!/^[0-9+\-*/(). ]+$/.test(raw)) return NaN;
  try {
    const n = Function(`"use strict";return (${raw})`)();
    return Number.isFinite(n) && n > 0 ? Math.round(n) : NaN;
  } catch {
    return NaN;
  }
}

function showCalc() {
  const n = calc();
  q('#result').textContent = Number.isFinite(n) ? `計算結果：${yen(n)}` : '計算式を確認';
}

function wire(state: any) {
  // --- イベントバインド ---
  
  // スライドメニュー開閉
  q('#menuBtn')?.addEventListener('click', () => q('#menuDrawer').classList.remove('hide'));
  q('#closeDrawerBtn')?.addEventListener('click', () => q('#menuDrawer').classList.add('hide'));
  
  // ドロワー内のナビゲーション
  document.querySelectorAll('[data-nav]').forEach((b: any) => {
    b.onclick = () => setTab(b.dataset.nav);
  });

  // 下部タブの切り替え（再描画せずクラス切替のみ。爆速）
  document.querySelectorAll('[data-tab]').forEach((b: any) => {
    b.onclick = () => setTab(b.dataset.tab);
  });

  // スケジュール追加・削除
  q('#addSchedBtn')?.addEventListener('click', () => {
    const title = val('#schedTitle').trim();
    const date = val('#schedDate');
    if (!title || !date) return alert('予定と日付を入力してください');
    const sched = JSON.parse(localStorage.getItem(`sched_${pair}`) || '[]');
    sched.push({ id: Date.now().toString(), title, date });
    localStorage.setItem(`sched_${pair}`, JSON.stringify(sched));
    render();
  });

  document.querySelectorAll('.del-sched').forEach((b: any) => {
    b.onclick = () => {
      if(!confirm('この予定を削除しますか？')) return;
      let sched = JSON.parse(localStorage.getItem(`sched_${pair}`) || '[]');
      sched = sched.filter((s: any) => s.id !== b.dataset.id);
      localStorage.setItem(`sched_${pair}`, JSON.stringify(sched));
      render();
    };
  });

  q('#monthSelect')?.addEventListener('change', (e: any) => {
    currentMonth = e.target.value;
    render();
  });

  document.querySelectorAll('[data-op]').forEach((b: any) => {
    b.onclick = (e: Event) => { e.preventDefault(); const input = q('#amount'); input.value += b.dataset.op; showCalc(); input.focus(); };
  });

  document.querySelectorAll('[data-plus]').forEach((b: any) => {
    b.onclick = (e: Event) => { e.preventDefault(); const n = calc(); q('#amount').value = String((Number.isFinite(n) ? n : 0) + Number(b.dataset.plus)); showCalc(); q('#amount').focus(); };
  });

  if (q('#clear')) q('#clear').onclick = (e: Event) => { e.preventDefault(); q('#amount').value = ''; showCalc(); q('#amount').focus(); };

  if (q('#split')) q('#split').onclick = (e: Event) => { e.preventDefault(); const n = calc(); if (Number.isFinite(n) && n > 0) { q('#amount').value = String(Math.round(n / 2)); showCalc(); q('#amount').focus(); } };

  q('#utilModeToggle')?.addEventListener('click', () => {
    utilViewMode = utilViewMode === 'trend' ? 'average' : 'trend';
    render();
  });

  q('#addUtilBtn')?.addEventListener('click', () => {
    const month = val('#utilMonth');
    const type = val('#utilType');
    const amount = Number(val('#utilAmount'));
    if (!month || !amount) return alert('月と金額を入力してください');
    const utils = JSON.parse(localStorage.getItem(`utils_${pair}`) || '[]');
    utils.push({ id: Date.now().toString(), month, type, amount });
    localStorage.setItem(`utils_${pair}`, JSON.stringify(utils));
    render();
  });

  document.querySelectorAll('.del-util').forEach((b: any) => b.onclick = () => {
    if (!confirm('この記録を削除しますか？')) return;
    let utils = JSON.parse(localStorage.getItem(`utils_${pair}`) || '[]');
    utils = utils.filter((u: any) => u.id !== b.dataset.id);
    localStorage.setItem(`utils_${pair}`, JSON.stringify(utils));
    render();
  });

  q('#settleFullBtn')?.addEventListener('click', () => { q('#settleAmount').value = state.amount; });

  q('#addSubBtn')?.addEventListener('click', () => {
    const title = val('#subTitle').trim(); const amount = Number(val('#subAmount')); const date = val('#subDate'); const payer = val('#subPayer');
    if (!title || !amount) return alert('名前と金額を正しく入力してください');
    const subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
    subs.push({ id: Date.now().toString(), title, amount, date, payer_id: payer });
    localStorage.setItem(`subs_${pair}`, JSON.stringify(subs));
    render();
  });

  document.querySelectorAll('.del-sub').forEach((b: any) => b.onclick = () => {
    if (!confirm('このサブスク設定を削除しますか？')) return;
    let subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
    subs = subs.filter((s: any) => s.id !== b.dataset.id);
    localStorage.setItem(`subs_${pair}`, JSON.stringify(subs));
    render();
  });

  document.querySelectorAll('.sub-fill-btn').forEach((b: any) => b.onclick = () => {
    const subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
    const sub = subs.find((s: any) => s.id === b.dataset.id);
    if (sub) {
      q('#title').value = sub.title; q('#amount').value = sub.amount; q('#payer').value = sub.payer_id;
      document.querySelectorAll('.payer-btn').forEach((x: any) => x.classList.toggle('selected', x.dataset.payer === sub.payer_id));
      showCalc();
    }
  });

  q('#updateNameBtn')?.addEventListener('click', async () => {
    const newName = val('#myName').trim();
    if (!newName) return alert('名前を入力してください');
    const { error } = await supabase.from('profiles').update({ display_name: newName }).eq('id', uid);
    if (error) return alert(error.message);
    alert('名前を更新しました');
    await load(); render();
  });

  q('#delAllBtn')?.addEventListener('click', async () => {
    if (!confirm('【警告】\nすべての支出履歴と精算履歴を完全に削除します。\nこの操作は元に戻せません。よろしいですか？')) return;
    await supabase.from('expenses').delete().eq('pair_id', pair);
    await supabase.from('settlements').delete().eq('pair_id', pair);
    alert('すべての履歴を削除しました');
    currentMonth = 'all';
    await load(); render();
  });

  q('#resetUtilsBtn')?.addEventListener('click', () => {
    if (!confirm('【警告】\n水道代・光熱費の記録をすべて削除します。\nよろしいですか？')) return;
    localStorage.removeItem(`utils_${pair}`);
    alert('水道代・光熱費の記録をすべて削除しました');
    render();
  });

  document.querySelectorAll('[data-payer]').forEach((b: any) => b.onclick = () => {
    q('#payer').value = b.dataset.payer;
    document.querySelectorAll('[data-payer]').forEach((x: any) => x.classList.remove('selected'));
    b.classList.add('selected');
  });
  
  q('#out')?.addEventListener('click', logout);
  q('#amount')?.addEventListener('input', showCalc);
  q('#saveTop')?.addEventListener('click', save);
  
  q('#settleBtn')?.addEventListener('click', () => {
    const inputAmt = Number(val('#settleAmount'));
    if (!inputAmt || inputAmt <= 0) return alert('精算金額を正しく入力してください');
    if (inputAmt > state.amount) return alert('現在の精算残高より多い金額は入力できません');
    state.amount = inputAmt;
    settle(state);
  });
  
  document.querySelectorAll('.del').forEach((b: any) => b.onclick = async () => {
    const id = b.dataset.id; const e = expenses.find(x => x.id === id);
    if(e) {
      const { error } = await supabase.from('expenses').update({ title: '[削除済] ' + uid + '::' + (e.title || '支出') }).eq('id', id);
      if (error) return alert('削除に失敗しました。\n' + error.message);
      await load(); render();
    }
  });

  document.querySelectorAll('.restore').forEach((b: any) => b.onclick = async () => {
    if (!confirm('この履歴を元に戻しますか？')) return;
    const id = b.dataset.id; const e = expenses.find(x => x.id === id);
    if(e) {
      const originalTitle = e.title.replace('[削除済] ', '').split('::').slice(1).join('::');
      const { error } = await supabase.from('expenses').update({ title: originalTitle }).eq('id', id);
      if (error) return alert('復元に失敗しました。\n' + error.message);
      await load(); render();
    }
  });

  document.querySelectorAll('.undo-settle').forEach((b: any) => b.onclick = async () => {
    if (!confirm('この精算を取り消しますか？')) return;
    const id = b.dataset.id;
    const { error } = await supabase.from('settlements').delete().eq('id', id);
    if (error) return alert('取り消しに失敗しました。\n' + error.message);
    await load(); render();
  });
}

async function settle(x: any) {
  if (!confirm(`${yen(x.amount)}を精算済みにしますか？`)) return;
  const { error } = await supabase.from('settlements').insert({
    pair_id: pair, from_user_id: x.sender, to_user_id: x.receiver, amount: Math.round(x.amount), created_by: uid, memo: 'アプリから精算'
  });
  if (error) return alert(error.message);
  await load(); render();
}

async function save() {
  const amount = calc();
  if (!Number.isFinite(amount)) return alert('金額または計算式を確認してください');
  const { error } = await supabase.rpc('add_shared_expense', {
    input_pair_id: pair, input_title: val('#title').trim() || '支出', input_amount: amount, input_payer_id: val('#payer'), input_category: val('#cat') || 'その他', input_expense_date: getToday(), input_memo: null
  });
  if (error) return alert(error.message);
  q('#amount').value = ''; q('#title').value = ''; showCalc(); // 入力をクリア
  await load(); render(); 
}

async function logout() { await supabase.auth.signOut(); boot(); }
function q(s: string) { return document.querySelector(s) as any; }
function val(s: string) { return q(s)?.value || ''; }
function fail(s: string) { app.innerHTML = `<main class="app"><div class="notice">${esc(s)}</div></main>`; }

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') { if (session && !uid) boot(); } 
  else if (event === 'SIGNED_OUT') { uid = ''; pair = ''; authView(); }
});
boot();
