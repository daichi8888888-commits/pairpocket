import './style.css';
import { supabase } from './supabase';

const app = document.querySelector<HTMLDivElement>('#app')!;
let uid = '', pair = '', members: any[] = [], expenses: any[] = [], balances: any[] = [], settlements: any[] = [];
let currentMonth = 'all'; 
let utilViewMode: 'trend' | 'average' = 'trend'; 
let currentTab = 'entry'; 

// スケジュール・レシート・AIスマート入力用の状態
let schedMode: 'multi' | 'span' = 'multi';
let schedCalYear = new Date().getFullYear();
let schedCalMonth = new Date().getMonth();
let schedSelectedDates: string[] = [];
let receiptState: { name: string, price: number, split: 'mine' | 'half' | 'partner' }[] = [];
let pendingReceiptItems: { name: string, price: number, split: 'mine' | 'half' | 'partner' }[] = [];
let smartInputState: { title: string, claimAmount: number, payer: 'me' | 'partner', category: string, note: string }[] = [];

// 献立AI用の状態
let recipeImageBase64 = '';
let recipeMood = '時短・簡単';
let lastRecipeHtml = '';

// ミニゲーム用の状態
let miniGameMode: 'react' | 'bomb' | 'quiz' = 'react';
let reactScoreP1 = 0, reactScoreP2 = 0;
let reactGameState: 'idle' | 'waiting' | 'ready' = 'idle';
let reactTimer: any = null;
let bombTiles: { hasBomb: boolean; opened: boolean }[] = [];
let quizScoreP1 = 0, quizScoreP2 = 0;
let currentQuiz: { question: string; options: string[]; answerIndex: number; explanation: string } | null = null;
let quizAnswered = false;
let isProcessingSubs = false;

const getToday = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

const yen = (n: number) => `¥${Math.round(n).toLocaleString('ja-JP')}`;
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const fmtTime = (raw: string, memo?: string, expDate?: string) => {
  if (memo === '自動追加' && expDate) {
    return `${expDate.replace(/-/g, '/')} 00:00`;
  }
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// メモ欄からレシート内訳データを抽出するヘルパー
function parseReceiptMemo(memo: any): { name: string, price: number, split: 'mine' | 'half' | 'partner' }[] | null {
  if (!memo || typeof memo !== 'string' || !memo.startsWith('{')) return null;
  try {
    const obj = JSON.parse(memo);
    if (obj && obj.type === 'receipt' && Array.isArray(obj.items)) {
      return obj.items;
    }
  } catch {}
  return null;
}

// 緑のふわっと出る通知（トースト）
function showToast(msg: string, isError = false) {
  let t = q('#toastMsg');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastMsg';
    t.style.cssText = `position:fixed; bottom:70px; left:50%; transform:translateX(-50%); color:#fff; padding:12px 24px; border-radius:30px; font-weight:bold; z-index:999999; opacity:0; transition:all 0.3s; pointer-events:none; font-size:14px; white-space:nowrap;`;
    document.body.appendChild(t);
  }
  t.style.background = isError ? '#bf4f68' : '#4caf50';
  t.style.boxShadow = isError ? '0 4px 12px rgba(191,79,104,0.3)' : '0 4px 12px rgba(76,175,80,0.3)';
  t.textContent = msg;
  t.style.bottom = '70px';
  t.style.opacity = '0';
  void t.offsetWidth; 
  t.style.bottom = '90px';
  t.style.opacity = '1';
  setTimeout(() => {
    t.style.bottom = '70px';
    t.style.opacity = '0';
  }, 2500);
}

// 共通：画像ファイルを圧縮Base64に変換
function compressImageToBase64(file: File, maxWidth = 800): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        if (width > maxWidth) {
          height = Math.round(height * maxWidth / width);
          width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.6).split(',')[1]);
      };
      img.onerror = reject;
      img.src = ev.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 共通：Gemini API 呼び出し＆日本語エラーハンドリング
async function callGeminiAPI(parts: any[], jsonMode = true): Promise<string> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey || apiKey === '') {
    throw new Error('APIキーが設定されていません');
  }
  const modelName = 'gemini-3.6-flash';
  const bodyObj: any = { contents: [{ parts }] };
  if (jsonMode) {
    bodyObj.generationConfig = { responseMimeType: "application/json" };
  }

  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
  } catch {
    throw new Error('通信エラーが発生しました。電波状況を確認してください📡');
  }

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    const errorString = JSON.stringify(errorData || {}).toLowerCase();
    if (res.status === 503 || errorString.includes("high demand") || errorString.includes("overloaded")) {
      throw new Error("現在AIのサーバーが大変混み合っています💥\n数分待ってからもう一度お試しください！🙏");
    } else if (res.status === 429 || errorString.includes("quota") || errorString.includes("exhausted")) {
      throw new Error("利用制限に達しました。しばらく時間をおいてください⏳");
    } else if (res.status === 400 && errorString.includes("token")) {
      throw new Error("データ量が多すぎるため処理できませんでした。短く分けてみてください🙇‍♂️");
    } else if (res.status === 413 || errorString.includes("payload") || errorString.includes("image")) {
      throw new Error("画像の情報量が多すぎます。少し離して撮影してください📷");
    } else if (res.status === 404 || errorString.includes("not found")) {
      throw new Error("AIモデルが見つかりません。設定を確認してください⚠️");
    } else if (errorData?.error?.message) {
      throw new Error(`エラー: ${errorData.error.message}`);
    }
    throw new Error(`AI通信エラー (${res.status})`);
  }

  const data = await res.json();
  let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (jsonMode) {
    text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  }
  return text;
}

// サブスク自動追加機能（月末対応 ＆ 0時判定対応）
async function processAutoSubs() {
  if (!pair || isProcessingSubs) return;
  isProcessingSubs = true;

  try {
    const subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
    let addedNames = [];
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    const todayStr = d.toISOString().slice(0, 10); 
    const currentYM = todayStr.slice(0, 7); 
    const currentDay = parseInt(todayStr.slice(8, 10), 10);
    const lastDayOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

    for (let s of subs) {
      if (!s.date) continue;
      const targetDay = s.date === 'last' ? lastDayOfMonth : Math.min(parseInt(s.date, 10), lastDayOfMonth);

      if (currentDay >= targetDay && s.lastProcessedMonth !== currentYM) {
        const targetDateStr = `${currentYM}-${String(targetDay).padStart(2, '0')}`;
        const { error } = await supabase.rpc('add_shared_expense', {
          input_pair_id: pair, 
          input_title: `🔄 ${s.title}`, 
          input_amount: Number(s.amount), 
          input_payer_id: s.payer_id, 
          input_category: '生活',
          input_expense_date: targetDateStr,
          input_memo: '自動追加'
        });
        if (!error) {
          s.lastProcessedMonth = currentYM;
          addedNames.push(s.title);
        }
      }
    }
    
    if (addedNames.length > 0) {
      localStorage.setItem(`subs_${pair}`, JSON.stringify(subs));
      await load();
      setTimeout(() => showToast(`🔄 自動追加: ${addedNames.join(', ')}`), 500);
      render(false);
    }
  } finally {
    isProcessingSubs = false;
  }
}

// リアルタイム同期機能
async function backgroundSync() {
  if (!pair || document.visibilityState !== 'visible') return;
  
  await processAutoSubs();

  const oldExpLen = expenses.length;
  const oldSetLen = settlements.length;
  
  const [e, s] = await Promise.all([
    supabase.from('expenses').select('id').eq('pair_id', pair),
    supabase.from('settlements').select('id').eq('pair_id', pair)
  ]);
  
  const newExpLen = e.data?.length || 0;
  const newSetLen = s.data?.length || 0;
  
  if (oldExpLen !== newExpLen || oldSetLen !== newSetLen) {
    await load();
    const activeTags = ['INPUT', 'TEXTAREA', 'SELECT'];
    const isTyping = activeTags.includes(document.activeElement?.tagName || '');
    if (!isTyping || currentTab !== 'entry') {
       render(false);
       showToast('🔄 パートナーの更新を同期しました');
    }
  }
}

setInterval(backgroundSync, 5000);
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && pair) {
    await load();
    await processAutoSubs();
    const activeTags = ['INPUT', 'TEXTAREA', 'SELECT'];
    if (!activeTags.includes(document.activeElement?.tagName || '')) {
      render(false);
    }
  }
});

// 爆速起動コア
const initCache = () => {
  const cached = localStorage.getItem('pp_cache');
  if (cached) {
    try {
      const x = JSON.parse(cached);
      if (x.uid) {
        uid = x.uid; pair = x.pair; members = x.members || []; 
        expenses = x.expenses || []; settlements = x.settlements || []; balances = x.balances || [];
        render(true); 
      }
    } catch {}
  }
};
initCache();

async function boot() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return authView();
  uid = session.user.id;

  const { data, error } = await supabase.from('pair_members').select('pair_id').eq('user_id', uid).maybeSingle();
  if (error) return fail(error.message);
  if (!data) return pairView();
  
  pair = data.pair_id;
  await load();
  await processAutoSubs();
  render(false); 
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
  members = m.data || []; expenses = e.data || []; balances = b.data || []; settlements = s.data || [];

  localStorage.setItem('pp_cache', JSON.stringify({ uid, pair, members, expenses, balances, settlements }));
}

function setTab(tab: string) {
  currentTab = tab;
  ['entry', 'home', 'history', 'settings', 'utilities', 'schedule', 'minigame', 'recipe', 'tickets'].forEach(x => {
    const el = q('#sec-' + x);
    if (el) el.style.display = (x === tab) ? 'block' : 'none';
  });
  q('#menuDrawer')?.classList.add('hide');
  document.querySelectorAll('.tabs button').forEach((b: any) => {
    if (['entry', 'home', 'history', 'settings'].includes(b.dataset.tab)) {
      b.style.fontWeight = b.dataset.tab === tab ? '900' : 'normal';
      b.style.color = b.dataset.tab === tab ? '#e7617d' : '#9b7783';
    }
  });
}

async function render(isInitial = false) {
  const currentAmt = val('#amount');
  const currentTitle = val('#title');

  let pairName = 'ふたりの家計'; let inviteCode = '';
  if (!isInitial) {
    const { data: p } = await supabase.from('pairs').select('name,invite_code').eq('id', pair).single();
    if (p) { pairName = p.name; inviteCode = p.invite_code; }
  }

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
    const fId = s.from_user_id; const tId = s.to_user_id;
    if (fId && bals[fId] !== undefined) bals[fId] += Number(s.amount);
    if (tId && bals[tId] !== undefined) bals[tId] -= Number(s.amount);
  });

  let amount = 0; let receiver = members[0]?.user_id; let sender = members[1]?.user_id;
  if (members.length === 2) {
    const u1 = members[0].user_id; const u2 = members[1].user_id;
    if (bals[u1] > 0) { receiver = u1; sender = u2; amount = bals[u1]; } 
    else { receiver = u2; sender = u1; amount = Math.abs(bals[u2] || 0); }
  }

  const stateObj = { amount, sender, receiver };

  const months = Array.from(new Set([
    ...expenses.map(e => (e.expense_date || '').slice(0, 7)),
    ...settlements.map(s => new Date(s.settled_at).toISOString().slice(0, 7))
  ])).filter(Boolean).sort().reverse();

  const filteredExpenses = expenses.filter(e => currentMonth === 'all' || e.expense_date?.startsWith(currentMonth));
  const filteredSettlements = settlements.filter(s => currentMonth === 'all' || new Date(s.settled_at).toISOString().startsWith(currentMonth));
  const myName = members.find(m => m.user_id === uid)?.profiles?.display_name || '自分';
  const partnerMember = members.find(m => m.user_id !== uid);
  const partnerName = partnerMember?.profiles?.display_name || '相手';
  
  const subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
  const utils = JSON.parse(localStorage.getItem(`utils_${pair}`) || '[]');
  const tickets = JSON.parse(localStorage.getItem(`tickets_${pair}`) || '[]');
  const schedules = JSON.parse(localStorage.getItem(`sched_${pair}`) || '[]').map((s:any) => ({
    ...s, startDate: s.startDate || s.date, endDate: s.endDate || s.date,
    startTime: s.startTime || '', endTime: s.endTime || '', recurrence: s.recurrence || 'none'
  }));

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
    const width = 320; const height = 130; const padX = 30; const padY = 20;
    const usableW = width - padX * 2; const usableH = height - padY * 2;
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

  const timeline: any[] = [];
  filteredExpenses.forEach(e => timeline.push({ type: 'expense', raw: e.created_at || (e.expense_date + 'T00:00:00Z'), data: e }));
  filteredSettlements.forEach(s => timeline.push({ type: 'settlement', raw: s.settled_at, data: s }));

  timeline.sort((a, b) => {
    const tA = new Date(a.raw).getTime(); const tB = new Date(b.raw).getTime();
    if (!isNaN(tA) && !isNaN(tB)) return tB - tA; return 0; 
  });

  let timelineHtml = '';
  timeline.forEach(item => {
    if (item.type === 'settlement') {
      const s = item.data;
      const tStr = fmtTime(item.raw);
      timelineHtml += `<div style="border-top: 2px dashed #d95875; margin: 28px 0 20px; position: relative;">
        <span style="position: absolute; top: -11px; left: 50%; transform: translateX(-50%); background: #fff; padding: 0 12px; color: #d95875; font-size: 11px; font-weight: bold; white-space: nowrap; border-radius: 12px; border: 1px solid #d95875;">
          ✂️ 精算完了: ${yen(s.amount)} (${tStr})
        </span>
      </div>`;
    } else {
      const e = item.data;
      const tStr = fmtTime(item.raw, e.memo, e.expense_date);
      const isDel = typeof e.title === 'string' && e.title.startsWith('[削除済]');
      const receiptItems = parseReceiptMemo(e.memo);
      
      let editInfoHtml = '';
      if (!isDel && e.updated_at && e.created_at && new Date(e.updated_at).getTime() - new Date(e.created_at).getTime() > 1000) {
        const updatedDate = new Date(e.updated_at);
        const updStr = `${updatedDate.getFullYear()}/${String(updatedDate.getMonth() + 1).padStart(2, '0')}/${String(updatedDate.getDate()).padStart(2, '0')}`;
        editInfoHtml = `<div style="font-size: 10px; color: #b5a6ac; margin-top: 2px;">✏️ 編集済 (${updStr})</div>`;
      }

      let displayTitle = e.title; let delName = '';
      if (isDel) {
        const parts = e.title.replace('[削除済] ', '').split('::');
        delName = name(parts[0]); displayTitle = parts.slice(1).join('::');
      }

      // ★ レシート内訳がある場合は、金額自体をタップ可能なボタンにして内訳を見れるようにする
      let amountDisplayHtml = '';
      if (isDel) {
        amountDisplayHtml = `<del style="color:#b5a6ac;"><b>${yen(e.amount)}</b></del>`;
      } else if (receiptItems) {
        amountDisplayHtml = `<button class="view-receipt-detail" data-id="${e.id}" title="タップしてレシート内訳を表示" style="background:#fff0f3; border:1px solid #ffccd5; color:#e7617d; padding:4px 10px; border-radius:10px; font-weight:800; font-size:15px; cursor:pointer; display:inline-flex; align-items:center; gap:4px;">🧾 ${yen(e.amount)} <span style="font-size:10px;">▾</span></button>`;
      } else {
        amountDisplayHtml = `<b>${yen(e.amount)}</b>`;
      }

      timelineHtml += `<div class="expense ${isDel ? 'deleted-log' : ''}">
        <div class="expense-left">
          ${isDel ? `<del style="color:#b5a6ac;"><b class="break-text">${esc(displayTitle)}</b></del>` : `<b class="break-text">${esc(displayTitle)}</b>`}
          <div class="muted break-text" style="margin-top: 4px; font-size: 12px;">
            ${isDel ? `<span class="deleted-badge">削除者: ${esc(delName)}</span>` : ''}
            ${esc(name(e.payer_id))}・${tStr}
          </div>
          ${editInfoHtml}
        </div>
        <div class="expense-right">
          ${amountDisplayHtml}
          <div style="margin-top: 6px; display: flex; gap: 6px; justify-content: flex-end;">
            ${!isDel ? `
              <button class="edit ghost" data-id="${e.id}" style="padding: 4px 10px; font-size: 12px; color: #5995bd; border-radius: 8px;">編集</button>
              <button class="del ghost" data-id="${e.id}" style="padding: 4px 10px; font-size: 12px; color: #bf4f68; border-radius: 8px;">削除</button>
            ` : `<button class="restore ghost" data-id="${e.id}" style="padding: 4px 10px; font-size: 12px; color: #765d8b; border-radius: 8px;">戻す</button>`}
          </div>
        </div>
      </div>`;
    }
  });

  if (timeline.length === 0) timelineHtml = '<p class="muted" style="text-align: center; padding: 20px 0;">まだありません</p>';

  const fmtSubDate = (d: any) => {
    if (!d) return '-';
    if (d === 'last') return '月末';
    return `${d}日`;
  };

  const activeTickets = tickets.filter((t: any) => !t.used);
  const usedTickets = tickets.filter((t: any) => t.used);

  app.innerHTML = `
    <style>
      .sched-mode-btn { flex: 1; padding: 11px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; border: none; cursor: pointer; transition: 0.2s; white-space: nowrap;}
      .sched-mode-btn.active { background: #ff8fa3; color: #fff; box-shadow: 0 4px 10px #ff8fa344; }
      .sched-mode-btn.inactive { background: #fff0f3; color: #a76777; }
      .ticket-card { background: #fffafb; border: 1px solid #f0dfe4; border-left: 6px dashed #ff8fa3; border-radius: 14px; padding: 14px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
      .chip-btn { display: inline-block; background: #fff0f3; color: #a76777; padding: 6px 12px; border-radius: 16px; font-size: 12px; font-weight: bold; margin: 0 6px 6px 0; border: 1px solid #f5dce2; cursor: pointer; }
      .chip-btn.selected { background: #ff8fa3; color: #fff; border-color: #ff8fa3; }
    </style>
    <main class="app">
      <div class="top" style="margin-top: 10px; position: relative;">
        <div><div class="brand">♥ PairPocket</div><div class="muted" style="margin-left: 2px;">${esc(pairName)}</div></div>
        <button id="menuBtn" class="ghost" style="padding: 8px 14px; font-size: 20px; position: absolute; right: 0; top: 0; border-radius: 12px;">☰</button>
      </div>
      
      <!-- ☰ サイドメニュー -->
      <div id="menuDrawer" class="hide" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.4); z-index: 9999; backdrop-filter: blur(2px);">
        <div id="menuContent" style="position: absolute; top: 0; right: 0; bottom: 0; width: 270px; background: #fffcfc; padding: 20px; box-shadow: -4px 0 15px rgba(0,0,0,0.1); overflow-y: auto;">
          <button id="closeDrawerBtn" class="ghost" style="position: absolute; top: max(20px, env(safe-area-inset-top)); right: 20px; border-radius: 50%; width: 40px; height: 40px; padding: 0; display:flex; align-items:center; justify-content:center; font-size: 20px;">×</button>
          <div style="margin-top: calc(max(20px, env(safe-area-inset-top)) + 45px);">
            <div class="muted" style="margin-bottom: 10px; font-weight: bold;">🤖 AI ＆ お楽しみ機能</div>
            <button data-nav="recipe" class="ghost full" style="margin-bottom: 10px; text-align: left; font-size: 15px; padding: 14px; background:#fff7f0; color:#b56331; font-weight:bold;"><span style="font-size: 18px; margin-right: 8px;">🍳</span> 今日のAI献立提案</button>
            <button data-nav="tickets" class="ghost full" style="margin-bottom: 10px; text-align: left; font-size: 15px; padding: 14px; background:#fff0f6; color:#bf4f68; font-weight:bold;"><span style="font-size: 18px; margin-right: 8px;">🎟️</span> ご褒美・おねだり券</button>
            <button data-nav="minigame" class="ghost full" style="margin-bottom: 18px; text-align: left; font-size: 15px; padding: 14px; background:#fff0f3; color:#a76777; font-weight:bold;"><span style="font-size: 18px; margin-right: 8px;">🎮</span> 待ち時間ミニゲーム</button>

            <div class="muted" style="margin-bottom: 10px; font-weight: bold;">📋 暮らしの管理</div>
            <button data-nav="schedule" class="ghost full" style="margin-bottom: 10px; text-align: left; font-size: 15px; padding: 14px;"><span style="font-size: 18px; margin-right: 8px;">📅</span> ふたりの予定</button>
            <button data-nav="utilities" class="ghost full" style="margin-bottom: 10px; text-align: left; font-size: 15px; padding: 14px;"><span style="font-size: 18px; margin-right: 8px;">💧</span> 水道・光熱費</button>
          </div>
        </div>
      </div>

      <!-- メイン①：入力タブ -->
      <section id="sec-entry">
        <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 15px; margin-bottom: 15px; padding: 0 4px;">
          <h2 style="margin: 0; font-size: 20px; color: #3e3438;">新しく追加</h2>
          <button id="saveTop" class="primary" style="padding: 12px 24px; font-size: 16px; border-radius: 20px; box-shadow: 0 4px 12px rgba(255, 130, 156, 0.4);">追加する</button>
        </div>

        <div class="card" style="margin-top: 0;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 6px;">
            <label class="muted" style="white-space: nowrap;">相手への請求額</label>
            <div style="display: flex; gap: 6px;">
              <button id="btnSmartInput" class="ghost" style="padding: 6px 10px; font-size: 12px; background: #f0f4ff; color: #4361ee; border-radius: 12px; font-weight: bold;">🪄 AI文章入力</button>
              <button id="btnReceipt" class="ghost" style="padding: 6px 10px; font-size: 12px; background: #ffe5e9; color: #a13c52; border-radius: 12px; font-weight: bold;">📷 レシート読込</button>
            </div>
            <input type="file" id="receiptInput" accept="image/*" style="display:none;">
          </div>

          <div class="money">
            <span>¥</span>
            <input type="text" id="amount" inputmode="numeric" placeholder="1200+350" value="${currentAmt}">
          </div>
          
          <div class="calc-buttons">
            <button type="button" data-op="+">＋</button><button type="button" data-op="-">－</button>
            <button type="button" data-op="*">×</button><button type="button" data-op="/">÷</button>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 8px;">
            <div id="result" class="result" style="margin: 0;">計算結果：¥0</div>
            ${pendingReceiptItems.length > 0 ? `
              <button id="reopenReceiptBtn" type="button" class="ghost" style="padding: 6px 12px; font-size: 12px; background: #fff0f3; color: #e7617d; border: 1px solid #ffccd5; border-radius: 12px; font-weight: bold; white-space: nowrap;">
                🧾 内訳を見る・再編集 (${pendingReceiptItems.length}品)
              </button>
            ` : ''}
          </div>
          
          <div class="quick">
            <button data-plus="100">+100</button><button data-plus="500">+500</button>
            <button data-plus="1000">+1,000</button><button id="clear">クリア</button>
          </div>
          
          <button id="split" class="split">÷ 2人で割り勘</button>
          
          <label class="muted" style="margin-top: 20px; display: block;">立て替えた人</label>
          <div class="payer-buttons">${members.map((m) => `<button type="button" class="payer-btn ${m.user_id === uid ? 'selected' : ''}" data-payer="${m.user_id}">${esc(name(m.user_id))}</button>`).join('')}</div>
          <input id="payer" type="hidden" value="${uid}">
          
          <div style="border-top: 1px solid #f0dfe4; margin: 20px 0 15px;"></div>

          ${subs.length > 0 ? `
            <label class="muted" style="display:block; margin-bottom:6px;">定額・サブスクから入力</label>
            <div style="overflow-x: auto; white-space: nowrap; padding-bottom: 8px; margin-bottom: 15px;">
              ${subs.map((s:any) => `<div class="sub-fill-btn sub-chip" data-id="${s.id}" style="font-size:12px; padding:6px 12px;">${esc(s.title)}</div>`).join('')}
            </div>
          ` : ''}

          <label class="muted">内容（任意）</label>
          <input id="title" class="field" placeholder="例：カフェ、スーパー" value="${currentTitle}">
          
          <label class="muted">カテゴリー</label>
          <select id="cat" class="field">
            <option value="" selected>カテゴリーなし</option>
            ${['食費', '外食', '生活', '家賃', '光熱費', '交通', '娯楽', '旅行', 'その他'].map(x => `<option value="${x}">${x}</option>`).join('')}
          </select>
        </div>
      </section>

      <!-- メイン②：精算タブ -->
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

      <!-- メイン③：履歴タブ -->
      <section id="sec-history">
        <div class="card" style="padding: 12px 14px; margin-top: 20px; display: flex; gap: 8px; align-items: center;">
          <select id="monthSelect" class="field" style="margin:0; font-weight:bold; flex: 1;">
            <option value="all" ${currentMonth === 'all' ? 'selected' : ''}>すべての履歴を表示</option>
            ${months.map(m => `<option value="${m}" ${currentMonth === m ? 'selected' : ''}>${m.split('-')[0]}年${m.split('-')[1]}月</option>`).join('')}
          </select>
          <button id="btnAiAnalyst" class="ghost" style="padding: 10px 12px; font-size: 12px; font-weight: bold; background: #fff0f6; color: #bf4f68; border-radius: 12px; white-space: nowrap;">🤖 AI分析</button>
        </div>
        <div class="card history-scroll">
          <div style="display:flex; justify-content:space-between; align-items:center; position: sticky; top: 0; background: #fff; padding-bottom: 5px; z-index: 1;">
            <h2 style="margin: 0;">タイムライン</h2>
            <span class="muted" style="font-size:11px;">🧾マークの金額をタップで内訳表示</span>
          </div>
          <div style="margin-top: 10px;">${timelineHtml}</div>
        </div>
        <div class="card history-scroll">
          <h2 style="position: sticky; top: 0; background: #fff; padding-bottom: 5px; margin-top: 0; z-index: 1;">精算履歴 (取り消し用)</h2>
          ${filteredSettlements.map(s => `<div class="expense"><div class="expense-left"><b class="break-text">${esc(name(s.from_user_id))} → ${esc(name(s.to_user_id))}</b><div class="muted">${new Date(s.settled_at).toLocaleDateString('ja-JP')}</div></div><div class="expense-right"><b style="font-size: 16px;">${yen(s.amount)}</b><br><button class="undo-settle ghost" data-id="${s.id}" style="color:#bf4f68; padding:4px 10px; font-size:11px; margin-top:6px; border-radius:6px;">取り消す</button></div></div>`).join('') || '<p class="muted">まだありません</p>'}
        </div>
      </section>

      <!-- サブ機能①：🍳 今日のAI献立提案 -->
      <section id="sec-recipe" style="display: none;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; margin-top: 10px;">
          <h2 style="margin: 0; font-size: 18px;">🍳 冷蔵庫からAI献立提案</h2>
        </div>
        <div class="card">
          <label class="muted">家にある食材・使いたいもの</label>
          <input id="recipeIngredients" class="field" placeholder="例：豚肉、キャベツ、卵、豆腐" style="margin-top: 6px;">

          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 14px;">
            <button id="btnRecipePhoto" class="ghost" style="font-size: 12px; padding: 8px 12px; background: #fff7f0; color: #b56331; border-radius: 10px; font-weight: bold;">📷 冷蔵庫・食材を撮影</button>
            <span id="recipePhotoStatus" class="muted" style="font-size: 12px;">${recipeImageBase64 ? '✅ 写真セット済み' : '写真なしでもOK'}</span>
            <input type="file" id="recipePhotoInput" accept="image/*" style="display:none;">
          </div>

          <label class="muted" style="display:block; margin-bottom: 6px;">今日の気分</label>
          <div style="margin-bottom: 15px;">
            ${['時短・簡単', 'ガッツリ満腹', 'ヘルシー', 'おつまみ・晩酌', '節約レシピ'].map(m => `<span class="chip-btn recipe-mood-chip ${recipeMood === m ? 'selected' : ''}" data-mood="${m}">${m}</span>`).join('')}
          </div>

          <button id="btnGenerateRecipe" class="primary full" style="padding: 14px; font-size: 15px;">🍳 AIに3品提案してもらう</button>
        </div>

        <div id="recipeResultWrap" class="card" style="display: ${lastRecipeHtml ? 'block' : 'none'};">
          <h2 style="margin-top: 0;">AIのおすすめ献立</h2>
          <div id="recipeResultContent">${lastRecipeHtml}</div>
        </div>
      </section>

      <!-- サブ機能⑧：🎟️ ご褒美・おねだりチケット -->
      <section id="sec-tickets" style="display: none;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; margin-top: 10px;">
          <h2 style="margin: 0; font-size: 18px;">🎟️ ご褒美・おねだりチケット</h2>
        </div>

        <div class="card" style="background: #fffafb; border: 1px solid #f0dfe4;">
          <h2 style="margin-top: 0;">チケットを発行する</h2>
          <label class="muted" style="display:block; margin-bottom: 6px;">定番から選ぶ</label>
          <div style="margin-bottom: 10px;">
            ${['☕ カフェ奢り券', '🚗 運転交代パス券', '🍳 好きな料理リクエスト券', '🍦 アイス買ってもらえる券', '💆 肩もみ10分券'].map(t => `<span class="chip-btn ticket-preset-chip" data-title="${t}">${t}</span>`).join('')}
          </div>
          <input id="ticketTitle" class="field" placeholder="チケット名 (例: スタバ新作奢り券)">
          <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 12px;">
            <span class="muted" style="font-size: 12px; font-weight: bold; white-space: nowrap;">使える人：</span>
            <select id="ticketHolder" class="field" style="margin: 0; flex: 1;">
              ${members.map(m => `<option value="${m.user_id}" ${m.user_id !== uid ? 'selected' : ''}>${esc(name(m.user_id))} が使える券</option>`).join('')}
            </select>
          </div>
          <button id="btnAddTicket" class="primary full" style="padding: 12px;">🎟️ チケットを発行！</button>
        </div>

        <div class="card">
          <h2 style="margin-top: 0;">使えるチケット (${activeTickets.length}枚)</h2>
          ${activeTickets.map((t: any) => `
            <div class="ticket-card">
              <div>
                <div style="font-weight: 800; font-size: 15px; color: #3e3438;">${esc(t.title)}</div>
                <div class="muted" style="font-size: 12px; margin-top: 4px;">所有者: <b style="color:#e7617d;">${esc(name(t.holder))}</b> (${esc(t.createdAt)})</div>
              </div>
              <div style="display: flex; gap: 6px;">
                <button class="use-ticket-btn primary" data-id="${t.id}" style="padding: 8px 14px; font-size: 12px; border-radius: 12px;">✨ 使う</button>
                <button class="del-ticket-btn ghost" data-id="${t.id}" style="padding: 8px 10px; font-size: 11px; color: #b5a6ac;">×</button>
              </div>
            </div>
          `).join('') || '<p class="muted" style="text-align: center; padding: 15px 0;">まだ未使用のチケットはありません</p>'}
        </div>

        ${usedTickets.length > 0 ? `
          <div class="card">
            <h2 style="margin-top: 0; font-size: 15px; color: #9b8d93;">使用済みチケット履歴</h2>
            ${usedTickets.slice().reverse().slice(0, 10).map((t: any) => `
              <div style="display:flex; justify-content:space-between; align-items:center; padding: 8px 0; border-bottom: 1px solid #f5e9ed; font-size: 13px; color: #9b8d93;">
                <div><del>${esc(t.title)}</del> (${esc(name(t.holder))})</div>
                <div style="font-size: 11px;">使用済: ${esc(t.usedAt || '')}</div>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </section>

      <!-- サブ機能②：🎮 待ち時間ミニゲーム -->
      <section id="sec-minigame" style="display: none;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; margin-top: 10px;">
          <h2 style="margin: 0; font-size: 18px;">🎮 ふたりで待ち時間対戦</h2>
        </div>
        
        <div style="display: flex; gap: 6px; margin-bottom: 15px;">
          <button id="btnGameReact" class="sched-mode-btn ${miniGameMode === 'react' ? 'active' : 'inactive'}">⚡ 反射神経</button>
          <button id="btnGameBomb" class="sched-mode-btn ${miniGameMode === 'bomb' ? 'active' : 'inactive'}">💣 爆弾</button>
          <button id="btnGameQuiz" class="sched-mode-btn ${miniGameMode === 'quiz' ? 'active' : 'inactive'}">🤖 AIクイズ</button>
        </div>

        <div id="wrapGameReact" class="card" style="padding: 12px; text-align: center; display: ${miniGameMode === 'react' ? 'block' : 'none'};">
          <div style="display:flex; justify-content:space-around; margin-bottom:12px; font-weight:bold; font-size:15px;">
            <span style="color:#5995bd;">${esc(partnerName)}: <span id="reactScoreP2" style="font-size:20px;">${reactScoreP2}</span> 点</span>
            <span style="color:#e7617d;">${esc(myName)}: <span id="reactScoreP1" style="font-size:20px;">${reactScoreP1}</span> 点</span>
          </div>
          <div style="display:flex; flex-direction:column; height:320px; border-radius:16px; overflow:hidden; border:2px solid #f0dfe4; position:relative;">
            <button id="reactBtnP2" style="flex:1; border:none; background:#f0f4f8; font-size:18px; font-weight:bold; color:#5995bd; transform:rotate(180deg); display:flex; align-items:center; justify-content:center; cursor:pointer; user-select:none;">タップしてね (3点先取)</button>
            <div id="reactStatus" style="height:44px; background:#3e3438; color:#fff; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:bold; letter-spacing:1px;">スタートを押してね</div>
            <button id="reactBtnP1" style="flex:1; border:none; background:#fff0f3; font-size:18px; font-weight:bold; color:#e7617d; display:flex; align-items:center; justify-content:center; cursor:pointer; user-select:none;">タップしてね (3点先取)</button>
          </div>
          <button id="reactStartBtn" class="primary full" style="margin-top:14px; padding:12px; font-size:16px;">対戦スタート！</button>
        </div>

        <div id="wrapGameBomb" class="card" style="text-align:center; padding: 20px 15px; display: ${miniGameMode === 'bomb' ? 'block' : 'none'};">
          <div id="bombMsg" style="font-weight:bold; color:#a76777; margin-bottom:15px; font-size:16px;">交互にタップ！ハズレ(💣)で負け！</div>
          <div id="bombGrid" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:20px;"></div>
          <button id="bombResetBtn" class="dark full" style="padding:12px;">新しく始める</button>
        </div>

        <div id="wrapGameQuiz" class="card" style="padding: 16px; display: ${miniGameMode === 'quiz' ? 'block' : 'none'};">
          <div style="display:flex; justify-content:space-around; align-items:center; margin-bottom:14px; background:#fffafb; padding:10px; border-radius:12px; border:1px solid #f0dfe4;">
            <div style="text-align:center;">
              <div style="font-size:12px; color:#5995bd; font-weight:bold;">${esc(partnerName)}</div>
              <b id="quizScoreP2Label" style="font-size:20px; color:#5995bd;">${quizScoreP2}点</b>
              <button id="btnQuizPlusP2" class="ghost" style="padding:2px 8px; font-size:11px; margin-left:4px;">+1</button>
            </div>
            <div style="color:#d5c5cb; font-weight:bold;">VS</div>
            <div style="text-align:center;">
              <div style="font-size:12px; color:#e7617d; font-weight:bold;">${esc(myName)}</div>
              <b id="quizScoreP1Label" style="font-size:20px; color:#e7617d;">${quizScoreP1}点</b>
              <button id="btnQuizPlusP1" class="ghost" style="padding:2px 8px; font-size:11px; margin-left:4px;">+1</button>
            </div>
          </div>

          <label class="muted" style="font-size:12px;">クイズのテーマ（自由入力OK）</label>
          <div style="margin: 6px 0;">
            ${['テーマパーク雑学', 'K-POP', '平成レトロ', 'グルメ・料理', 'ドライブ・地理', '動物雑学'].map(t => `<span class="chip-btn quiz-theme-chip" data-theme="${t}">${t}</span>`).join('')}
          </div>
          <div style="display:flex; gap:6px; margin-bottom:12px;">
            <input id="quizThemeInput" class="field" placeholder="例: ディズニー、TWICE、雑学" value="テーマパーク雑学" style="margin:0; flex:1;">
            <select id="quizDiffSelect" class="field" style="margin:0; width:105px;">
              <option value="やさしい">やさしい</option>
              <option value="ふつう" selected>ふつう</option>
              <option value="マニアック">マニアック</option>
            </select>
          </div>
          <button id="btnGenerateQuiz" class="primary full" style="padding:12px; font-size:15px;">🎲 AIでクイズを出題！</button>

          <div id="quizPlayArea" style="margin-top: 16px;"></div>
        </div>
      </section>

      <!-- サブ機能：📅 ふたりの予定 -->
      <section id="sec-schedule">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; margin-top: 10px;">
          <h2 style="margin: 0; font-size: 18px;">📅 ふたりの予定</h2>
        </div>
        
        <div class="card" style="background: #fffafb; border: 1px solid #f0dfe4;">
          <h2>新しい予定を登録</h2>
          <input id="schedTitle" class="field" placeholder="予定 (例: ディズニー旅行)" style="margin-bottom: 15px;">
          
          <div style="display:flex; gap:8px; margin-bottom: 15px;">
             <button id="btnModeMulti" class="sched-mode-btn active">📅 カレンダーで複数日</button>
             <button id="btnModeSpan" class="sched-mode-btn inactive">期間・繰り返し</button>
          </div>

          <div id="wrapMulti">
            <div style="display:flex; justify-content:space-between; align-items:center; background:#fff; padding:6px 12px; border-radius:12px; border:1px solid #f0dfe4;">
               <button id="calPrev" class="ghost" style="padding:4px 12px; font-size:16px;">◀</button>
               <span id="schedCalMonthLabel" style="font-weight:bold; color:#e7617d;"></span>
               <button id="calNext" class="ghost" style="padding:4px 12px; font-size:16px;">▶</button>
            </div>
            <div style="display:grid; grid-template-columns:repeat(7,1fr); text-align:center; font-size:11px; margin-top:10px; font-weight:bold;" class="muted">
               <div style="color:#bf4f68;">日</div><div>月</div><div>火</div><div>水</div><div>木</div><div>金</div><div style="color:#7ab8e6;">土</div>
            </div>
            <div id="schedCalGrid" style="display:grid; grid-template-columns:repeat(7,1fr); gap:6px; margin-top:6px; padding-bottom:10px;"></div>
          </div>

          <div id="wrapSpan" class="hide">
            <div style="display:flex; gap:8px; align-items: center; margin-bottom: 8px;">
              <span style="font-size: 12px; font-weight:bold; color:#a76777; width: 35px;">開始</span>
              <input id="schedStartDate" type="date" class="field" style="margin:0; flex:1;" value="${getToday()}">
            </div>
            <div style="display:flex; gap:8px; align-items: center; margin-bottom: 8px;">
              <span style="font-size: 12px; font-weight:bold; color:#a76777; width: 35px;">終了</span>
              <input id="schedEndDate" type="date" class="field" style="margin:0; flex:1;" value="${getToday()}">
            </div>
            <div style="display:flex; gap:8px; align-items: center; margin-bottom: 10px;">
              <span style="font-size: 12px; font-weight:bold; color:#a76777; width: 35px;">繰返</span>
              <select id="schedRecurrence" class="field" style="margin:0; flex:1;">
                <option value="none">繰り返さない</option>
                <option value="daily">毎日</option>
                <option value="weekly">毎週</option>
                <option value="monthly">毎月</option>
                <option value="yearly">毎年</option>
              </select>
            </div>
          </div>

          <div style="border-top: 1px solid #f0dfe4; margin: 15px 0;"></div>
          
          <div style="display:flex; gap:8px; align-items: center; margin-bottom: 15px;">
            <span style="font-size: 12px; font-weight:bold; color:#a76777; width: 35px;">時間</span>
            <input id="schedStartTime" type="time" class="field" style="margin:0; flex:1;">
            <span style="color:#a76777; font-weight:bold;">〜</span>
            <input id="schedEndTime" type="time" class="field" style="margin:0; flex:1;">
          </div>

          <button id="addSchedBtn" class="primary full" style="padding: 14px;">リストに追加</button>
        </div>

        <div class="card history-scroll">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h2 style="margin: 0;">今後の予定</h2>
            <button id="exportAllSchedBtn" class="ghost" style="padding: 6px 12px; font-size: 12px; font-weight: bold; border-radius: 8px;">📥 すべて書き出す</button>
          </div>
          <p class="muted" style="margin-top:8px;">「すべて書き出す」で、スマホのカレンダーに一括で登録できます（重複しません）。</p>
          ${schedules.slice().sort((a:any, b:any) => a.startDate.localeCompare(b.startDate)).map((s:any) => {
            let displayTime = s.startDate.replace(/-/g, '/');
            if (s.startTime) displayTime += ` ${s.startTime}`;
            if (s.endDate && s.endDate !== s.startDate) {
              displayTime += ` 〜 ${s.endDate.replace(/-/g, '/')}`;
              if (s.endTime) displayTime += ` ${s.endTime}`;
            } else if (s.endTime) {
              displayTime += ` 〜 ${s.endTime}`;
            }
            
            let recurText = '';
            if (s.recurrence === 'daily') recurText = ' <span style="background:#fff0f3; color:#a76777; padding:3px 8px; border-radius:6px; font-size:10px; font-weight:bold;">毎日</span>';
            if (s.recurrence === 'weekly') recurText = ' <span style="background:#fff0f3; color:#a76777; padding:3px 8px; border-radius:6px; font-size:10px; font-weight:bold;">毎週</span>';
            if (s.recurrence === 'monthly') recurText = ' <span style="background:#fff0f3; color:#a76777; padding:3px 8px; border-radius:6px; font-size:10px; font-weight:bold;">毎月</span>';
            if (s.recurrence === 'yearly') recurText = ' <span style="background:#fff0f3; color:#a76777; padding:3px 8px; border-radius:6px; font-size:10px; font-weight:bold;">毎年</span>';

            return `
            <div style="padding: 14px 0; border-bottom: 1px solid #f5e9ed;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div>
                  <b style="font-size: 16px; color:#e7617d;">${esc(s.title)}${recurText}</b>
                  <div class="muted" style="font-weight:bold; margin-top:4px;">${displayTime}</div>
                </div>
                <button class="del-sched ghost" data-id="${s.id}" style="color:#bf4f68; padding:6px 10px; font-size:11px; border-radius:6px; background:transparent;">削除</button>
              </div>
            </div>
          `}).join('') || '<p class="muted" style="text-align:center; padding:10px 0;">まだ予定はありません</p>'}
        </div>
      </section>

      <!-- サブ機能：💧 水道・光熱費 -->
      <section id="sec-utilities">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; margin-top: 10px;">
          <button id="closeUtils" class="ghost" style="padding: 10px 14px; visibility: hidden;">戻る</button>
          <h2 style="margin: 0; font-size: 18px;">💧 水道・光熱費</h2>
          <div style="width: 60px;"></div>
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
        <div class="card history-scroll">
          <h2>履歴</h2>
          ${utils.slice().reverse().map((u:any) => `<div style="display:flex; justify-content:space-between; align-items:center; padding: 12px 0; border-bottom:1px solid #f5e9ed;"><div><b style="font-size:15px; color:${u.type==='water'?'#5995bd':'#d88c5f'}">${u.type === 'water' ? '水道代' : '光熱費'}</b><div class="muted" style="font-size:12px; margin-top: 2px;">${u.month}</div></div><div style="text-align:right;"><b style="font-size: 16px;">${yen(u.amount)}</b><br><button class="del-util ghost" data-id="${u.id}" style="color:#bf4f68; padding:4px 10px; font-size:11px; margin-top:6px; border-radius:6px;">削除</button></div></div>`).join('') || '<p class="muted" style="text-align:center; padding:10px 0;">まだありません</p>'}
        </div>
      </section>

      <!-- メイン④：設定タブ -->
      <section id="sec-settings">
        <div class="card" style="margin-top: 20px;">
          <h2>招待コード</h2>
          <div class="big" style="color: #e7617d;">${esc(inviteCode)}</div><p class="muted">${members.length}/2人</p>
        </div>

        <div class="card">
          <h2>サブスク・定額の管理</h2>
          <p class="muted" style="font-size:12px; margin-top:0;">指定日の0時以降に自動追加されます。「月末」を選ぶと30日や28日の月も自動で末日に調整されます。</p>
          <div id="subsList" style="margin-bottom: 12px;">
            ${subs.map((s:any) => `<div style="display:flex; justify-content:space-between; align-items:center; padding: 10px 0; border-bottom:1px solid #f5e9ed;"><div><b style="font-size:14px;">${esc(s.title)}</b><br><span class="muted" style="font-size:12px;">${yen(s.amount)} (毎月${fmtSubDate(s.date)} / 支払: ${esc(name(s.payer_id))})</span></div><button class="del-sub ghost" data-id="${s.id}" style="color:#bf4f68; padding:6px 10px; font-size:12px; border-radius: 8px;">削除</button></div>`).join('') || '<p class="muted" style="text-align:center; padding: 10px 0;">登録されていません</p>'}
          </div>
          <div style="background: #fffafb; padding: 12px; border-radius: 12px; border: 1px solid #f0dfe4;">
            <label class="muted" style="font-size:12px;">新しいサブスクを登録</label>
            <div style="display:flex; gap:6px; margin-top:4px;">
              <input id="subTitle" class="field" placeholder="名前 (例: 家賃)" style="margin:0; flex:1;">
              <input id="subAmount" type="number" class="field" placeholder="金額" style="margin:0; width:95px;">
            </div>
            <div style="display:flex; gap:6px; margin-top:8px;">
              <select id="subDate" class="field" style="margin:0; width:130px;">
                <option value="last">毎月 月末</option>
                ${Array.from({length: 31}, (_, i) => i + 1).map(d => `<option value="${d}">毎月 ${d}日</option>`).join('')}
              </select>
              <select id="subPayer" class="field" style="margin:0; flex:1;">
                ${members.map((m) => `<option value="${m.user_id}" ${m.user_id === uid ? 'selected' : ''}>${esc(name(m.user_id))}が支払う</option>`).join('')}
              </select>
            </div>
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

        <div style="text-align: center; margin-top: 30px; font-size: 11px; color: #b5a6ac; font-weight: bold;">
          App Version: 19.0.0<br>（レシート金額タップ内訳表示 搭載版）
        </div>
      </section>

      <nav class="tabs">
        <button data-tab="entry">＋ 入力</button>
        <button data-tab="home">精算</button>
        <button data-tab="history">履歴</button>
        <button data-tab="settings">設定</button>
      </nav>

      <!-- モーダル1：支出の編集 -->
      <div id="editModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 10000; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(4px);">
        <div class="card" style="width: 100%; max-width: 400px; max-height: 85vh; display: flex; flex-direction: column; overflow-y: auto;">
          <h2 style="margin-top: 0; font-size: 20px;">支出を編集</h2>
          <input type="hidden" id="editId">
          <label class="muted">金額</label>
          <div class="money" style="margin-bottom: 15px;">
            <span>¥</span>
            <input type="number" id="editAmount" class="field" style="margin:0;">
          </div>
          <label class="muted">内容</label>
          <input id="editTitle" class="field" style="margin-bottom: 15px;">
          <label class="muted">カテゴリー</label>
          <select id="editCat" class="field" style="margin-bottom: 15px;">
            <option value="">カテゴリーなし</option>
            ${['食費', '外食', '生活', '家賃', '光熱費', '交通', '娯楽', '旅行', 'その他'].map(x => `<option value="${x}">${x}</option>`).join('')}
          </select>
          <label class="muted">日付</label>
          <input type="date" id="editDate" class="field" style="margin-bottom: 15px;">
          <label class="muted">立て替えた人</label>
          <select id="editPayer" class="field" style="margin-bottom: 20px;">
            ${members.map((m) => `<option value="${m.user_id}">${esc(name(m.user_id))}</option>`).join('')}
          </select>
          <div style="display: flex; gap: 10px;">
            <button id="closeEditBtn" class="ghost full">キャンセル</button>
            <button id="saveEditBtn" class="primary full">保存する</button>
          </div>
        </div>
      </div>

      <!-- モーダル2：レシート仕分け -->
      <div id="receiptModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 10000; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(4px);">
        <div class="card" style="width: 100%; max-height: 85vh; display: flex; flex-direction: column; overflow: hidden; position: relative;">
          <h2 style="margin-top: 0; font-size: 20px;">レシート仕分け</h2>
          <div id="receiptLoading" style="text-align: center; padding: 40px 0; color: #a76777; font-weight: bold; font-size: 16px;">
            <div style="font-size: 40px; margin-bottom: 15px;">🤖📸</div>
            AIで解析中...<br><span style="font-size: 12px; font-weight: normal;">圧縮送信で高速化！</span>
          </div>
          <div id="receiptItemsWrap" style="display: none; flex: 1; overflow-y: auto; margin-bottom: 15px; padding-right: 5px;">
            <p class="muted" style="margin-top: 0; font-size: 11px;">ワンタップで負担割合を変更できます。</p>
            <div id="receiptItemsList"></div>
          </div>
          <div id="receiptFooter" style="display: none; border-top: 1px solid #f0dfe4; padding-top: 15px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
              <span style="font-weight: bold; color: #59464e;">相手への請求額:</span>
              <b id="receiptTotalAmount" style="color: #e7617d; font-size: 24px;">¥0</b>
            </div>
            <div style="display: flex; gap: 10px;">
              <button id="closeReceiptBtn" class="ghost full">キャンセル</button>
              <button id="applyReceiptBtn" class="primary full">決定して入力</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ★ モーダル2.5：履歴の金額タップで開く「レシート内訳詳細」 -->
      <div id="receiptDetailModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 10000; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(4px);">
        <div class="card" style="width: 100%; max-width: 420px; max-height: 85vh; display: flex; flex-direction: column; overflow: hidden;">
          <h2 id="receiptDetailTitle" style="margin-top: 0; margin-bottom: 4px; font-size: 18px;">🧾 レシート内訳</h2>
          <div id="receiptDetailMeta" class="muted" style="font-size: 12px; margin-bottom: 12px;"></div>
          <div id="receiptDetailList" style="flex: 1; overflow-y: auto; border-top: 1px solid #f0dfe4; padding-top: 8px; margin-bottom: 12px;"></div>
          <div id="receiptDetailSummary" style="background: #fffafb; border: 1px solid #f0dfe4; border-radius: 12px; padding: 12px; margin-bottom: 14px;"></div>
          <button id="closeReceiptDetailBtn" class="primary full">閉じる</button>
        </div>
      </div>

      <!-- モーダル3：🪄 AIスマート文章入力 -->
      <div id="smartInputModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 10000; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(4px);">
        <div class="card" style="width: 100%; max-width: 420px; max-height: 85vh; display: flex; flex-direction: column; overflow-y: auto;">
          <h2 style="margin-top: 0; font-size: 19px;">🪄 AIスマート文章入力</h2>
          <p class="muted" style="margin-top: 0; font-size: 12px;">LINE感覚でしゃべるように入力すると、AIが自動で「誰が・何に・いくら請求か」を分解します（音声入力もおすすめ！）。</p>
          <textarea id="smartInputText" class="field" rows="3" placeholder="例：私がランチ2400円払って割り勘。相手がガソリン代3600円出して割り勘。私が相手のカフェ代600円を立て替えた。" style="resize: none;"></textarea>
          <button id="btnRunSmartParse" class="dark full" style="margin-bottom: 12px;">🤖 AIで解析する</button>
          
          <div id="smartInputPreview" style="display: none; border-top: 1px solid #f0dfe4; padding-top: 12px; margin-bottom: 12px;"></div>

          <div style="display: flex; gap: 10px;">
            <button id="closeSmartInputBtn" class="ghost full">閉じる</button>
            <button id="applySmartInputBtn" class="primary full" style="display: none;">一括で登録する</button>
          </div>
        </div>
      </div>

      <!-- モーダル4：📊 AI家計簿アナリスト -->
      <div id="aiReportModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 10000; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(4px);">
        <div class="card" style="width: 100%; max-width: 420px; max-height: 85vh; display: flex; flex-direction: column; overflow-y: auto;">
          <h2 style="margin-top: 0; font-size: 19px;">🤖 AI家計簿アナリスト</h2>
          <div id="aiReportContent" style="font-size: 14px; line-height: 1.7; color: #3e3438; margin-bottom: 18px;"></div>
          <button id="closeAiReportBtn" class="primary full">閉じる</button>
        </div>
      </div>
    </main>
  `;

  wire(stateObj, myName, partnerName, partnerMember?.user_id || uid, filteredExpenses, name);
  setTab(currentTab); 
  showCalc();
  if (currentQuiz) renderQuizArea();

  if (isInitial && currentTab === 'entry') {
    setTimeout(() => q('#amount')?.focus(), 100);
  }
}

function renderSchedCal() {
  const container = q('#schedCalGrid');
  if(!container) return;
  const firstDay = new Date(schedCalYear, schedCalMonth, 1).getDay();
  const lastDate = new Date(schedCalYear, schedCalMonth + 1, 0).getDate();

  let html = '';
  for(let i=0; i<firstDay; i++) html += `<div></div>`;
  for(let d=1; d<=lastDate; d++) {
    const dateStr = `${schedCalYear}-${String(schedCalMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isSel = schedSelectedDates.includes(dateStr);
    const bg = isSel ? '#ff8fa3' : '#fff';
    const col = isSel ? '#fff' : '#3e3438';
    const border = isSel ? '#ff8fa3' : '#f0dfe4';
    const shadow = isSel ? '0 2px 6px rgba(255,143,163,0.4)' : 'none';
    html += `<div class="cal-day" data-date="${dateStr}" style="background:${bg}; color:${col}; border:1px solid ${border}; box-shadow:${shadow}; padding:10px 0; text-align:center; border-radius:10px; cursor:pointer; font-weight:bold; transition:0.2s;">${d}</div>`;
  }
  container.innerHTML = html;

  document.querySelectorAll('.cal-day').forEach((el: any) => {
    el.onclick = () => {
      const dt = el.dataset.date;
      if (schedSelectedDates.includes(dt)) {
        schedSelectedDates = schedSelectedDates.filter(x => x !== dt);
      } else {
        schedSelectedDates.push(dt);
      }
      renderSchedCal();
    };
  });
  if(q('#schedCalMonthLabel')) q('#schedCalMonthLabel').textContent = `${schedCalYear}年 ${schedCalMonth+1}月`;
}

function renderSchedUI() {
  if(q('#wrapMulti')) q('#wrapMulti').style.display = schedMode === 'multi' ? 'block' : 'none';
  if(q('#wrapSpan')) q('#wrapSpan').style.display = schedMode === 'span' ? 'block' : 'none';
  
  const btnMulti = q('#btnModeMulti');
  const btnSpan = q('#btnModeSpan');
  if(btnMulti && btnSpan) {
    if(schedMode === 'multi') {
      btnMulti.className = 'sched-mode-btn active';
      btnSpan.className = 'sched-mode-btn inactive';
    } else {
      btnMulti.className = 'sched-mode-btn inactive';
      btnSpan.className = 'sched-mode-btn active';
    }
  }
  if(schedMode === 'multi') renderSchedCal();
}

function initBombGame() {
  const bombIndex = Math.floor(Math.random() * 9);
  bombTiles = Array(9).fill(null).map((_, i) => ({ hasBomb: i === bombIndex, opened: false }));
  renderBombGame();
}

function renderBombGame() {
  const grid = q('#bombGrid');
  if (!grid) return;
  grid.innerHTML = bombTiles.map((t, i) => `
    <button class="bomb-tile" data-idx="${i}" style="height:70px; border-radius:12px; border:2px solid #f0dfe4; background:${t.opened ? (t.hasBomb ? '#bf4f68' : '#e8f5e9') : '#fff'}; font-size:24px; cursor:pointer; display:flex; align-items:center; justify-content:center;">
      ${t.opened ? (t.hasBomb ? '💣' : '⚪️') : '🎁'}
    </button>
  `).join('');

  document.querySelectorAll('.bomb-tile').forEach((b: any) => {
    b.onclick = () => {
      const idx = Number(b.dataset.idx);
      if (bombTiles[idx].opened) return;
      bombTiles[idx].opened = true;
      if (bombTiles[idx].hasBomb) {
        q('#bombMsg').innerHTML = '💥 <b style="color:#bf4f68;">ドカン！！爆発した人の負け！</b>';
        bombTiles.forEach(tile => tile.opened = true);
      } else {
        q('#bombMsg').textContent = 'セーフ！次の人にスマホを渡してね';
      }
      renderBombGame();
    };
  });
}

function renderQuizArea() {
  const area = q('#quizPlayArea');
  if (!area || !currentQuiz) return;

  area.innerHTML = `
    <div style="background:#fffafb; border:1px solid #f0dfe4; border-radius:14px; padding:14px;">
      <div style="font-weight:bold; font-size:15px; color:#3e3438; margin-bottom:12px; line-height:1.5;">Q. ${esc(currentQuiz.question)}</div>
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${currentQuiz.options.map((opt, idx) => {
          let bg = '#fff'; let col = '#3e3438'; let border = '#f0dfe4';
          if (quizAnswered) {
            if (idx === currentQuiz!.answerIndex) { bg = '#e8f5e9'; col = '#2e7d32'; border = '#4caf50'; }
          }
          return `<button class="quiz-opt-btn" data-idx="${idx}" style="text-align:left; padding:12px; border-radius:10px; border:2px solid ${border}; background:${bg}; color:${col}; font-weight:bold; font-size:14px; cursor:pointer;">${idx + 1}. ${esc(opt)}</button>`;
        }).join('')}
      </div>
      ${quizAnswered ? `
        <div style="margin-top:12px; padding:10px; background:#fff0f3; border-radius:10px; font-size:13px; color:#59464e;">
          <b>💡 正解は「${currentQuiz.answerIndex + 1}」！</b><br>${esc(currentQuiz.explanation)}
        </div>
      ` : ''}
    </div>
  `;

  document.querySelectorAll('.quiz-opt-btn').forEach((b: any) => {
    b.onclick = () => {
      if (quizAnswered) return;
      quizAnswered = true;
      const picked = Number(b.dataset.idx);
      if (picked === currentQuiz?.answerIndex) {
        showToast('⭕ 大正解！！正解した人に+1しよう！');
      } else {
        showToast('❌ ざんねん！不正解！', true);
      }
      renderQuizArea();
    };
  });
}

function renderReceiptItems() {
  q('#receiptLoading').style.display = 'none';
  q('#receiptItemsWrap').style.display = 'block';
  q('#receiptFooter').style.display = 'block';
  
  let total = 0;
  const html = receiptState.map((item, i) => {
    let amt = 0;
    if (item.split === 'half') amt = item.price / 2;
    else if (item.split === 'partner') amt = item.price;
    total += amt;
    
    const btnActive = 'background:#ff8fa3; color:#fff; box-shadow:0 4px 10px #ff8fa344; border:none;';
    const btnInactive = 'background:#fff0f3; color:#a76777; border:none;';
    
    return `
      <div style="padding:12px 0; border-bottom:1px solid #f5e9ed;">
        <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
          <span style="font-weight:bold; font-size:14px; color:#3e3438;">${esc(item.name)}</span>
          <span class="muted" style="font-weight:bold;">¥${item.price}</span>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="split-btn ghost" data-index="${i}" data-val="mine" style="flex:1; padding:8px; font-size:11px; ${item.split === 'mine' ? btnActive : btnInactive}">自分(0%)</button>
          <button class="split-btn ghost" data-index="${i}" data-val="half" style="flex:1; padding:8px; font-size:11px; ${item.split === 'half' ? btnActive : btnInactive}">折半(50%)</button>
          <button class="split-btn ghost" data-index="${i}" data-val="partner" style="flex:1; padding:8px; font-size:11px; ${item.split === 'partner' ? btnActive : btnInactive}">相手(100%)</button>
        </div>
      </div>
    `;
  }).join('');
  
  q('#receiptItemsList').innerHTML = html;
  q('#receiptTotalAmount').textContent = yen(Math.round(total));
  
  document.querySelectorAll('.split-btn').forEach((b: any) => {
    b.onclick = () => {
      receiptState[b.dataset.index].split = b.dataset.val;
      renderReceiptItems(); 
    };
  });
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
  if (q('#result')) q('#result').textContent = Number.isFinite(n) ? `計算結果：${yen(n)}` : '計算式を確認';
}

function wire(state: any, myName: string, partnerName: string, partnerUid: string, filteredExpenses: any[], nameFn: (id: string) => string) {
  q('#menuBtn')?.addEventListener('click', () => q('#menuDrawer').classList.remove('hide'));
  q('#closeDrawerBtn')?.addEventListener('click', () => q('#menuDrawer').classList.add('hide'));
  q('#menuDrawer')?.addEventListener('click', () => q('#menuDrawer').classList.add('hide'));
  q('#menuContent')?.addEventListener('click', (e: Event) => e.stopPropagation());

  document.querySelectorAll('[data-nav]').forEach((b: any) => {
    b.onclick = () => { 
      setTab(b.dataset.nav); 
      if(b.dataset.nav === 'schedule') renderSchedUI(); 
      if(b.dataset.nav === 'minigame' && bombTiles.length === 0) initBombGame();
    };
  });
  document.querySelectorAll('[data-tab]').forEach((b: any) => {
    b.onclick = () => { setTab(b.dataset.tab); };
  });

  // ----------------------------------------
  // ★ 履歴の金額タップで「レシート内訳詳細」を表示
  // ----------------------------------------
  document.querySelectorAll('.view-receipt-detail').forEach((b: any) => {
    b.onclick = () => {
      const exp = expenses.find(x => x.id === b.dataset.id);
      if (!exp) return;
      const items = parseReceiptMemo(exp.memo);
      if (!items) return;

      q('#receiptDetailTitle').textContent = `🧾 ${exp.title}`;
      q('#receiptDetailMeta').textContent = `支払: ${nameFn(exp.payer_id)} ・ ${fmtTime(exp.created_at || exp.expense_date, exp.memo, exp.expense_date)}`;

      let rawSum = 0;
      let claimSum = 0;
      q('#receiptDetailList').innerHTML = items.map(item => {
        const price = Number(item.price) || 0;
        rawSum += price;
        let share = 0;
        let badgeText = '自分 (0%)';
        let badgeStyle = 'background:#f0f4f8; color:#5995bd;';
        if (item.split === 'half') {
          share = Math.round(price / 2);
          claimSum += price / 2;
          badgeText = '折半 (50%)';
          badgeStyle = 'background:#fff0f3; color:#e7617d;';
        } else if (item.split === 'partner') {
          share = price;
          claimSum += price;
          badgeText = '相手 (100%)';
          badgeStyle = 'background:#ffe5e9; color:#a13c52;';
        }
        return `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f5e9ed; font-size:13px;">
            <div style="flex:1; padding-right:8px;">
              <div style="font-weight:bold; color:#3e3438;">${esc(item.name)}</div>
              <div class="muted" style="font-size:11px; margin-top:2px;">単価 ${yen(price)} <span style="padding:2px 6px; border-radius:6px; font-weight:bold; font-size:10px; margin-left:4px; ${badgeStyle}">${badgeText}</span></div>
            </div>
            <div style="text-align:right; white-space:nowrap;">
              <span class="muted" style="font-size:11px;">請求分</span><br>
              <b style="color:#e7617d; font-size:14px;">${yen(share)}</b>
            </div>
          </div>
        `;
      }).join('');

      q('#receiptDetailSummary').innerHTML = `
        <div style="display:flex; justify-content:space-between; font-size:13px; color:#59464e; margin-bottom:6px;">
          <span>レシート合計 (${items.length}品):</span>
          <b>${yen(rawSum)}</b>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:16px; color:#e7617d; font-weight:800;">
          <span>相手への請求額:</span>
          <span>${yen(exp.amount || Math.round(claimSum))}</span>
        </div>
      `;

      q('#receiptDetailModal').style.display = 'flex';
    };
  });

  q('#closeReceiptDetailBtn')?.addEventListener('click', () => {
    q('#receiptDetailModal').style.display = 'none';
  });

  // ★ 入力画面の金額エリアからレシート内訳を再確認・再編集
  q('#reopenReceiptBtn')?.addEventListener('click', () => {
    if (pendingReceiptItems.length === 0) return;
    receiptState = pendingReceiptItems.map(i => ({ ...i }));
    q('#receiptModal').style.display = 'flex';
    renderReceiptItems();
  });

  // ----------------------------------------
  // 機能③：🪄 AIスマート文章入力
  // ----------------------------------------
  q('#btnSmartInput')?.addEventListener('click', () => {
    smartInputState = [];
    q('#smartInputPreview').style.display = 'none';
    q('#applySmartInputBtn').style.display = 'none';
    q('#smartInputModal').style.display = 'flex';
  });
  q('#closeSmartInputBtn')?.addEventListener('click', () => {
    q('#smartInputModal').style.display = 'none';
  });
  q('#btnRunSmartParse')?.addEventListener('click', async () => {
    const textInput = val('#smartInputText').trim();
    if (!textInput) return showToast('⚠️ 文章を入力してください', true);
    const btn = q('#btnRunSmartParse');
    btn.textContent = '🤖 解析中...';
    btn.disabled = true;

    try {
      const prompt = `以下の文章からペアの支出リストを抽出しJSON配列のみ出力せよ。
ルール:
- claimAmountは「立て替えた人が相手に請求する金額(整数)」。割り勘・折半や特に指定がない共有支出は支払総額の半分(50%)、相手の分を全額立て替えた場合は100%にする。
- payerは私が払ったなら"me"、相手(${partnerName})が払ったなら"partner"。
- categoryは["食費","外食","生活","家賃","光熱費","交通","娯楽","旅行","その他"]のいずれか。
出力例: [{"title":"カフェ","claimAmount":700,"payer":"me","category":"外食","note":"1400円の割り勘"}]
入力文: ${textInput}`;

      const resText = await callGeminiAPI([{ text: prompt }], true);
      const parsed = JSON.parse(resText);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('支出が読み取れませんでした');
      smartInputState = parsed;

      q('#smartInputPreview').style.display = 'block';
      q('#smartInputPreview').innerHTML = `<div class="muted" style="font-size:11px; margin-bottom:6px;">解析結果（${smartInputState.length}件）：</div>` + smartInputState.map(item => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid #f5e9ed; font-size:13px;">
          <div>
            <b>${esc(item.title)}</b> <span style="font-size:11px; color:#a76777;">(${esc(item.category)})</span><br>
            <span class="muted" style="font-size:11px;">支払: ${item.payer === 'partner' ? esc(partnerName) : esc(myName)} / ${esc(item.note || '')}</span>
          </div>
          <b style="color:#e7617d; font-size:15px;">請求 ${yen(item.claimAmount)}</b>
        </div>
      `).join('');
      q('#applySmartInputBtn').style.display = 'block';
    } catch (err: any) {
      alert(err.message);
    } finally {
      btn.textContent = '🤖 AIで解析する';
      btn.disabled = false;
    }
  });

  q('#applySmartInputBtn')?.addEventListener('click', async () => {
    if (smartInputState.length === 0) return;
    const date = getToday();
    for (const item of smartInputState) {
      const payerId = item.payer === 'partner' ? partnerUid : uid;
      const amt = Math.round(Number(item.claimAmount) || 0);
      if (amt <= 0) continue;
      expenses.unshift({
        id: 'temp-' + Date.now() + Math.random(),
        pair_id: pair,
        title: item.title || '支出',
        amount: amt,
        payer_id: payerId,
        category: item.category || 'その他',
        expense_date: date,
        created_at: new Date().toISOString()
      });
      await supabase.rpc('add_shared_expense', {
        input_pair_id: pair, input_title: item.title || '支出', input_amount: amt, input_payer_id: payerId, input_category: item.category || 'その他', input_expense_date: date, input_memo: null
      });
    }
    q('#smartInputModal').style.display = 'none';
    showToast(`✅ ${smartInputState.length}件を一括追加しました！`);
    await load();
    render(false);
  });

  // ----------------------------------------
  // 機能④：📊 AI家計簿アナリスト
  // ----------------------------------------
  q('#btnAiAnalyst')?.addEventListener('click', async () => {
    const validExps = filteredExpenses.filter(e => !(typeof e.title === 'string' && e.title.startsWith('[削除済]')));
    if (validExps.length === 0) return showToast('⚠️ 分析する履歴がありません', true);

    q('#aiReportModal').style.display = 'flex';
    q('#aiReportContent').innerHTML = `<div style="text-align:center; padding:30px 0; color:#a76777; font-weight:bold;">🤖📊 AIがふたりの家計簿を分析中...</div>`;

    try {
      const summaryLines = validExps.slice(0, 60).map(e => `${e.expense_date}: ${e.title} (請求額¥${e.amount}, カテゴリ:${e.category || '未分類'})`).join('\n');
      const prompt = `あなたは優しいカップル専属の家計簿アドバイザーです。以下の支出データ（相手への請求額ベース）を分析し、日本語で温かく実用的な振り返りレポートを作成してください。
見出しには絵文字を使い、①全体傾向のまとめ、②褒めポイント、③来月に向けた無理のない節約・お出かけアイディアの3点を簡潔にまとめてください。マークダウンの**は使わずプレーンで見やすい改行にしてください。\n\n${summaryLines}`;

      const report = await callGeminiAPI([{ text: prompt }], false);
      q('#aiReportContent').innerHTML = esc(report).replace(/\n/g, '<br>');
    } catch (err: any) {
      q('#aiReportContent').innerHTML = `<span style="color:#bf4f68;">${esc(err.message)}</span>`;
    }
  });
  q('#closeAiReportBtn')?.addEventListener('click', () => {
    q('#aiReportModal').style.display = 'none';
  });

  // ----------------------------------------
  // 機能①：🍳 冷蔵庫からAI献立提案
  // ----------------------------------------
  document.querySelectorAll('.recipe-mood-chip').forEach((chip: any) => {
    chip.onclick = () => {
      recipeMood = chip.dataset.mood;
      document.querySelectorAll('.recipe-mood-chip').forEach((c: any) => c.classList.remove('selected'));
      chip.classList.add('selected');
    };
  });

  q('#btnRecipePhoto')?.addEventListener('click', () => q('#recipePhotoInput')?.click());
  q('#recipePhotoInput')?.addEventListener('change', async (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    q('#recipePhotoStatus').textContent = '圧縮中...';
    recipeImageBase64 = await compressImageToBase64(file, 700);
    q('#recipePhotoStatus').textContent = '✅ 写真セット済み';
  });

  q('#btnGenerateRecipe')?.addEventListener('click', async () => {
    const ing = val('#recipeIngredients').trim();
    if (!ing && !recipeImageBase64) return showToast('⚠️ 食材を入力するか写真を撮影してください', true);

    const btn = q('#btnGenerateRecipe');
    btn.textContent = '🍳 AIシェフが考案中...';
    btn.disabled = true;

    try {
      const parts: any[] = [{
        text: `食材「${ing || '画像の食材'}」と気分「${recipeMood}」に合う、ふたり暮らし向けの美味しい献立を3品提案しJSON配列のみ出力せよ。
[{"name":"料理名","time":"15分","ingredients":"主な材料","steps":"簡単な作り方(2〜3文)"}]`
      }];
      if (recipeImageBase64) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: recipeImageBase64 } });
      }
      const resText = await callGeminiAPI(parts, true);
      const dishes = JSON.parse(resText);
      lastRecipeHtml = dishes.map((d: any) => `
        <div style="background:#fffafb; border:1px solid #f0dfe4; border-radius:12px; padding:12px; margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <b style="font-size:15px; color:#e7617d;">🍽️ ${esc(d.name)}</b>
            <span style="font-size:11px; background:#fff0f3; color:#a76777; padding:3px 8px; border-radius:8px; font-weight:bold;">⏱ ${esc(d.time)}</span>
          </div>
          <div style="font-size:12px; color:#59464e; margin-bottom:4px;"><b>材料:</b> ${esc(d.ingredients)}</div>
          <div style="font-size:12px; color:#3e3438; line-height:1.5;">${esc(d.steps)}</div>
        </div>
      `).join('');
      q('#recipeResultWrap').style.display = 'block';
      q('#recipeResultContent').innerHTML = lastRecipeHtml;
      recipeImageBase64 = '';
      q('#recipePhotoStatus').textContent = '写真なしでもOK';
    } catch (err: any) {
      alert(err.message);
    } finally {
      btn.textContent = '🍳 AIに3品提案してもらう';
      btn.disabled = false;
    }
  });

  // ----------------------------------------
  // 機能⑧：🎟️ ご褒美・おねだりチケット
  // ----------------------------------------
  document.querySelectorAll('.ticket-preset-chip').forEach((chip: any) => {
    chip.onclick = () => {
      q('#ticketTitle').value = chip.dataset.title;
    };
  });

  q('#btnAddTicket')?.addEventListener('click', () => {
    const title = val('#ticketTitle').trim();
    const holder = val('#ticketHolder');
    if (!title) return showToast('⚠️ チケット名を入力してください', true);
    const tickets = JSON.parse(localStorage.getItem(`tickets_${pair}`) || '[]');
    tickets.push({
      id: Date.now().toString(),
      title,
      holder,
      used: false,
      createdAt: getToday().replace(/-/g, '/')
    });
    localStorage.setItem(`tickets_${pair}`, JSON.stringify(tickets));
    showToast('🎟️ チケットを発行しました！');
    render(false);
  });

  document.querySelectorAll('.use-ticket-btn').forEach((b: any) => {
    b.onclick = () => {
      if (!confirm('このチケットを使用済みにしますか？✨')) return;
      const tickets = JSON.parse(localStorage.getItem(`tickets_${pair}`) || '[]');
      const target = tickets.find((t: any) => t.id === b.dataset.id);
      if (target) {
        target.used = true;
        target.usedAt = getToday().replace(/-/g, '/');
      }
      localStorage.setItem(`tickets_${pair}`, JSON.stringify(tickets));
      showToast('🎉 チケットを使いました！');
      render(false);
    };
  });

  document.querySelectorAll('.del-ticket-btn').forEach((b: any) => {
    b.onclick = () => {
      if (!confirm('このチケットを削除しますか？')) return;
      let tickets = JSON.parse(localStorage.getItem(`tickets_${pair}`) || '[]');
      tickets = tickets.filter((t: any) => t.id !== b.dataset.id);
      localStorage.setItem(`tickets_${pair}`, JSON.stringify(tickets));
      render(false);
    };
  });

  // ----------------------------------------
  // 機能②：🎮 ミニゲーム（反射神経・爆弾・🤖AIクイズ）
  // ----------------------------------------
  const switchMiniGame = (mode: 'react' | 'bomb' | 'quiz') => {
    miniGameMode = mode;
    q('#wrapGameReact').style.display = mode === 'react' ? 'block' : 'none';
    q('#wrapGameBomb').style.display = mode === 'bomb' ? 'block' : 'none';
    q('#wrapGameQuiz').style.display = mode === 'quiz' ? 'block' : 'none';
    q('#btnGameReact').className = `sched-mode-btn ${mode === 'react' ? 'active' : 'inactive'}`;
    q('#btnGameBomb').className = `sched-mode-btn ${mode === 'bomb' ? 'active' : 'inactive'}`;
    q('#btnGameQuiz').className = `sched-mode-btn ${mode === 'quiz' ? 'active' : 'inactive'}`;
    if (mode === 'bomb' && bombTiles.length === 0) initBombGame();
  };

  q('#btnGameReact')?.addEventListener('click', () => switchMiniGame('react'));
  q('#btnGameBomb')?.addEventListener('click', () => switchMiniGame('bomb'));
  q('#btnGameQuiz')?.addEventListener('click', () => switchMiniGame('quiz'));

  q('#bombResetBtn')?.addEventListener('click', () => {
    q('#bombMsg').textContent = '交互にタップ！ハズレ(💣)で負け！';
    initBombGame();
  });

  document.querySelectorAll('.quiz-theme-chip').forEach((chip: any) => {
    chip.onclick = () => { q('#quizThemeInput').value = chip.dataset.theme; };
  });
  q('#btnQuizPlusP1')?.addEventListener('click', () => {
    quizScoreP1++;
    q('#quizScoreP1Label').textContent = `${quizScoreP1}点`;
  });
  q('#btnQuizPlusP2')?.addEventListener('click', () => {
    quizScoreP2++;
    q('#quizScoreP2Label').textContent = `${quizScoreP2}点`;
  });

  q('#btnGenerateQuiz')?.addEventListener('click', async () => {
    const theme = val('#quizThemeInput').trim() || '雑学';
    const diff = val('#quizDiffSelect');
    const btn = q('#btnGenerateQuiz');
    btn.textContent = '🤖 クイズを作成中...';
    btn.disabled = true;

    try {
      const prompt = `テーマ「${theme}」（難易度：${diff}）に関する面白い4択クイズを1問作成しJSONのみ出力せよ。
{"question":"問題文","options":["選択肢1","選択肢2","選択肢3","選択肢4"],"answerIndex":0,"explanation":"短い解説"}`;
      const resText = await callGeminiAPI([{ text: prompt }], true);
      currentQuiz = JSON.parse(resText);
      quizAnswered = false;
      renderQuizArea();
    } catch (err: any) {
      alert(err.message);
    } finally {
      btn.textContent = '🎲 次のクイズを出題！';
      btn.disabled = false;
    }
  });

  const nextReactRound = () => {
    reactGameState = 'waiting';
    q('#reactStatus').textContent = '待て… (赤)';
    q('#reactStatus').style.background = '#e7617d';
    q('#reactBtnP1').style.background = '#ffe5e9';
    q('#reactBtnP2').style.background = '#ffe5e9';

    const delay = 1500 + Math.random() * 3000;
    reactTimer = setTimeout(() => {
      reactGameState = 'ready';
      q('#reactStatus').textContent = '今だ！！ (緑)';
      q('#reactStatus').style.background = '#4caf50';
      q('#reactBtnP1').style.background = '#e8f5e9';
      q('#reactBtnP2').style.background = '#e8f5e9';
    }, delay);
  };

  const handleReactTap = (player: 'P1' | 'P2') => {
    if (reactGameState === 'idle') return;
    if (reactGameState === 'waiting') {
      clearTimeout(reactTimer);
      reactGameState = 'idle';
      const winner = player === 'P1' ? partnerName : myName;
      q('#reactStatus').textContent = `フライング！ ${winner}に1点！`;
      if (player === 'P1') reactScoreP2++; else reactScoreP1++;
    } else if (reactGameState === 'ready') {
      reactGameState = 'idle';
      const winner = player === 'P1' ? myName : partnerName;
      q('#reactStatus').textContent = `${winner}の勝ち！`;
      if (player === 'P1') reactScoreP1++; else reactScoreP2++;
    }
    q('#reactScoreP1').textContent = String(reactScoreP1);
    q('#reactScoreP2').textContent = String(reactScoreP2);

    if (reactScoreP1 >= 3 || reactScoreP2 >= 3) {
      const champ = reactScoreP1 >= 3 ? myName : partnerName;
      q('#reactStatus').textContent = `🏆 ${champ}の完全勝利！！`;
      q('#reactStartBtn').textContent = 'もう一回遊ぶ';
    } else {
      setTimeout(nextReactRound, 1500);
    }
  };

  q('#reactStartBtn')?.addEventListener('click', () => {
    reactScoreP1 = 0; reactScoreP2 = 0;
    q('#reactScoreP1').textContent = '0';
    q('#reactScoreP2').textContent = '0';
    q('#reactStartBtn').textContent = '対戦中...';
    nextReactRound();
  });

  q('#reactBtnP1')?.addEventListener('click', () => handleReactTap('P1'));
  q('#reactBtnP2')?.addEventListener('click', () => handleReactTap('P2'));

  // ----------------------------------------
  // スケジュール・レシート・既存の全イベント
  // ----------------------------------------
  renderSchedUI();
  q('#btnModeMulti')?.addEventListener('click', () => { schedMode = 'multi'; renderSchedUI(); });
  q('#btnModeSpan')?.addEventListener('click', () => { schedMode = 'span'; renderSchedUI(); });
  q('#calPrev')?.addEventListener('click', () => { schedCalMonth--; if(schedCalMonth<0){schedCalMonth=11;schedCalYear--;} renderSchedCal(); });
  q('#calNext')?.addEventListener('click', () => { schedCalMonth++; if(schedCalMonth>11){schedCalMonth=0;schedCalYear++;} renderSchedCal(); });

  q('#addSchedBtn')?.addEventListener('click', () => {
    const title = val('#schedTitle').trim();
    const startTime = val('#schedStartTime');
    const endTime = val('#schedEndTime');
    if (!title) { showToast('⚠️ 予定を入力してください', true); return; }

    const sched = JSON.parse(localStorage.getItem(`sched_${pair}`) || '[]');

    if (schedMode === 'multi') {
      if (schedSelectedDates.length === 0) { showToast('⚠️ 日付を選択してください', true); return; }
      schedSelectedDates.forEach(d => {
        sched.push({ id: Date.now().toString() + Math.random(), title, startDate: d, endDate: d, startTime, endTime, recurrence: 'none' });
      });
      schedSelectedDates = []; 
    } else {
      const startDate = val('#schedStartDate');
      let endDate = val('#schedEndDate') || startDate;
      const recurrence = val('#schedRecurrence');
      if (!startDate) { showToast('⚠️ 開始日を入力してください', true); return; }
      if (endDate < startDate) endDate = startDate;
      sched.push({ id: Date.now().toString(), title, startDate, endDate, startTime, endTime, recurrence });
    }

    localStorage.setItem(`sched_${pair}`, JSON.stringify(sched));
    showToast('📅 リストに登録しました！');
    render();
  });

  q('#exportAllSchedBtn')?.addEventListener('click', () => {
    const scheds = JSON.parse(localStorage.getItem(`sched_${pair}`) || '[]');
    if (scheds.length === 0) return alert('書き出す予定がありません');

    let ics = 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//PairPocket//JP\n';
    scheds.forEach((s: any) => {
      const startD = s.startDate.replace(/-/g, '');
      const endD = s.endDate.replace(/-/g, '');
      let dtStart, dtEnd;

      if (s.startTime || s.endTime) {
        const st = s.startTime ? s.startTime.replace(':', '') + '00' : '000000';
        const et = s.endTime ? s.endTime.replace(':', '') + '00' : '235900';
        dtStart = `DTSTART;TZID=Asia/Tokyo:${startD}T${st}`;
        dtEnd = `DTEND;TZID=Asia/Tokyo:${endD}T${et}`;
      } else {
        const d = new Date(s.endDate);
        d.setDate(d.getDate() + 1);
        const endDPlus1 = d.toISOString().slice(0,10).replace(/-/g, '');
        dtStart = `DTSTART;VALUE=DATE:${startD}`;
        dtEnd = `DTEND;VALUE=DATE:${endDPlus1}`;
      }
      let rrule = '';
      if (s.recurrence && s.recurrence !== 'none') rrule = `\nRRULE:FREQ=${s.recurrence.toUpperCase()}`;
      
      ics += `BEGIN:VEVENT\nUID:${s.id}@pairpocket.app\n${dtStart}\n${dtEnd}\nSUMMARY:${s.title}${rrule}\nEND:VEVENT\n`;
    });
    ics += 'END:VCALENDAR';

    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'PairPocket_Schedules.ics';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
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

  // レシート読み込み
  q('#btnReceipt')?.addEventListener('click', () => q('#receiptInput')?.click());
  q('#receiptInput')?.addEventListener('change', async (e: any) => {
    const file = e.target.files[0];
    if (!file) return;

    q('#receiptModal').style.display = 'flex';
    q('#receiptLoading').style.display = 'block';
    if(q('#receiptItemsWrap')) q('#receiptItemsWrap').style.display = 'none';
    if(q('#receiptFooter')) q('#receiptFooter').style.display = 'none';
    
    try {
      const base64 = await compressImageToBase64(file, 800);
      const text = await callGeminiAPI([
        { text: "レシートの品目と金額のみをJSON配列で出力。小計・合計は除外。JSON以外出力禁止。\n[{\"name\":\"品名\",\"price\":100}]" },
        { inlineData: { mimeType: 'image/jpeg', data: base64 } }
      ], true);
      const items = JSON.parse(text);
      if (!Array.isArray(items)) throw new Error('レシートの形式を読み取れませんでした');
      receiptState = items.map((i:any) => ({...i, split: 'half'}));
      renderReceiptItems();
    } catch (err: any) {
      alert(err.message);
      q('#receiptModal').style.display = 'none';
    }
    q('#receiptInput').value = '';
  });

  q('#closeReceiptBtn')?.addEventListener('click', () => { q('#receiptModal').style.display = 'none'; });
  q('#applyReceiptBtn')?.addEventListener('click', () => {
    let total = 0;
    receiptState.forEach(i => {
      if(i.split === 'half') total += i.price / 2;
      if(i.split === 'partner') total += i.price;
    });
    pendingReceiptItems = receiptState.map(i => ({ ...i }));
    const newAmt = Math.round(total).toString();
    const newTitle = val('#title').trim() || `🧾 レシート (${pendingReceiptItems.length}品)`;
    q('#amount').value = newAmt;
    q('#title').value = newTitle;
    q('#receiptModal').style.display = 'none';
    render(false);
    showToast('📝 仕分けを反映しました（内訳も保存されます）'); 
  });

  q('#monthSelect')?.addEventListener('change', (e: any) => { currentMonth = e.target.value; render(); });
  document.querySelectorAll('[data-op]').forEach((b: any) => { b.onclick = (e: Event) => { e.preventDefault(); const input = q('#amount'); input.value += b.dataset.op; showCalc(); input.focus(); }; });
  document.querySelectorAll('[data-plus]').forEach((b: any) => { b.onclick = (e: Event) => { e.preventDefault(); const n = calc(); q('#amount').value = String((Number.isFinite(n) ? n : 0) + Number(b.dataset.plus)); showCalc(); q('#amount').focus(); }; });

  if (q('#clear')) q('#clear').onclick = (e: Event) => {
    e.preventDefault();
    pendingReceiptItems = [];
    q('#amount').value = '';
    showCalc();
    render(false);
    q('#amount').focus();
  };
  if (q('#split')) q('#split').onclick = (e: Event) => { e.preventDefault(); const n = calc(); if (Number.isFinite(n) && n > 0) { q('#amount').value = String(Math.round(n / 2)); showCalc(); q('#amount').focus(); } };

  q('#utilModeToggle')?.addEventListener('click', () => { utilViewMode = utilViewMode === 'trend' ? 'average' : 'trend'; render(); });

  q('#addUtilBtn')?.addEventListener('click', () => {
    const month = val('#utilMonth'); const type = val('#utilType'); const amount = Number(val('#utilAmount'));
    if (!month || !amount) { showToast('⚠️ 月と金額を入力してください', true); return; }
    const utils = JSON.parse(localStorage.getItem(`utils_${pair}`) || '[]');
    utils.push({ id: Date.now().toString(), month, type, amount });
    localStorage.setItem(`utils_${pair}`, JSON.stringify(utils)); 
    showToast('💧 記録しました');
    q('#utilAmount').value = '';
    render();
  });

  document.querySelectorAll('.del-util').forEach((b: any) => b.onclick = () => {
    if (!confirm('この記録を削除しますか？')) return;
    let utils = JSON.parse(localStorage.getItem(`utils_${pair}`) || '[]');
    utils = utils.filter((u: any) => u.id !== b.dataset.id);
    localStorage.setItem(`utils_${pair}`, JSON.stringify(utils)); render();
  });

  q('#settleFullBtn')?.addEventListener('click', () => { q('#settleAmount').value = state.amount; });

  q('#addSubBtn')?.addEventListener('click', async () => {
    const title = val('#subTitle').trim(); const amount = Number(val('#subAmount')); const date = val('#subDate'); const payer = val('#subPayer');
    if (!title || !amount || !date) { showToast('⚠️ 名前、金額、日付を入力してください', true); return; }
    const subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
    subs.push({ id: Date.now().toString(), title, amount, date, payer_id: payer });
    localStorage.setItem(`subs_${pair}`, JSON.stringify(subs)); 
    showToast('🔄 サブスクを登録しました');
    await processAutoSubs();
    render();
  });

  document.querySelectorAll('.del-sub').forEach((b: any) => b.onclick = () => {
    if (!confirm('このサブスク設定を削除しますか？')) return;
    let subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
    subs = subs.filter((s: any) => s.id !== b.dataset.id);
    localStorage.setItem(`subs_${pair}`, JSON.stringify(subs)); render();
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
    const newName = val('#myName').trim(); if (!newName) { showToast('⚠️ 名前を入力してください', true); return; }
    const { error } = await supabase.from('profiles').update({ display_name: newName }).eq('id', uid);
    if (error) return alert(error.message); 
    showToast('👤 名前を更新しました');
    await load(); render();
  });

  q('#delAllBtn')?.addEventListener('click', async () => {
    if (!confirm('【警告】\nすべての支出履歴と精算履歴を完全に削除します。\nこの操作は元に戻せません。よろしいですか？')) return;
    await supabase.from('expenses').delete().eq('pair_id', pair); await supabase.from('settlements').delete().eq('pair_id', pair);
    alert('すべての履歴を削除しました'); currentMonth = 'all'; await load(); render();
  });

  q('#resetUtilsBtn')?.addEventListener('click', () => {
    if (!confirm('【警告】\n水道代・光熱費の記録をすべて削除します。\nよろしいですか？')) return;
    localStorage.removeItem(`utils_${pair}`); alert('水道代・光熱費の記録をすべて削除しました'); render();
  });

  document.querySelectorAll('[data-payer]').forEach((b: any) => b.onclick = () => {
    q('#payer').value = b.dataset.payer;
    document.querySelectorAll('[data-payer]').forEach((x: any) => x.classList.remove('selected')); b.classList.add('selected');
  });

  document.querySelectorAll('.edit').forEach((b: any) => b.onclick = () => {
    const id = b.dataset.id;
    const e = expenses.find(x => x.id === id);
    if (!e) return;
    
    q('#editId').value = e.id;
    q('#editAmount').value = e.amount;
    q('#editTitle').value = e.title;
    q('#editCat').value = e.category || '';
    q('#editDate').value = e.expense_date || (e.created_at ? e.created_at.slice(0, 10) : getToday());
    q('#editPayer').value = e.payer_id;
    
    q('#editModal').style.display = 'flex';
  });

  q('#closeEditBtn')?.addEventListener('click', () => {
    q('#editModal').style.display = 'none';
  });

  q('#saveEditBtn')?.addEventListener('click', () => {
    const id = val('#editId');
    const amount = Number(val('#editAmount'));
    const title = val('#editTitle').trim();
    const cat = val('#editCat');
    const date = val('#editDate');
    const payer = val('#editPayer');

    if (!title || !amount || amount <= 0) return showToast('⚠️ 正しい金額と内容を入力してください', true);

    const target = expenses.find(x => x.id === id);
    if (target) {
      target.amount = amount;
      target.title = title;
      target.category = cat;
      target.expense_date = date;
      target.payer_id = payer;
      target.updated_at = new Date().toISOString();
    }
    
    q('#editModal').style.display = 'none';
    render();
    showToast('✏️ 編集を保存しました！');

    supabase.from('expenses').update({
      amount: amount, title: title, category: cat, expense_date: date, payer_id: payer, updated_at: new Date().toISOString()
    }).eq('id', id).then(({error}) => {
      if (error) showToast('⚠️ サーバーへの保存に失敗しました', true);
    });
  });
  
  q('#out')?.addEventListener('click', logout);
  q('#amount')?.addEventListener('input', showCalc);
  q('#saveTop')?.addEventListener('click', save);
  
  q('#settleBtn')?.addEventListener('click', () => {
    const inputAmt = Number(val('#settleAmount'));
    if (!inputAmt || inputAmt <= 0) return showToast('⚠️ 金額を正しく入力してください', true);
    if (inputAmt > state.amount) return showToast('⚠️ 残高より多い金額は入力できません', true);
    state.amount = inputAmt; settle(state);
  });
  
  document.querySelectorAll('.del').forEach((b: any) => b.onclick = () => {
    const id = b.dataset.id; const e = expenses.find(x => x.id === id);
    if(e) {
      const origTitle = e.title;
      e.title = '[削除済] ' + uid + '::' + (e.title || '支出');
      render();
      showToast('🗑 削除しました');

      supabase.from('expenses').update({ title: e.title }).eq('id', id).then(({error}) => {
         if (error) { e.title = origTitle; render(); showToast('⚠️ 削除に失敗しました', true); }
      });
    }
  });

  document.querySelectorAll('.restore').forEach((b: any) => b.onclick = () => {
    if (!confirm('この履歴を元に戻しますか？')) return;
    const id = b.dataset.id; const e = expenses.find(x => x.id === id);
    if(e) {
      const originalTitle = e.title.replace('[削除済] ', '').split('::').slice(1).join('::');
      e.title = originalTitle;
      render();
      showToast('↩️ 復元しました');

      supabase.from('expenses').update({ title: originalTitle }).eq('id', id).then(({error}) => {
         if (error) { e.title = '[削除済] ' + uid + '::' + originalTitle; render(); showToast('⚠️ 復元に失敗しました', true); }
      });
    }
  });

  document.querySelectorAll('.undo-settle').forEach((b: any) => b.onclick = () => {
    if (!confirm('この精算を取り消しますか？')) return;
    const id = b.dataset.id;
    settlements = settlements.filter(x => x.id !== id);
    render();
    showToast('↩️ 精算を取り消しました');

    supabase.from('settlements').delete().eq('id', id).then(({error}) => {
      if (error) { load().then(() => render()); showToast('⚠️ 取り消しに失敗しました', true); }
    });
  });
}

function settle(x: any) {
  if (!confirm(`${yen(x.amount)}を精算済みにしますか？`)) return;
  
  const tempId = 'temp-set-' + Date.now();
  settlements.unshift({
    id: tempId,
    pair_id: pair,
    from_user_id: x.sender,
    to_user_id: x.receiver,
    amount: Math.round(x.amount),
    created_by: uid,
    settled_at: new Date().toISOString()
  });
  render();
  showToast('🎉 精算完了！');

  supabase.from('settlements').insert({
    pair_id: pair, from_user_id: x.sender, to_user_id: x.receiver, amount: Math.round(x.amount), created_by: uid, memo: 'アプリから精算'
  }).then(({error}) => {
    if (error) {
      settlements = settlements.filter(s => s.id !== tempId);
      render();
      showToast('⚠️ 通信エラーが発生しました', true);
    } else {
      load().then(() => render(false));
    }
  });
}

function save() {
  const amount = calc();
  if (!Number.isFinite(amount)) return showToast('⚠️ 金額または計算式を確認してください', true);
  
  const title = val('#title').trim() || '支出';
  const payerId = val('#payer');
  const cat = val('#cat') || 'その他';
  const date = getToday();
  const memoPayload = pendingReceiptItems.length > 0
    ? JSON.stringify({ type: 'receipt', items: pendingReceiptItems })
    : null;

  const tempId = 'temp-' + Date.now();
  expenses.unshift({
    id: tempId,
    pair_id: pair,
    title: title,
    amount: amount,
    payer_id: payerId,
    category: cat,
    expense_date: date,
    memo: memoPayload,
    created_at: new Date().toISOString()
  });

  pendingReceiptItems = [];
  q('#amount').value = ''; 
  q('#title').value = ''; 
  showCalc(); 
  render(); 
  showToast('✅ 追加しました！');

  supabase.rpc('add_shared_expense', {
    input_pair_id: pair, input_title: title, input_amount: amount, input_payer_id: payerId, input_category: cat, input_expense_date: date, input_memo: memoPayload
  }).then(({error}) => {
    if (error) {
      expenses = expenses.filter(x => x.id !== tempId);
      render();
      showToast('⚠️ 通信エラーで追加できませんでした', true);
    } else {
      load().then(() => {
        const activeTags = ['INPUT', 'TEXTAREA', 'SELECT'];
        if (!activeTags.includes(document.activeElement?.tagName || '')) render(false);
      });
    }
  });
}

async function logout() { await supabase.auth.signOut(); boot(); }
function q(s: string) { return document.querySelector(s) as any; }
function val(s: string) { return q(s)?.value || ''; }
function fail(s: string) { app.innerHTML = `<main class="app"><div class="notice">${esc(s)}</div></main>`; }

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') { if (session && !uid) boot(); } 
  else if (event === 'SIGNED_OUT') { uid = ''; pair = ''; authView(); }
});
