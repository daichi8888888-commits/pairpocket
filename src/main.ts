import './style.css';
import { supabase } from './supabase';

const app = document.querySelector<HTMLDivElement>('#app')!;
let uid = '', pair = '', members: any[] = [], expenses: any[] = [], balances: any[] = [], settlements: any[] = [];
let currentMonth = 'all'; 

const yen = (n: number) => `¥${Math.round(n).toLocaleString('ja-JP')}`;
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function boot() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return authView();
  uid = session.user.id;
  const { data, error } = await supabase.from('pair_members').select('pair_id').eq('user_id', uid).maybeSingle();
  if (error) return fail(error.message);
  if (!data) return pairView();
  pair = data.pair_id;
  await load();
  view('home');
}

function authView(msg = '') {
  app.innerHTML = `<main class="app"><h1>PairPocket</h1>${msg ? `<div class="notice">${esc(msg)}</div>` : ''}<div class="card"><input id="email" class="field" type="email" placeholder="メール"><input id="pw" class="field" type="password" placeholder="パスワード"><div class="grid"><button id="up" class="ghost">新規登録</button><button id="in" class="dark">ログイン</button></div></div></main>`;
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
  app.innerHTML = `<main class="app"><h1>PairPocket</h1>${msg ? `<div class="notice">${esc(msg)}</div>` : ''}<div class="card"><h2>ペアを作る</h2><input id="pn" class="field" value="ふたりの家計"><button id="make" class="dark full">作成</button></div><div class="card"><h2>招待コードで参加</h2><input id="code" class="field"><button id="join" class="primary full">参加</button></div><button id="out" class="ghost full">ログアウト</button></main>`;
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
    supabase.from('expenses').select('*').eq('pair_id', pair).order('expense_date', { ascending: false }),
    supabase.from('pair_balances').select('*').eq('pair_id', pair),
    supabase.from('settlements').select('*').eq('pair_id', pair).order('settled_at', { ascending: false })
  ]);
  const er = m.error || e.error || b.error || s.error;
  if (er) return fail(er.message);
  members = m.data || [];
  expenses = e.data || [];
  balances = b.data || [];
  settlements = s.data || [];
}

async function view(tab = 'home') {
  const { data: p } = await supabase.from('pairs').select('name,invite_code').eq('id', pair).single();
  const name = (id: string) => members.find(x => x.user_id === id)?.profiles?.display_name || balances.find(x => x.user_id === id)?.display_name || 'メンバー';
  
  // 削除済みの履歴を除外して合計と残高を計算
  const total = expenses.reduce((s, e) => {
    if (typeof e.title === 'string' && e.title.startsWith('[削除済]')) return s;
    return s + e.amount;
  }, 0);

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

  const months = Array.from(new Set([
    ...expenses.map(e => (e.expense_date || '').slice(0, 7)),
    ...settlements.map(s => new Date(s.settled_at).toISOString().slice(0, 7))
  ])).filter(Boolean).sort().reverse();

  const filteredExpenses = expenses.filter(e => currentMonth === 'all' || e.expense_date?.startsWith(currentMonth));
  const filteredSettlements = settlements.filter(s => currentMonth === 'all' || new Date(s.settled_at).toISOString().startsWith(currentMonth));
  const myName = members.find(m => m.user_id === uid)?.profiles?.display_name || '';

  // ローカルに保存されているサブスク（定額）の読み込み
  const subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');

  // 精算の区切り線（タイムライン）を生成する処理
  let sIdx = 0;
  let expensesListHtml = '';
  filteredExpenses.forEach(e => {
    while (sIdx < filteredSettlements.length) {
      const s = new Date(filteredSettlements[sIdx].settled_at);
      const sDate = s.getFullYear() + '-' + String(s.getMonth() + 1).padStart(2, '0') + '-' + String(s.getDate()).padStart(2, '0');
      if (sDate >= (e.expense_date || '')) {
        expensesListHtml += `<div style="border-top: 2px dashed #2f6c57; margin: 24px 0 16px; position: relative;">
          <span style="position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: #fff; padding: 0 10px; color: #2f6c57; font-size: 11px; font-weight: bold;">
            ✂️ 精算完了 (${s.toLocaleDateString('ja-JP')})
          </span>
        </div>`;
        sIdx++;
      } else {
        break;
      }
    }

    const isDel = typeof e.title === 'string' && e.title.startsWith('[削除済]');
    let displayTitle = e.title;
    let delName = '';
    if (isDel) {
      const parts = e.title.replace('[削除済] ', '').split('::');
      delName = name(parts[0]); 
      displayTitle = parts.slice(1).join('::');
    }

    expensesListHtml += `<div class="expense ${isDel ? 'deleted-log' : ''}">
      <div class="expense-left">
        ${isDel ? `<del style="color:#888;"><b class="break-text">${esc(displayTitle)}</b></del>` : `<b class="break-text">${esc(displayTitle)}</b>`}
        <div class="muted break-text" style="margin-top: 3px;">
          ${isDel ? `<span class="deleted-badge">削除者: ${esc(delName)}</span>` : ''}
          ${esc(name(e.payer_id))}・${e.expense_date}
        </div>
      </div>
      <div class="expense-right">
        ${isDel ? `<del style="color:#888;"><b>${yen(e.amount)}</b></del>` : `<b>${yen(e.amount)}</b>`}
        <div style="margin-top: 4px;">
          ${!isDel 
            ? `<button class="del ghost" data-id="${e.id}" style="padding: 4px 8px; font-size: 12px; color: #a13c29; background: #fff0ed;">削除</button>` 
            : `<button class="restore ghost" data-id="${e.id}" style="padding: 4px 8px; font-size: 12px; color: #2c604f; background: #eaf2ee;">戻す</button>`}
        </div>
      </div>
    </div>`;
  });

  while (sIdx < filteredSettlements.length) {
    const s = new Date(filteredSettlements[sIdx].settled_at);
    expensesListHtml += `<div style="border-top: 2px dashed #2f6c57; margin: 24px 0 16px; position: relative;">
      <span style="position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: #fff; padding: 0 10px; color: #2f6c57; font-size: 11px; font-weight: bold;">
        ✂️ 精算完了 (${s.toLocaleDateString('ja-JP')})
      </span>
    </div>`;
    sIdx++;
  }

  if (filteredExpenses.length === 0 && filteredSettlements.length === 0) {
    expensesListHtml = '<p class="muted">まだありません</p>';
  }

  app.innerHTML = `
    <style>
      .app { padding-top: max(20px, env(safe-area-inset-top)) !important; padding-bottom: max(100px, calc(env(safe-area-inset-bottom) + 80px)) !important; overflow-x: hidden; }
      .tabs { padding-bottom: max(10px, env(safe-area-inset-bottom)) !important; }
      .history-scroll { max-height: 52vh; overflow-y: auto; padding-right: 12px; overscroll-behavior: contain; }
      .calc-buttons { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; margin-top: 8px; margin-bottom: 12px; }
      .calc-buttons button { background: #eaf2ee; color: #2c604f; font-size: 20px; padding: 8px; font-weight: 800; cursor: pointer; }
      .deleted-log { opacity: 0.5; background: #f9f9f9; padding: 10px; margin: 4px 0; border-radius: 8px; }
      .deleted-badge { color: #d9534f; font-weight: 800; font-size: 11px; border: 1px solid #d9534f; padding: 1px 4px; border-radius: 4px; margin-right: 4px; display: inline-block; }
      .expense { display: flex; justify-content: space-between; gap: 6px; width: 100%; align-items: flex-start; }
      .expense-left { flex: 1; min-width: 0; }
      .expense-right { text-align: right; white-space: nowrap; margin-left: 5px; flex-shrink: 0; padding-right: 2px; }
      .break-text { word-break: break-all; }
      .sub-chip { display: inline-block; background: #edf1ef; color: #243c35; padding: 8px 12px; border-radius: 12px; font-size: 13px; font-weight: bold; white-space: nowrap; cursor: pointer; margin-right: 8px; }
    </style>
    <main class="app">
      <div class="top" style="margin-top: 10px;">
        <div><div class="muted">ふたりのお金</div><h1>${esc(p?.name || 'PairPocket')}</h1></div>
      </div>
      
      <section id="home" class="${tab === 'home' ? '' : 'hide'}">
        <div class="card hero">
          <div class="muted">合計支出</div><div class="big">${yen(total)}</div>
          <div class="grid">${balances.map(x => `<div class="mini"><div class="muted">${esc(x.display_name)}</div><b>${yen(Number(x.paid_amount))}</b></div>`).join('')}</div>
        </div>
        <div class="card">
          <div class="muted">現在の精算</div>
          ${members.length < 2 ? '<h2>相手の参加待ち</h2>' : amount < 1 ? '<div class="settled">精算はありません</div>' : `
            <h2>${esc(name(sender))} → ${esc(name(receiver))}</h2>
            <div class="big">${yen(amount)}</div>
            
            <div style="margin-top: 15px; border-top: 1px solid #edf0ee; padding-top: 15px;">
              <label class="muted" style="font-size: 12px;">今回精算する金額</label>
              <div style="display: flex; gap: 8px; margin-top: 6px;">
                <input type="number" id="settleAmount" class="field" style="margin: 0; flex: 1; font-size: 18px; font-weight: bold;" value="${amount}">
                <button id="settleFullBtn" class="ghost" style="white-space: nowrap;">全額</button>
              </div>
              <button id="settleBtn" class="settle" style="margin-top: 12px;">この金額で精算する</button>
            </div>
          `}
        </div>
        <button id="add" class="primary full">＋ 金額を追加</button>
      </section>

      <section id="history" class="${tab === 'history' ? '' : 'hide'}">
        <div class="card" style="padding: 10px 18px;">
          <select id="monthSelect" class="field" style="margin:0; font-weight:bold; background:#f9f9f9;">
            <option value="all" ${currentMonth === 'all' ? 'selected' : ''}>すべての履歴を表示</option>
            ${months.map(m => `<option value="${m}" ${currentMonth === m ? 'selected' : ''}>${m.split('-')[0]}年${m.split('-')[1]}月</option>`).join('')}
          </select>
        </div>
        <div class="card history-scroll">
          <h2 style="position: sticky; top: 0; background: #fff; padding-bottom: 5px; margin-top: 0; z-index: 1;">支出履歴</h2>
          ${expensesListHtml}
        </div>
        <div class="card history-scroll">
          <h2 style="position: sticky; top: 0; background: #fff; padding-bottom: 5px; margin-top: 0; z-index: 1;">精算履歴</h2>
          ${filteredSettlements.map(s => `<div class="expense">
            <div class="expense-left">
              <b class="break-text">${esc(name(s.from_user_id))} → ${esc(name(s.to_user_id))}</b>
              <div class="muted">${new Date(s.settled_at).toLocaleDateString('ja-JP')}</div>
            </div>
            <div class="expense-right">
              <b>${yen(s.amount)}</b>
            </div>
          </div>`).join('') || '<p class="muted">まだありません</p>'}
        </div>
      </section>

      <section id="settings" class="${tab === 'settings' ? '' : 'hide'}">
        <div class="card">
          <h2>招待コード</h2>
          <div class="big">${esc(p?.invite_code)}</div><p>${members.length}/2人</p>
        </div>
        
        <div class="card">
          <h2>サブスク・定額の管理</h2>
          <p class="muted" style="font-size:12px; margin-top:0;">登録しておくと、金額追加画面でワンタップで入力できます。</p>
          <div id="subsList" style="margin-bottom: 12px;">
            ${subs.map((s:any) => `
              <div style="display:flex; justify-content:space-between; align-items:center; padding: 8px 0; border-bottom:1px solid #edf0ee;">
                <div>
                  <b style="font-size:14px;">${esc(s.title)}</b><br>
                  <span class="muted" style="font-size:12px;">${yen(s.amount)} (支払: ${esc(name(s.payer_id))})</span>
                </div>
                <button class="del-sub ghost" data-id="${s.id}" style="color:#a13c29; padding:6px 10px; font-size:12px;">削除</button>
              </div>
            `).join('') || '<p class="muted">登録されていません</p>'}
          </div>
          <div style="background: #f9f9f9; padding: 12px; border-radius: 12px;">
            <label class="muted" style="font-size:12px;">新しいサブスクを登録</label>
            <div style="display:flex; gap:6px; margin-top:4px;">
              <input id="subTitle" class="field" placeholder="名前 (例: 家賃)" style="margin:0; flex:1;">
              <input id="subAmount" type="number" class="field" placeholder="金額" style="margin:0; width:90px;">
            </div>
            <select id="subPayer" class="field" style="margin:8px 0 0 0;">
              ${members.map((m, i) => `<option value="${m.user_id}" ${i===0?'selected':''}>${esc(name(m.user_id))}が支払う</option>`).join('')}
            </select>
            <button id="addSubBtn" class="dark full" style="margin-top:8px;">登録する</button>
          </div>
        </div>

        <div class="card">
          <h2>プロフィール設定</h2>
          <label class="muted">名前の変更</label>
          <div style="display:flex; gap:8px; margin-top:6px;">
            <input id="myName" class="field" style="margin:0;" value="${esc(myName)}" placeholder="あなたの名前">
            <button id="updateNameBtn" class="dark" style="min-width:70px;">更新</button>
          </div>
        </div>
        <div class="card" style="border: 2px solid #ffe9e4; background: #fffcfc;">
          <h2 style="color:#9c2e1c; margin-top:0;">危険な操作</h2>
          <button id="delAllBtn" class="ghost full" style="color:#9c2e1c; background:#ffe9e4;">すべての履歴を削除する</button>
        </div>
        <button id="out" class="ghost full">ログアウト</button>
      </section>

      <section id="entry" class="card ${tab === 'entry' ? '' : 'hide'}">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
          <button id="cancel" class="ghost" style="padding: 10px 14px;">キャンセル</button>
          <h2 style="margin: 0; font-size: 18px;">金額を追加</h2>
          <button id="save" class="primary" style="padding: 10px 18px;">追加する</button>
        </div>

        ${subs.length > 0 ? `
          <div style="margin-bottom: 15px; background: #fdfdfd; padding: 10px; border-radius: 12px; border: 1px solid #edf0ee;">
            <label class="muted" style="font-size: 12px;">サブスク・定額から入力</label>
            <div style="overflow-x: auto; white-space: nowrap; padding-bottom: 4px; margin-top: 6px;">
              ${subs.map((s:any) => `<div class="sub-fill-btn sub-chip" data-id="${s.id}">${esc(s.title)}</div>`).join('')}
            </div>
          </div>
        ` : ''}
        
        <label class="muted">金額または計算式</label>
        <div class="money">
          <span>¥</span>
          <input type="text" id="amount" inputmode="numeric" placeholder="1200+350">
        </div>
        
        <div class="calc-buttons">
          <button type="button" data-op="+">＋</button>
          <button type="button" data-op="-">－</button>
          <button type="button" data-op="*">×</button>
          <button type="button" data-op="/">÷</button>
        </div>

        <div id="result" class="result">計算結果：¥0</div>
        
        <div class="quick">
          <button data-plus="100">+100</button>
          <button data-plus="500">+500</button>
          <button data-plus="1000">+1,000</button>
          <button id="clear">クリア</button>
        </div>
        
        <button id="split" class="split">÷ 2人で割り勘</button>
        
        <label class="muted" style="margin-top: 15px; display: block;">支払った人</label>
        <div class="payer-buttons">${members.map((m, i) => `<button type="button" class="payer-btn ${i === 0 ? 'selected' : ''}" data-payer="${m.user_id}">${esc(name(m.user_id))}</button>`).join('')}</div>
        <input id="payer" type="hidden" value="${members[0]?.user_id || ''}">
        
        <div style="border-top: 1px solid #edf0ee; margin: 20px 0 15px;"></div>

        <label class="muted">内容（任意）</label>
        <input id="title" class="field" placeholder="例：スーパー、カフェ">
        
        <label class="muted">カテゴリー</label>
        <select id="cat" class="field">
          <option value="" selected>カテゴリーなし</option>
          ${['食費', '外食', '生活', '家賃', '光熱費', '交通', '娯楽', '旅行', 'その他'].map(x => `<option value="${x}">${x}</option>`).join('')}
        </select>
      </section>

      <nav class="tabs">
        <button data-tab="home">ホーム</button>
        <button data-tab="history">履歴</button>
        <button data-tab="settings">設定</button>
      </nav>
    </main>
  `;
  wire({ amount, sender, receiver });
}

function calc() {
  const raw = val('#amount').replace(/,/g, '');
  if (!raw) return 0;
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
  q('#monthSelect')?.addEventListener('change', (e: any) => {
    currentMonth = e.target.value;
    view('history');
  });

  const calcBtns = document.querySelectorAll('[data-op], [data-plus], #clear, #split');
  calcBtns.forEach((b: any) => {
    b.addEventListener('mousedown', (e: Event) => e.preventDefault());
  });

  document.querySelectorAll('[data-op]').forEach((b: any) => b.addEventListener('click', () => {
    const input = q('#amount');
    input.value += b.dataset.op;
    showCalc();
    input.focus(); 
  }));

  // 精算の全額ボタン
  q('#settleFullBtn')?.addEventListener('click', () => {
    q('#settleAmount').value = state.amount;
  });

  // サブスク追加
  q('#addSubBtn')?.addEventListener('click', () => {
    const title = val('#subTitle').trim();
    const amount = Number(val('#subAmount'));
    const payer = val('#subPayer');
    if (!title || !amount) return alert('名前と金額を正しく入力してください');
    const subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
    subs.push({ id: Date.now().toString(), title, amount, payer_id: payer });
    localStorage.setItem(`subs_${pair}`, JSON.stringify(subs));
    alert('サブスクを登録しました');
    view('settings');
  });

  // サブスク削除
  document.querySelectorAll('.del-sub').forEach((b: any) => b.onclick = () => {
    if (!confirm('このサブスク設定を削除しますか？')) return;
    let subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
    subs = subs.filter((s: any) => s.id !== b.dataset.id);
    localStorage.setItem(`subs_${pair}`, JSON.stringify(subs));
    view('settings');
  });

  // サブスクからワンタップ入力
  document.querySelectorAll('.sub-fill-btn').forEach((b: any) => b.onclick = () => {
    const subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
    const sub = subs.find((s: any) => s.id === b.dataset.id);
    if (sub) {
      q('#title').value = sub.title;
      q('#amount').value = sub.amount;
      q('#payer').value = sub.payer_id;
      document.querySelectorAll('.payer-btn').forEach((x: any) => {
        x.classList.toggle('selected', x.dataset.payer === sub.payer_id);
      });
      showCalc();
    }
  });

  q('#updateNameBtn')?.addEventListener('click', async () => {
    const newName = val('#myName').trim();
    if (!newName) return alert('名前を入力してください');
    const { error } = await supabase.from('profiles').update({ display_name: newName }).eq('id', uid);
    if (error) return alert(error.message);
    alert('名前を更新しました');
    await load();
    view('settings');
  });

  q('#delAllBtn')?.addEventListener('click', async () => {
    if (!confirm('【警告】\nすべての支出履歴と精算履歴を完全に削除します。\nこの操作は元に戻せません。よろしいですか？')) return;
    await supabase.from('expenses').delete().eq('pair_id', pair);
    await supabase.from('settlements').delete().eq('pair_id', pair);
    alert('すべての履歴を削除しました');
    currentMonth = 'all';
    await load();
    view('settings');
  });

  document.querySelectorAll('[data-payer]').forEach((b: any) => b.onclick = () => {
    q('#payer').value = b.dataset.payer;
    document.querySelectorAll('[data-payer]').forEach((x: any) => x.classList.remove('selected'));
    b.classList.add('selected');
  });
  
  document.querySelectorAll('[data-tab]').forEach((b: any) => b.onclick = () => view(b.dataset.tab));
  q('#out')?.addEventListener('click', logout);
  
  q('#add')?.addEventListener('click', () => {
    view('entry');
  });
  
  q('#cancel')?.addEventListener('click', () => view('home'));
  q('#amount')?.addEventListener('input', showCalc);
  
  document.querySelectorAll('[data-plus]').forEach((b: any) => b.addEventListener('click', () => {
    const n = calc();
    q('#amount').value = String((Number.isFinite(n) ? n : 0) + Number(b.dataset.plus));
    showCalc();
    q('#amount').focus();
  }));
  
  q('#clear')?.addEventListener('click', () => {
    q('#amount').value = '';
    showCalc();
    q('#amount').focus();
  });
  
  q('#split')?.addEventListener('click', () => {
    const n = calc();
    if (Number.isFinite(n) && n > 0) {
      q('#amount').value = String(Math.round(n / 2));
      showCalc();
      q('#amount').focus();
    }
  });
  
  q('#save')?.addEventListener('click', save);
  
  // 精算ボタンの処理（入力された金額を使用する）
  q('#settleBtn')?.addEventListener('click', () => {
    const inputAmt = Number(val('#settleAmount'));
    if (!inputAmt || inputAmt <= 0) return alert('精算金額を正しく入力してください');
    if (inputAmt > state.amount) return alert('現在の精算残高より多い金額は入力できません');
    
    // 入力された金額をstateに上書きして精算関数へ
    state.amount = inputAmt;
    settle(state);
  });
  
  document.querySelectorAll('.del').forEach((b: any) => b.onclick = async () => {
    const id = b.dataset.id;
    const e = expenses.find(x => x.id === id);
    if(e) {
      const newTitle = '[削除済] ' + uid + '::' + (e.title || '支出');
      const { error } = await supabase.from('expenses').update({ title: newTitle }).eq('id', id);
      if (error) { alert('削除に失敗しました。\n' + error.message); return; }
      await load(); view('history');
    }
  });

  document.querySelectorAll('.restore').forEach((b: any) => b.onclick = async () => {
    if (!confirm('この履歴を元に戻しますか？')) return;
    const id = b.dataset.id;
    const e = expenses.find(x => x.id === id);
    if(e) {
      const parts = e.title.replace('[削除済] ', '').split('::');
      const originalTitle = parts.slice(1).join('::');
      const { error } = await supabase.from('expenses').update({ title: originalTitle }).eq('id', id);
      if (error) { alert('復元に失敗しました。\n' + error.message); return; }
      await load(); view('history');
    }
  });
}

async function settle(x: any) {
  if (!confirm(`${yen(x.amount)}を精算済みにしますか？`)) return;
  const { error } = await supabase.from('settlements').insert({
    pair_id: pair,
    from_user_id: x.sender,
    to_user_id: x.receiver,
    amount: Math.round(x.amount),
    created_by: uid,
    memo: 'アプリから精算'
  });
  if (error) return alert(error.message);
  await load();
  view();
}

async function save() {
  const amount = calc();
  if (!Number.isFinite(amount)) return alert('金額または計算式を確認してください');
  const { error } = await supabase.rpc('add_shared_expense', {
    input_pair_id: pair,
    input_title: val('#title').trim() || '支出',
    input_amount: amount,
    input_payer_id: val('#payer'),
    input_category: val('#cat') || 'その他',
    input_expense_date: new Date().toISOString().slice(0, 10),
    input_memo: null
  });
  if (error) return alert(error.message);
  await load();
  view('home'); 
}

async function logout() {
  await supabase.auth.signOut();
  boot();
}

function q(s: string) { return document.querySelector(s) as any; }
function val(s: string) { return q(s)?.value || ''; }
function fail(s: string) { app.innerHTML = `<main class="app"><div class="notice">${esc(s)}</div></main>`; }

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
    if (session && !uid) boot();
  } else if (event === 'SIGNED_OUT') {
    uid = ''; pair = ''; authView();
  }
});
boot();
