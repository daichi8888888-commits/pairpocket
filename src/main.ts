import './style.css';
import { supabase } from './supabase';

const app = document.querySelector<HTMLDivElement>('#app')!;
let uid = '', pair = '', members: any[] = [], expenses: any[] = [], balances: any[] = [], settlements: any[] = [];
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
  const total = expenses.reduce((s, e) => s + e.amount, 0);

  // --- 修正箇所：Supabaseの残高ビューに頼らず、フロントエンドで直接正確な残高を計算する ---
  let bals: Record<string, number> = {};
  members.forEach(m => bals[m.user_id] = 0);

  // 1. 支出（入力した値＝そのまま相手への請求額として計算）
  expenses.forEach(e => {
    const pId = e.payer_id;
    const oId = members.find(m => m.user_id !== pId)?.user_id;
    if (pId && bals[pId] !== undefined) bals[pId] += Number(e.amount);
    if (oId && bals[oId] !== undefined) bals[oId] -= Number(e.amount);
  });

  // 2. 精算履歴（精算した分だけ残高を相殺）
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
      receiver = u1;
      sender = u2;
      amount = bals[u1];
    } else {
      receiver = u2;
      sender = u1;
      amount = Math.abs(bals[u2] || 0);
    }
  }
  // ------------------------------------------------------------------------------------

  app.innerHTML = `<main class="app"><div class="top"><div><div class="muted">ふたりのお金</div><h1>${esc(p?.name || 'PairPocket')}</h1></div></div><section id="home" class="${tab === 'home' ? '' : 'hide'}"><div class="card hero"><div class="muted">合計支出</div><div class="big">${yen(total)}</div><div class="grid">${balances.map(x => `<div class="mini"><div class="muted">${esc(x.display_name)}</div><b>${yen(Number(x.paid_amount))}</b></div>`).join('')}</div></div><div class="card"><div class="muted">現在の精算</div>${members.length < 2 ? '<h2>相手の参加待ち</h2>' : amount < 1 ? '<div class="settled">精算はありません</div>' : `<h2>${esc(name(sender))} → ${esc(name(receiver))}</h2><div class="big">${yen(amount)}</div><button id="settle" class="settle">${yen(amount)}を精算済みにする</button>`}</div><button id="add" class="primary full">＋ 金額を追加</button></section><section id="history" class="${tab === 'history' ? '' : 'hide'}"><div class="card"><h2>支出履歴</h2>${expenses.map(e => `<div class="expense"><div><b>${esc(e.title)}</b><div class="muted">${esc(name(e.payer_id))}・${e.expense_date}</div></div><div><b>${yen(e.amount)}</b> <button class="del" data-id="${e.id}">削除</button></div></div>`).join('') || '<p class="muted">まだありません</p>'}</div><div class="card"><h2>精算履歴</h2>${settlements.map(s => `<div class="expense"><div><b>${esc(name(s.from_user_id))} → ${esc(name(s.to_user_id))}</b><div class="muted">${new Date(s.settled_at).toLocaleDateString('ja-JP')}</div></div><b>${yen(s.amount)}</b></div>`).join('') || '<p class="muted">まだありません</p>'}</div></section><section id="settings" class="${tab === 'settings' ? '' : 'hide'}"><div class="card"><h2>招待コード</h2><div class="big">${esc(p?.invite_code)}</div><p>${members.length}/2人</p></div><button id="out" class="ghost full">ログアウト</button></section><section id="entry" class="card hide"><div class="top"><div><div class="muted">内容なしでも登録可能</div><h2>金額を追加</h2></div><button id="cancel" class="ghost">×</button></div><input id="title" class="field" placeholder="内容（任意）"><label class="muted">金額または計算式</label><div class="money"><span>¥</span><input id="amount" inputmode="decimal" placeholder="1200+350"></div><div id="result" class="result">計算結果：¥0</div><div class="quick"><button data-plus="100">+100</button><button data-plus="500">+500</button><button data-plus="1000">+1,000</button><button id="clear">クリア</button></div><button id="split" class="split">÷ 2人で割り勘</button><label class="muted">支払った人</label><div class="payer-buttons">${members.map((m, i) => `<button type="button" class="payer-btn ${i === 0 ? 'selected' : ''}" data-payer="${m.user_id}">${esc(name(m.user_id))}</button>`).join('')}</div><input id="payer" type="hidden" value="${members[0]?.user_id || ''}"><label class="muted">カテゴリー</label><select id="cat" class="field"><option value="" selected>カテゴリーなし</option>${['食費', '外食', '生活', '家賃', '光熱費', '交通', '娯楽', '旅行', 'その他'].map(x => `<option value="${x}">${x}</option>`).join('')}</select><button id="save" class="primary full">この金額を追加</button></section><nav class="tabs"><button data-tab="home">ホーム</button><button data-tab="history">履歴</button><button data-tab="settings">設定</button></nav></main>`;
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
  document.querySelectorAll('[data-payer]').forEach((b: any) => b.onclick = () => {
    q('#payer').value = b.dataset.payer;
    document.querySelectorAll('[data-payer]').forEach((x: any) => x.classList.remove('selected'));
    b.classList.add('selected');
  });
  document.querySelectorAll('[data-tab]').forEach((b: any) => b.onclick = () => view(b.dataset.tab));
  q('#out')?.addEventListener('click', logout);
  q('#add')?.addEventListener('click', () => {
    ['home', 'history', 'settings'].forEach(x => q('#' + x).classList.add('hide'));
    q('#entry').classList.remove('hide');
  });
  q('#cancel')?.addEventListener('click', () => view());
  q('#amount')?.addEventListener('input', showCalc);
  document.querySelectorAll('[data-plus]').forEach((b: any) => b.onclick = () => {
    const n = calc();
    q('#amount').value = String((Number.isFinite(n) ? n : 0) + Number(b.dataset.plus));
    showCalc();
  });
  q('#clear')?.addEventListener('click', () => {
    q('#amount').value = '';
    showCalc();
  });
  q('#split')?.addEventListener('click', () => {
    const n = calc();
    if (Number.isFinite(n) && n > 0) {
      q('#amount').value = String(Math.round(n / 2));
      showCalc();
    }
  });
  q('#save')?.addEventListener('click', save);
  q('#settle')?.addEventListener('click', () => settle(state));
  document.querySelectorAll('.del').forEach((b: any) => b.onclick = async () => {
    await supabase.from('expenses').delete().eq('id', b.dataset.id);
    await load();
    view('history');
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
  view();
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
