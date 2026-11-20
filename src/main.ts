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
// 音声入力（録音 → Gemini文字起こし）用の状態
let voiceRecorder: MediaRecorder | null = null;
let voiceStream: MediaStream | null = null;
let voiceChunks: Blob[] = [];
let voiceTimer: any = null;
let voiceCancelled = false;
let isListening = false;
let isTranscribing = false;
const VOICE_MAX_SEC = 60;

// 献立AI用の状態
let recipeImageBase64 = '';
let recipeMood = '時短・簡単';
let lastRecipeHtml = '';

// ミニゲーム用の状態（オンライン2台同時接続＆7種ゲーム対応）
type MiniGameMode = 'sync' | 'timer' | 'balloon' | 'ttt' | 'react' | 'bomb' | 'quiz';
let miniGameMode: MiniGameMode = 'sync';
let partnerOnline = false;

// 💞 2. 以心伝心チャレンジ
let syncTopic = 'ふたりで次に行きたい旅行先は？';
let syncMyAns = '';
let syncPartnerAns = '';
let syncResultHtml = '';
let syncRevealed = false;
let syncScore = 0;

// 🎭 3. AI大喜利バトル（または⏱️10秒ピタリ止め）
// ⏱️ 10.00秒ピタリ止めバトル
let timerGameState: 'idle' | 'running' | 'done' = 'idle';
let timerStartAt = 0;
let timerAnimId: any = null;
let timerMyTime: number | null = null;
let timerPartnerTime: number | null = null;

// 🎈 風船チキンレース
let balloonCount = 0;
let balloonLimit = 22;
let balloonTurnUid = '';
let balloonBoom = false;
let balloonLoserUid = '';

// ⭕ 消えるマルバツゲーム（最大3個保持）
let tttMoves: { idx: number; uid: string }[] = [];
let tttTurnUid = '';
let tttWinnerUid = '';

let reactScoreP1 = 0, reactScoreP2 = 0;
let reactGameState: 'idle' | 'waiting' | 'ready' = 'idle';
let reactTimer: any = null;
let bombTiles: { hasBomb: boolean; opened: boolean }[] = [];

// クイズ（2人回答対応）用の状態
let quizScoreP1 = 0, quizScoreP2 = 0;
let currentQuiz: { question: string; options: string[]; answerIndex: number; explanation: string } | null = null;
let quizPickP1: number | null = null;
let quizPickP2: number | null = null;
let quizRevealed = false;
let isProcessingSubs = false;

// 🎙️ 音声で入力欄に自動反映した際の詳細データ保持用
let pendingVoiceDetail: { type: 'voice', rawText: string, note: string, totalAmount: number, splitText: string } | null = null;

// 🔐 管理者モード用の状態（パスワード013000認証つき）
let isAdminMode = false;
let adminFilter: 'all' | 'deleted' = 'all';
let adminSelectedExpIds: string[] = [];
let hideDeletedInTimeline = localStorage.getItem('pp_hide_deleted') === '1';

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

// メモ欄から音声・AI文章入力の詳細データを抽出するヘルパー
function parseSmartMemo(memo: any): { type: 'voice' | 'smart', rawText: string, note: string, totalAmount?: number, splitText?: string } | null {
  if (!memo || typeof memo !== 'string' || !memo.startsWith('{')) return null;
  try {
    const obj = JSON.parse(memo);
    if (obj && (obj.type === 'voice' || obj.type === 'smart')) {
      return obj;
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

// ----------------------------------------
// 🎙️ 音声入力：ワンタップ録音 → Gemini で解析＆自動登録
// ----------------------------------------
let voiceDirectMode = true;

function setVoiceBtn(state: 'idle' | 'recording' | 'transcribing', sec = 0) {
  const modalBtn = q('#btnVoiceInput');
  const quickBtn = q('#btnQuickVoice');
  if (state === 'recording') {
    if (modalBtn) {
      modalBtn.textContent = `🛑 録音中 ${sec}秒 (タップで終了)`;
      modalBtn.style.background = '#e7617d';
      modalBtn.style.color = '#fff';
      modalBtn.disabled = false;
    }
    if (quickBtn) {
      quickBtn.textContent = `🛑 ${sec}s 完了`;
      quickBtn.style.background = '#E55B73';
      quickBtn.style.color = '#fff';
      quickBtn.style.boxShadow = '0 0 0 3px rgba(229,91,115,0.28)';
      quickBtn.disabled = false;
    }
  } else if (state === 'transcribing') {
    if (modalBtn) {
      modalBtn.textContent = '🤖 AI解析中...';
      modalBtn.style.background = '#f0f4ff';
      modalBtn.style.color = '#4361ee';
      modalBtn.disabled = true;
    }
    if (quickBtn) {
      quickBtn.textContent = '🤖 解析中…';
      quickBtn.style.background = '#EEF2FF';
      quickBtn.style.color = '#3B5BDB';
      quickBtn.style.boxShadow = 'none';
      quickBtn.disabled = true;
    }
  } else {
    if (modalBtn) {
      modalBtn.textContent = '🎙️ マイクで話す';
      modalBtn.style.background = '#ffe5e9';
      modalBtn.style.color = '#e7617d';
      modalBtn.disabled = false;
    }
    if (quickBtn) {
      quickBtn.textContent = '🎙️ 音声入力';
      quickBtn.style.background = '#FCEEF1';
      quickBtn.style.color = '#C9465E';
      quickBtn.style.boxShadow = 'none';
      quickBtn.disabled = false;
    }
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function pickRecorderMime(): string {
  const MR: any = (window as any).MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/aac'];
  return candidates.find(t => MR.isTypeSupported(t)) || '';
}

function releaseVoiceStream() {
  if (voiceTimer) { clearInterval(voiceTimer); voiceTimer = null; }
  voiceStream?.getTracks().forEach(t => t.stop());
  voiceStream = null;
}

async function startVoiceRecording(direct = true) {
  voiceDirectMode = direct;
  if (!navigator.mediaDevices?.getUserMedia || !(window as any).MediaRecorder) {
    alert('この端末・ブラウザは録音に対応していません🙇‍♂️\n「🪄文章入力」からキーボードのマイクボタンで音声入力してください！');
    return;
  }

  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err: any) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      alert('マイクの使用が許可されていません🎙️\n\n【iPhone】設定アプリ → Safari → マイク → 「許可」\n【Android】Chromeのアドレスバー左の🔒 → 権限 → マイクを許可\n\n許可したあと、もう一度お試しください。');
    } else if (name === 'NotFoundError') {
      alert('マイクが見つかりませんでした。');
    } else {
      alert(`マイクを起動できませんでした (${name || 'unknown'})`);
    }
    releaseVoiceStream();
    return;
  }

  const mime = pickRecorderMime();
  try {
    voiceRecorder = mime ? new MediaRecorder(voiceStream, { mimeType: mime }) : new MediaRecorder(voiceStream);
  } catch {
    voiceRecorder = new MediaRecorder(voiceStream);
  }

  voiceChunks = [];
  voiceCancelled = false;
  voiceRecorder.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) voiceChunks.push(e.data); };
  voiceRecorder.onstop = () => { handleVoiceStop(); };
  voiceRecorder.start();
  isListening = true;

  let sec = 0;
  setVoiceBtn('recording', sec);
  showToast('🎙️ 話してください（もう一度タップで完了）');
  voiceTimer = setInterval(() => {
    sec++;
    setVoiceBtn('recording', sec);
    if (sec >= VOICE_MAX_SEC) stopVoiceRecording(false);
  }, 1000);
}

function stopVoiceRecording(cancel: boolean) {
  voiceCancelled = cancel;
  if (voiceTimer) { clearInterval(voiceTimer); voiceTimer = null; }
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    try { voiceRecorder.stop(); } catch { handleVoiceStop(); }
  } else {
    handleVoiceStop();
  }
}

async function handleVoiceStop() {
  const recorderMime = voiceRecorder?.mimeType || pickRecorderMime() || 'audio/webm';
  releaseVoiceStream();
  isListening = false;
  voiceRecorder = null;

  if (voiceCancelled) { voiceChunks = []; setVoiceBtn('idle'); return; }

  const blob = new Blob(voiceChunks, { type: recorderMime });
  voiceChunks = [];
  if (blob.size < 1500) {
    setVoiceBtn('idle');
    showToast('⚠️ 録音が短すぎました。もう一度話してください', true);
    return;
  }

  isTranscribing = true;
  setVoiceBtn('transcribing');
  try {
    const data = await blobToBase64(blob);
    const mimeType = recorderMime.split(';')[0];
    const partnerMember = members.find(m => m.user_id !== uid);
    const partnerName = partnerMember?.profiles?.display_name || '相手';
    const partnerUid = partnerMember?.user_id || uid;

    if (voiceDirectMode) {
      // ワンタップ入力反映モード：音声から文字起こし＆JSON抽出して、入力画面のフィールドに自動反映！
      const prompt = `この音声を正確に日本語で文字起こししつつ、ペアの支出情報を抽出しJSONオブジェクトのみ出力せよ。
ルール:
- transcriptは音声の正確な文字起こしテキスト（例：「私がカフェで1400円払って割り勘」）。
- itemsは抽出した支出配列:
  - title: 品目・内容（例：「カフェ」）
  - totalAmount: 支払った総額(整数、わかる場合。不明ならclaimAmountと同額)
  - claimAmount: 「立て替えた人が相手に請求する金額(整数)」。割り勘・折半や特に指定がない共有支出は支払総額の半分(50%)、相手の分を全額立て替えた場合は100%にする。
  - splitText: 「2人で割り勘 (50%)」「相手分を全額立替 (100%)」などの計算内訳説明
  - payer: 話し手(私)が払ったなら"me"、相手(${partnerName})が払ったなら"partner"。特に言及がなければ"me"。
  - category: ["食費","外食","生活","家賃","光熱費","交通","娯楽","旅行","その他"]のいずれか。
  - note: 補足メモ（例：「1,400円の割り勘」）
- 音声が聞き取れない・金額が含まれない場合は {"transcript":"","items":[]} を出力せよ。
出力例: {"transcript":"カフェで1400円払って割り勘","items":[{"title":"カフェ","totalAmount":1400,"claimAmount":700,"splitText":"2人で割り勘 (50%)","payer":"me","category":"外食","note":"1,400円の割り勘"}]}`;

      const resText = await callGeminiAPI([
        { text: prompt },
        { inlineData: { mimeType, data } }
      ], true);
      const parsedObj = JSON.parse(resText);
      const parsed = Array.isArray(parsedObj) ? parsedObj : (parsedObj?.items || []);
      const voiceTranscript = (typeof parsedObj?.transcript === 'string' && parsedObj.transcript) ? parsedObj.transcript : '';
      if (!Array.isArray(parsed) || parsed.length === 0) {
        showToast('⚠️ 金額や内容が聞き取れませんでした。例：「カフェ1400円割り勘」のように話してください', true);
        return;
      }

      // 複数件話した場合は合算して入力欄に反映
      let totalClaim = 0;
      let totalRaw = 0;
      const titles: string[] = [];
      const notes: string[] = [];
      let chosenPayer = uid;
      let chosenCat = '';

      for (const item of parsed) {
        const amt = Math.round(Number(item.claimAmount) || 0);
        if (amt <= 0) continue;
        totalClaim += amt;
        totalRaw += Number(item.totalAmount) || amt;
        if (item.title) titles.push(item.title);
        if (item.note) notes.push(item.note);
        if (!chosenCat && item.category) chosenCat = item.category;
        if (item.payer === 'partner') chosenPayer = partnerUid;
      }

      if (totalClaim <= 0) {
        showToast('⚠️ 有効な金額が聞き取れませんでした', true);
        return;
      }

      const finalTitle = titles.join('・') || '支出';
      const finalSplitText = parsed.length === 1 ? (parsed[0].splitText || '') : `${parsed.length}件合算`;
      const finalNote = notes.join(' / ');

      pendingReceiptItems = [];
      pendingVoiceDetail = {
        type: 'voice',
        rawText: voiceTranscript || finalNote || `${finalTitle} ${totalClaim}円`,
        note: finalNote,
        totalAmount: totalRaw || totalClaim,
        splitText: finalSplitText
      };

      if (q('#amount')) q('#amount').value = String(totalClaim);
      if (q('#title')) q('#title').value = finalTitle;
      if (q('#payer')) q('#payer').value = chosenPayer;
      document.querySelectorAll('.payer-btn').forEach((x: any) => {
        x.classList.toggle('selected', x.dataset.payer === chosenPayer);
      });
      if (q('#cat') && chosenCat) q('#cat').value = chosenCat;
      showCalc();
      showToast(`🎙️ 入力欄に反映しました！「${finalTitle} (${yen(totalClaim)})」`);
    } else {
      // モーダル内モード：文字起こししてプレビュー表示
      const transcript = (await callGeminiAPI([
        { text: 'この音声を日本語で正確に文字起こししてください。金額は算用数字（例: 2400円）で書いてください。文字起こし結果のテキストのみを出力し、説明や前置きは一切不要です。無音や聞き取れない場合は何も出力しないでください。' },
        { inlineData: { mimeType, data } }
      ], false)).trim();

      if (!transcript) {
        showToast('⚠️ 音声が聞き取れませんでした', true);
        return;
      }
      const ta = q('#smartInputText');
      if (ta) {
        const cur = ta.value.trim();
        ta.value = cur ? `${cur}。${transcript}` : transcript;
      }
      showToast('🎙️ 文字起こし完了！AIで解析します');
      q('#btnRunSmartParse')?.click();
    }
  } catch (err: any) {
    alert(err?.message || '音声解析に失敗しました');
  } finally {
    isTranscribing = false;
    setVoiceBtn('idle');
  }
}

// モーダル表示中・録音中・10秒タイマー中など、再描画すると操作が途切れる状態か
function isUiBusy() {
  if (isListening || isTranscribing || timerGameState === 'running') return true;
  return ['#editModal', '#receiptModal', '#receiptDetailModal', '#smartInputModal', '#aiReportModal']
    .some(id => q(id)?.style.display === 'flex');
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

// データの状態変化検知用ハッシュ
function getDataSignature() {
  const expSig = expenses
    .filter(e => !String(e.id).startsWith('temp-'))
    .map(e => `${e.id}:${e.amount}:${e.title}:${e.payer_id}:${e.category}:${e.expense_date}:${e.updated_at || ''}`)
    .sort()
    .join('|');
  const setSig = settlements
    .filter(s => !String(s.id).startsWith('temp-'))
    .map(s => `${s.id}:${s.amount}:${s.settled_at}`)
    .sort()
    .join('|');
  const memSig = members
    .map(m => `${m.user_id}:${m.profiles?.display_name || ''}`)
    .sort()
    .join('|');
  return `${expSig}##${setSig}##${memSig}`;
}

let isManualSyncing = false;
let liveChannel: any = null;
let dbChannel: any = null;
let liveStatus: 'idle' | 'connecting' | 'connected' | 'error' = 'idle';
let liveReconnectTimer: any = null;
let liveHeartbeatTimer: any = null;
let partnerLastPingAt = 0;
let sameAccountOtherDevice = false;
const clientSessionId = 'c_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);

// 手動更新ボタン処理
async function manualSync() {
  if (!pair || isManualSyncing) return;
  isManualSyncing = true;
  const btns = document.querySelectorAll('.manual-sync-btn');
  btns.forEach((b: any) => {
    b.classList.add('syncing');
    b.disabled = true;
  });

  try {
    await load();
    await processAutoSubs();
    if (liveStatus !== 'connected') {
      setupRealtime(true);
    } else {
      sendLivePing();
    }
    render(false);
    showToast('✅ 最新データに更新しました！');
  } catch {
    showToast('⚠️ 更新に失敗しました。通信環境を確認してください', true);
  } finally {
    isManualSyncing = false;
    document.querySelectorAll('.manual-sync-btn').forEach((b: any) => {
      b.classList.remove('syncing');
      b.disabled = false;
    });
  }
}

// オンライン状態の再判定（Supabase Presence ＋ Broadcast Ping両方で確実に検知）
function recomputePartnerOnline() {
  let presencePartner = false;
  let sameOther = false;
  try {
    if (liveChannel && typeof liveChannel.presenceState === 'function') {
      const state = liveChannel.presenceState() || {};
      const entries: any[] = [];
      Object.entries(state).forEach(([key, arr]: [string, any]) => {
        if (Array.isArray(arr)) {
          arr.forEach(item => entries.push({ _key: key, ...item }));
        }
      });
      presencePartner = entries.some(e => (e.user_id && e.user_id !== uid) || (e._key && !e._key.startsWith(`${uid}_`) && e._key !== uid));
      sameOther = entries.some(e => e.user_id === uid && e.client_id && e.client_id !== clientSessionId);
    }
  } catch {}
  const pingFresh = partnerLastPingAt > 0 && (Date.now() - partnerLastPingAt < 15000);
  partnerOnline = presencePartner || pingFresh;
  sameAccountOtherDevice = sameOther;
  updateOnlineBadges();
}

// オンライン状態のバッジ表示更新（タップで接続確認・再接続対応）
function updateOnlineBadges() {
  const partnerMember = members.find(m => m.user_id !== uid);
  const pName = partnerMember?.profiles?.display_name || '相手';
  document.querySelectorAll('.partner-online-badge').forEach((el: any) => {
    el.style.cursor = 'pointer';
    el.title = 'タップしてオンライン状態を確認・再接続';
    const isCompact = el.dataset.compact === '1';
    if (partnerOnline) {
      const labelOnline = isCompact ? 'オンライン' : `${esc(pName)}: オンライン`;
      el.innerHTML = `<span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:#22c55e; box-shadow:0 0 6px #22c55e; margin-right:4px; flex-shrink:0;"></span>${labelOnline}`;
      el.style.background = '#ecfdf5';
      el.style.color = '#15803d';
      el.style.borderColor = '#bbf7d0';
    } else if (liveStatus === 'connecting') {
      const labelConn = isCompact ? '接続中…' : 'サーバー接続中…';
      el.innerHTML = `<span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:#f59e0b; margin-right:4px; flex-shrink:0;"></span>${labelConn}`;
      el.style.background = '#fffbeb';
      el.style.color = '#b45309';
      el.style.borderColor = '#fde68a';
    } else if (liveStatus === 'error') {
      const labelErr = isCompact ? '再接続中' : '通信再接続中…';
      el.innerHTML = `<span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:#ef4444; margin-right:4px; flex-shrink:0;"></span>${labelErr}`;
      el.style.background = '#fef2f2';
      el.style.color = '#b91c1c';
      el.style.borderColor = '#fecaca';
    } else {
      const labelOffline = isCompact ? 'オフライン' : `${esc(pName)}: オフライン`;
      el.innerHTML = `<span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:#b5a6ac; margin-right:4px; flex-shrink:0;"></span>${labelOffline}`;
      el.style.background = '#F7F4F6';
      el.style.color = '#9A8E94';
      el.style.borderColor = '#EFE9EC';
    }
  });
}

function sendLivePing() {
  if (!liveChannel || liveStatus !== 'connected') return;
  try {
    liveChannel.send({
      type: 'broadcast',
      event: 'presence_ping',
      payload: { sender: uid, client_id: clientSessionId, ts: Date.now() }
    });
  } catch {}
}

function sendLiveBye() {
  if (!liveChannel || liveStatus !== 'connected') return;
  try {
    liveChannel.send({
      type: 'broadcast',
      event: 'presence_bye',
      payload: { sender: uid, client_id: clientSessionId }
    });
    liveChannel.untrack?.();
  } catch {}
}

// ゲームイベントを相手のスマホにリアルタイム送信（切断時は自動再接続＆リトライ）
async function sendGameEvent(type: string, payload: any = {}) {
  if (!pair) return;
  const doSend = async () => {
    if (!liveChannel) return 'error';
    try {
      return await liveChannel.send({
        type: 'broadcast',
        event: 'game_event',
        payload: { sender: uid, client_id: clientSessionId, type, ...payload }
      });
    } catch {
      return 'error';
    }
  };

  if (!liveChannel || liveStatus !== 'connected') {
    await setupRealtime(true);
    setTimeout(() => { doSend(); }, 600);
    return;
  }

  const res = await doSend();
  if (res !== 'ok') {
    await setupRealtime(true);
    setTimeout(() => { doSend(); }, 700);
  }
}

// 相手からのリアルタイムゲーム通信を受信
function handleRemoteGameEvent(msg: any) {
  if (!msg) return;
  if (msg.client_id && msg.client_id === clientSessionId) return;
  if (!msg.client_id && msg.sender === uid) return;

  // 相手からのゲーム通信が届いた＝相手は確実にオンライン！
  if (msg.sender && msg.sender !== uid) {
    partnerLastPingAt = Date.now();
    if (!partnerOnline) {
      partnerOnline = true;
      updateOnlineBadges();
    }
  }

  const myName = members.find(m => m.user_id === uid)?.profiles?.display_name || '自分';
  const partnerName = members.find(m => m.user_id !== uid)?.profiles?.display_name || '相手';

  if (currentTab !== 'minigame') {
    showToast(`🎮 ${partnerName}がオンライン対戦を始めました！（☰メニュー→オンライン対戦）`);
  }

  switch (msg.type) {
    case 'switch_mode':
      if (msg.mode) {
        miniGameMode = msg.mode;
        renderMiniGameTabs();
      }
      break;
    // 💞 以心伝心ゲーム
    case 'sync_topic':
      syncTopic = msg.topic || syncTopic;
      syncMyAns = '';
      syncPartnerAns = '';
      syncResultHtml = '';
      syncRevealed = false;
      renderSyncGame(myName, partnerName);
      showToast('💞 相手がお題を変更しました！');
      break;
    case 'sync_ans':
      syncPartnerAns = msg.ans || '';
      renderSyncGame(myName, partnerName);
      if (syncMyAns && syncPartnerAns && !syncRevealed) {
        evaluateSyncGame(myName, partnerName, false);
      } else {
        showToast('🔒 相手が回答を入力しました！');
      }
      break;
    case 'sync_result':
      syncResultHtml = msg.html || '';
      syncRevealed = true;
      syncScore = msg.score ?? syncScore;
      renderSyncGame(myName, partnerName);
      break;

    // ⏱️ 10.00秒ピタリ止めバトル
    case 'timer_start':
      startTimerChallengeLocal();
      showToast('⏱️ 相手が10秒チャレンジをスタートしました！');
      break;
    case 'timer_stop':
      timerPartnerTime = Number(msg.time);
      renderTimerChallenge(myName, partnerName);
      break;

    // 🎈 風船チキンレース
    case 'balloon_init':
      balloonCount = 0;
      balloonLimit = msg.limit || 22;
      balloonTurnUid = msg.turnUid || uid;
      balloonBoom = false;
      balloonLoserUid = '';
      renderBalloonGame(myName, partnerName);
      showToast('🎈 風船チキンレース開始！');
      break;
    case 'balloon_push':
      balloonCount = msg.count;
      balloonBoom = !!msg.boom;
      balloonLoserUid = msg.loserUid || '';
      balloonTurnUid = msg.nextTurnUid || uid;
      renderBalloonGame(myName, partnerName);
      break;

    // ⭕ 消えるマルバツゲーム
    case 'ttt_init':
      tttMoves = [];
      tttTurnUid = msg.turnUid || uid;
      tttWinnerUid = '';
      renderTttGame(myName, partnerName);
      showToast('⭕ 消えるマルバツ開始！');
      break;
    case 'ttt_move':
      tttMoves = msg.moves || [];
      tttTurnUid = msg.nextTurnUid || uid;
      tttWinnerUid = msg.winnerUid || '';
      renderTttGame(myName, partnerName);
      break;

    // 💣 爆弾ゲーム
    case 'bomb_init':
      bombTiles = msg.tiles || [];
      if (q('#bombMsg')) q('#bombMsg').textContent = '交互にタップ！ハズレ(💣)で負け！';
      renderBombGame();
      showToast('💣 相手が爆弾ゲームをリセットしました！');
      break;
    case 'bomb_open':
      if (bombTiles[msg.idx]) {
        bombTiles[msg.idx].opened = true;
        if (bombTiles[msg.idx].hasBomb) {
          if (q('#bombMsg')) q('#bombMsg').innerHTML = `💥 <b style="color:#4caf50;">相手(${esc(partnerName)})が爆発！！あなたの勝ち！🎉</b>`;
          bombTiles.forEach(t => t.opened = true);
        } else {
          if (q('#bombMsg')) q('#bombMsg').textContent = `${partnerName}はセーフ！あなたの番です`;
        }
        renderBombGame();
      }
      break;

    // 🤖 AIクイズ
    case 'quiz_new':
      currentQuiz = msg.quiz;
      quizPickP1 = null;
      quizPickP2 = null;
      quizRevealed = false;
      renderQuizArea(myName, partnerName);
      showToast('🎲 相手が新しいAIクイズを出題しました！');
      break;
    case 'quiz_pick':
      quizPickP2 = msg.pick;
      if (quizPickP1 !== null && quizPickP2 !== null && !quizRevealed) {
        // 2人とも選んだので採点
        renderQuizArea(myName, partnerName, true);
      } else {
        renderQuizArea(myName, partnerName);
        showToast(`🔒 ${partnerName}が回答を選択しました！`);
      }
      break;
  }
}

// Supabase Realtime 購読（オンラインPresence＆ミニゲーム通信は専用チャネルに完全分離し、iPhone復帰時の自動再接続に対応）
async function setupRealtime(forceReconnect = false) {
  if (!pair || !uid) return;
  if (!forceReconnect && liveChannel && liveStatus === 'connected') return;

  if (liveReconnectTimer) {
    clearTimeout(liveReconnectTimer);
    liveReconnectTimer = null;
  }

  // Publishable Key利用時もログインJWTでRealtime認証を通す
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      supabase.realtime.setAuth(session.access_token);
    }
  } catch {}

  if (liveChannel) {
    try { await supabase.removeChannel(liveChannel); } catch {}
    liveChannel = null;
  }

  liveStatus = 'connecting';
  updateOnlineBadges();

  // ① 専用ライブチャネル（Presence + Broadcast のみ：DBのRealtime設定に依存せず確実に動く！）
  const channel = supabase
    .channel(`pair_live_${pair}`, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: `${uid}_${clientSessionId}` }
      }
    })
    .on('presence', { event: 'sync' }, () => recomputePartnerOnline())
    .on('presence', { event: 'join' }, () => recomputePartnerOnline())
    .on('presence', { event: 'leave' }, () => recomputePartnerOnline())
    .on('broadcast', { event: 'presence_ping' }, (payload: any) => {
      const msg = payload?.payload;
      if (!msg || msg.client_id === clientSessionId) return;
      if (msg.sender && msg.sender !== uid) {
        partnerLastPingAt = Date.now();
        recomputePartnerOnline();
        try {
          channel.send({
            type: 'broadcast',
            event: 'presence_pong',
            payload: { sender: uid, client_id: clientSessionId, ts: Date.now() }
          });
        } catch {}
      } else if (msg.sender === uid) {
        sameAccountOtherDevice = true;
      }
    })
    .on('broadcast', { event: 'presence_pong' }, (payload: any) => {
      const msg = payload?.payload;
      if (!msg || msg.client_id === clientSessionId) return;
      if (msg.sender && msg.sender !== uid) {
        partnerLastPingAt = Date.now();
        recomputePartnerOnline();
      }
    })
    .on('broadcast', { event: 'presence_bye' }, (payload: any) => {
      const msg = payload?.payload;
      if (!msg || msg.client_id === clientSessionId) return;
      if (msg.sender && msg.sender !== uid) {
        partnerLastPingAt = 0;
        recomputePartnerOnline();
      }
    })
    .on('broadcast', { event: 'game_event' }, (payload: any) => {
      handleRemoteGameEvent(payload?.payload);
    })
    .subscribe(async (status: string) => {
      if (liveChannel !== channel) return;
      if (status === 'SUBSCRIBED') {
        liveStatus = 'connected';
        try {
          await channel.track({
            user_id: uid,
            client_id: clientSessionId,
            online_at: new Date().toISOString()
          });
        } catch {}
        sendLivePing();
        recomputePartnerOnline();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        liveStatus = 'error';
        recomputePartnerOnline();
        if (document.visibilityState === 'visible' && !liveReconnectTimer) {
          liveReconnectTimer = setTimeout(() => {
            liveReconnectTimer = null;
            if (document.visibilityState === 'visible' && pair) setupRealtime(true);
          }, 3000);
        }
      }
    });

  liveChannel = channel;

  // ハートビート監視（5秒ごとにping送信＆15秒応答なしでオフライン判定＆切断時の自動復旧）
  if (!liveHeartbeatTimer) {
    liveHeartbeatTimer = setInterval(() => {
      if (!pair || !uid) return;
      if (document.visibilityState !== 'visible') return;
      if (liveStatus === 'connected') {
        sendLivePing();
        recomputePartnerOnline();
      } else if (liveStatus !== 'connecting' && navigator.onLine !== false) {
        setupRealtime(true);
      }
    }, 5000);
  }

  // ② DB変更購読は別チャネルに分離（テーブル側でRealtimeが無効でもオンライン機能を道連れにしない）
  if (!dbChannel) {
    try {
      dbChannel = supabase
        .channel(`pair_db_${pair}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: `pair_id=eq.${pair}` }, () => {
          backgroundSync(true);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'settlements', filter: `pair_id=eq.${pair}` }, () => {
          backgroundSync(true);
        })
        .subscribe();
    } catch {}
  }
}

let pendingSyncRender = false;
let hasBooted = false;
let isBooting = false;

// リアルタイム＆バックグラウンド同期機能（追加・編集・削除・名前変更すべて検知）
async function backgroundSync(forceCheck = false) {
  if (!pair || (!forceCheck && document.visibilityState !== 'visible') || isManualSyncing) return;
  
  await processAutoSubs();

  const oldSig = getDataSignature();
  await load();
  const newSig = getDataSignature();
  
  const activeTags = ['INPUT', 'TEXTAREA', 'SELECT'];
  const isTyping = activeTags.includes(document.activeElement?.tagName || '');
  const canRender = !isTyping && !isUiBusy();

  if (oldSig !== newSig) {
    if (canRender) {
      render(false);
      pendingSyncRender = false;
    } else {
      // 入力中・録音中・モーダル表示中は画面を作り直さず、操作が終わってから反映
      pendingSyncRender = true;
    }
    showToast('🔄 パートナーの更新を同期しました');
  } else if (pendingSyncRender && canRender) {
    render(false);
    pendingSyncRender = false;
  }
}

setInterval(() => backgroundSync(false), 5000);
document.addEventListener('visibilitychange', async () => {
  if (!pair) return;
  if (document.visibilityState === 'visible') {
    // iPhone SafariはバックグラウンドでWebSocketを切断するため復帰時に必ず再接続＆ping
    await setupRealtime(true);
    await backgroundSync(true);
  } else {
    sendLiveBye();
  }
});
window.addEventListener('pagehide', () => { sendLiveBye(); });
window.addEventListener('pageshow', () => { if (pair) setupRealtime(true); });
window.addEventListener('online', () => { if (pair) setupRealtime(true); });

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
  if (isBooting) return;
  isBooting = true;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      hasBooted = false;
      return authView();
    }
    uid = session.user.id;
    if (session.access_token) {
      try { supabase.realtime.setAuth(session.access_token); } catch {}
    }

    const { data, error } = await supabase.from('pair_members').select('pair_id').eq('user_id', uid).maybeSingle();
    if (error) return fail(error.message);
    if (!data) return pairView();
    
    pair = data.pair_id;
    hasBooted = true;
    await load();
    await processAutoSubs();
    setupRealtime(true);
    render(false);
  } finally {
    isBooting = false;
  }
}

function authView(msg = '') {
  app.innerHTML = `
    <main class="app" style="padding-top: 48px !important;">
      <div style="text-align: center; margin-bottom: 28px;">
        <div class="brand-logo-icon" style="width: 56px; height: 56px; border-radius: 18px; margin: 0 auto 12px; font-size: 26px;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
        </div>
        <div class="brand" style="font-size: 24px;">PairPocket</div>
        <div class="muted" style="margin-top: 4px;">ふたりの暮らしと家計をスマートに共有</div>
      </div>
      ${msg ? `<div class="notice">${esc(msg)}</div>` : ''}
      <div class="card" style="padding: 24px;">
        <h2 style="font-size: 18px; margin-bottom: 16px;">アカウントへログイン</h2>
        <label class="muted">メールアドレス</label>
        <input id="email" class="field" type="email" placeholder="name@example.com">
        <label class="muted">パスワード</label>
        <input id="pw" class="field" type="password" placeholder="••••••••">
        <div class="grid" style="margin-top: 8px;">
          <button id="up" class="ghost">新規登録</button>
          <button id="in" class="primary">ログイン</button>
        </div>
      </div>
    </main>
  `;
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
  app.innerHTML = `
    <main class="app" style="padding-top: 40px !important;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div class="brand" style="font-size: 22px;">PairPocket</div>
        <div class="muted" style="margin-top: 4px;">ペアリング設定</div>
      </div>
      ${msg ? `<div class="notice">${esc(msg)}</div>` : ''}
      <div class="card">
        <h2>新しくふたりの部屋を作る</h2>
        <label class="muted">ルーム名</label>
        <input id="pn" class="field" value="ふたりの家計">
        <button id="make" class="primary full">部屋を作成する</button>
      </div>
      <div class="card">
        <h2>招待コードで参加する</h2>
        <label class="muted">パートナーから共有されたコード</label>
        <input id="code" class="field" placeholder="招待コードを入力">
        <button id="join" class="dark full">部屋に参加する</button>
      </div>
      <button id="out" class="ghost full" style="margin-top: 12px;">ログアウト</button>
    </main>
  `;
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
      if (b.dataset.tab === tab) {
        b.classList.add('active-tab');
      } else {
        b.classList.remove('active-tab');
      }
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

  const getCatIcon = (cat?: string) => {
    const map: Record<string, string> = {
      '食費': '🛒', '外食': '🍽️', '生活': '🧻', '家賃': '🏠',
      '光熱費': '💡', '交通': '🚃', '娯楽': '🎡', '旅行': '✈️', 'その他': '🛍️'
    };
    return map[cat || ''] || '💳';
  };

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
      timelineHtml += `<div style="border-top: 1.5px dashed #E55B73; margin: 26px 0 18px; position: relative;">
        <span style="position: absolute; top: -11px; left: 50%; transform: translateX(-50%); background: #FCEEF1; padding: 2px 12px; color: #C9465E; font-size: 11px; font-weight: 700; white-space: nowrap; border-radius: 999px; border: 1px solid #F3DCE2;">
          ✓ 精算完了 ${yen(s.amount)} · ${tStr}
        </span>
      </div>`;
    } else {
      const e = item.data;
      const tStr = fmtTime(item.raw, e.memo, e.expense_date);
      const isDel = typeof e.title === 'string' && e.title.startsWith('[削除済]');
      if (isDel && hideDeletedInTimeline) return;
      const receiptItems = parseReceiptMemo(e.memo);
      const smartDetail = parseSmartMemo(e.memo);
      
      let editInfoHtml = '';
      if (!isDel && e.updated_at && e.created_at && new Date(e.updated_at).getTime() - new Date(e.created_at).getTime() > 1000) {
        const updatedDate = new Date(e.updated_at);
        const updStr = `${updatedDate.getFullYear()}/${String(updatedDate.getMonth() + 1).padStart(2, '0')}/${String(updatedDate.getDate()).padStart(2, '0')}`;
        editInfoHtml = `<div style="font-size: 10px; color: #9A8E94; margin-top: 2px;">✏️ 編集済 (${updStr})</div>`;
      }

      let displayTitle = e.title; let delName = '';
      if (isDel) {
        const parts = e.title.replace('[削除済] ', '').split('::');
        delName = name(parts[0]); displayTitle = parts.slice(1).join('::');
      }

      let amountDisplayHtml = '';
      if (isDel) {
        amountDisplayHtml = `<del style="color:#9A8E94;"><b style="font-size:15px;">${yen(e.amount)}</b></del>`;
      } else if (receiptItems) {
        amountDisplayHtml = `<button class="view-receipt-detail" data-id="${e.id}" title="タップしてレシート内訳を表示" style="background:#FCEEF1; border:1px solid #F3DCE2; color:#C9465E; padding:5px 10px; border-radius:10px; font-weight:800; font-size:14px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; font-variant-numeric:tabular-nums;">🧾 ${yen(e.amount)} <span style="font-size:10px;">▾</span></button>`;
      } else if (smartDetail) {
        const icon = smartDetail.type === 'voice' ? '🎙️' : '🪄';
        const btnBg = smartDetail.type === 'voice' ? '#FCEEF1' : '#EEF2FF';
        const btnBorder = smartDetail.type === 'voice' ? '#F3DCE2' : '#D8E2FF';
        const btnCol = smartDetail.type === 'voice' ? '#C9465E' : '#3B5BDB';
        amountDisplayHtml = `<button class="view-smart-detail" data-id="${e.id}" title="タップして入力データ・計算詳細を表示" style="background:${btnBg}; border:1px solid ${btnBorder}; color:${btnCol}; padding:5px 10px; border-radius:10px; font-weight:800; font-size:14px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; font-variant-numeric:tabular-nums;">${icon} ${yen(e.amount)} <span style="font-size:10px;">▾</span></button>`;
      } else {
        amountDisplayHtml = `<b style="font-size:16px; color:#231E21; font-variant-numeric:tabular-nums;">${yen(e.amount)}</b>`;
      }

      timelineHtml += `<div class="expense ${isDel ? 'deleted-log' : ''}">
        <div class="expense-left">
          <div class="cat-avatar">${getCatIcon(e.category)}</div>
          <div style="min-width: 0; flex: 1;">
            ${isDel ? `<del style="color:#9A8E94;"><b class="break-text" style="font-size:14px;">${esc(displayTitle)}</b></del>` : `<b class="break-text" style="font-size:14px; color:#231E21;">${esc(displayTitle)}</b>`}
            <div class="muted break-text" style="margin-top: 2px; font-size: 11px;">
              ${isDel ? `<span class="deleted-badge">削除: ${esc(delName)}</span>` : ''}
              <span style="font-weight:600; color:#6E6369;">${esc(name(e.payer_id))}</span> · ${tStr}
              ${e.category ? `<span style="background:#F7F4F6; border:1px solid #EFE9EC; padding:1px 6px; border-radius:6px; font-size:10px; margin-left:4px;">${esc(e.category)}</span>` : ''}
            </div>
            ${editInfoHtml}
          </div>
        </div>
        <div class="expense-right">
          ${amountDisplayHtml}
          <div style="margin-top: 6px; display: flex; gap: 5px; justify-content: flex-end;">
            ${!isDel ? `
              <button class="edit ghost" data-id="${e.id}" style="padding: 3px 9px; font-size: 11px; color: #4A6FA5; border-radius: 7px;">編集</button>
              <button class="del ghost" data-id="${e.id}" style="padding: 3px 9px; font-size: 11px; color: #C9465E; border-radius: 7px;">削除</button>
            ` : `<button class="restore ghost" data-id="${e.id}" style="padding: 3px 9px; font-size: 11px; color: #6E5687; border-radius: 7px;">戻す</button>`}
          </div>
        </div>
      </div>`;
    }
  });

  if (timeline.length === 0) timelineHtml = '<p class="muted" style="text-align: center; padding: 24px 0;">まだ履歴がありません</p>';

  const fmtSubDate = (d: any) => {
    if (!d) return '-';
    if (d === 'last') return '月末';
    return `${d}日`;
  };

  const activeTickets = tickets.filter((t: any) => !t.used);
  const usedTickets = tickets.filter((t: any) => t.used);

  app.innerHTML = `
    <style>
      .sched-mode-btn { flex: 1; padding: 10px 10px; border-radius: 12px; font-size: 12px; font-weight: 700; border: 1px solid transparent; cursor: pointer; transition: all 0.18s ease; white-space: nowrap; }
      .sched-mode-btn.active { background: #231E21; color: #fff; box-shadow: 0 4px 12px rgba(35, 30, 33, 0.16); }
      .sched-mode-btn.inactive { background: #F7F4F6; color: #6E6369; border-color: #EFE9EC; }
      .ticket-card { background: #FDF8F9; border: 1px solid #F3DCE2; border-left: 5px solid #E55B73; border-radius: 16px; padding: 14px 16px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
      .chip-btn { display: inline-block; background: #F7F4F6; color: #6E6369; padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; margin: 0 6px 6px 0; border: 1px solid #EFE9EC; cursor: pointer; transition: all 0.15s ease; }
      .chip-btn.selected { background: #FCEEF1; color: #C9465E; border-color: #E55B73; font-weight: 700; }
      .ai-tool-tile { width: 100%; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 3px; padding: 9px 4px; border-radius: 12px; font-size: 11.5px; font-weight: 700; background: #F7F4F6; color: #231E21; border: 1px solid #EFE9EC; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .drawer-item { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 13px 14px; margin-bottom: 8px; border-radius: 14px; background: #F7F4F6; border: 1px solid #EFE9EC; color: #231E21; font-size: 14px; font-weight: 700; text-align: left; }
      @keyframes pp-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      .manual-sync-btn.syncing .sync-icon { display: inline-block; animation: pp-spin 0.7s linear infinite; }
    </style>
    <main class="app">
      <!-- 公式アプリ風ガラスヘッダー（iPhone全機種で1行に美しく収まる設計） -->
      <header class="top">
        <div class="brand-wrap">
          <div class="brand-logo-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
          </div>
          <div style="min-width: 0; flex: 1; overflow: hidden;">
            <div style="display:flex; align-items:center; gap:6px;">
              <div class="brand">PairPocket</div>
              <span class="partner-online-badge" data-compact="1" style="font-size:10px; font-weight:700; padding:1px 6px; border-radius:999px; border:1px solid #EFE9EC; background:#F7F4F6; color:#9A8E94; display:inline-flex; align-items:center; white-space:nowrap; flex-shrink:0;"></span>
            </div>
            <div class="muted" style="font-size:11px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.25; margin-top:1px;">${esc(pairName)}</div>
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center; flex-shrink: 0; white-space: nowrap;">
          <button class="ghost manual-sync-btn" title="最新データに更新" style="padding: 7px 10px; font-size: 12px; border-radius: 11px; font-weight: 700; color: #231E21; display: inline-flex; align-items: center; gap: 3px; background: #F7F4F6; white-space: nowrap; flex-shrink: 0;"><span class="sync-icon">🔄</span> 更新</button>
          <button id="menuBtn" class="ghost" style="width: 34px; height: 34px; padding: 0; font-size: 17px; border-radius: 11px; display: flex; align-items: center; justify-content: center; background: #F7F4F6; color: #231E21; flex-shrink: 0;">☰</button>
        </div>
      </header>
      
      <!-- ☰ サイドメニュー（洗練されたドロワー） -->
      <div id="menuDrawer" class="hide" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(25, 20, 23, 0.42); z-index: 9999; backdrop-filter: blur(4px);">
        <div id="menuContent" style="position: absolute; top: 0; right: 0; bottom: 0; width: 285px; background: #FFFFFF; padding: 20px 18px; box-shadow: -8px 0 30px rgba(25, 20, 23, 0.14); overflow-y: auto;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top: max(8px, env(safe-area-inset-top)); margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid #EFE9EC;">
            <div>
              <div style="font-weight:800; font-size:16px; color:#231E21;">メニュー</div>
              <div class="muted" style="font-size:11px;">${esc(myName)} ＆ ${esc(partnerName)}</div>
            </div>
            <button id="closeDrawerBtn" class="ghost" style="border-radius: 50%; width: 34px; height: 34px; padding: 0; display:flex; align-items:center; justify-content:center; font-size: 18px;">×</button>
          </div>

          <div class="muted" style="margin-bottom: 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em;">AI ＆ コミュニケーション</div>
          <button data-nav="recipe" class="drawer-item">
            <span style="display:flex; align-items:center; gap:10px;"><span style="width:32px; height:32px; border-radius:9px; background:#FFF4EB; display:inline-flex; align-items:center; justify-content:center; font-size:16px;">🍳</span> 今日のAI献立提案</span>
            <span style="color:#9A8E94;">›</span>
          </button>
          <button data-nav="tickets" class="drawer-item">
            <span style="display:flex; align-items:center; gap:10px;"><span style="width:32px; height:32px; border-radius:9px; background:#FCEEF1; display:inline-flex; align-items:center; justify-content:center; font-size:16px;">🎟️</span> ご褒美・おねだり券</span>
            <span style="color:#9A8E94;">›</span>
          </button>
          <button data-nav="minigame" class="drawer-item" style="margin-bottom: 20px;">
            <span style="display:flex; align-items:center; gap:10px;"><span style="width:32px; height:32px; border-radius:9px; background:#F2EEFF; display:inline-flex; align-items:center; justify-content:center; font-size:16px;">🎮</span> オンライン対戦ゲーム</span>
            <span style="color:#9A8E94;">›</span>
          </button>

          <div class="muted" style="margin-bottom: 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em;">ライフスタイル管理</div>
          <button data-nav="schedule" class="drawer-item">
            <span style="display:flex; align-items:center; gap:10px;"><span style="width:32px; height:32px; border-radius:9px; background:#EEF6FF; display:inline-flex; align-items:center; justify-content:center; font-size:16px;">📅</span> ふたりの予定カレンダー</span>
            <span style="color:#9A8E94;">›</span>
          </button>
          <button data-nav="utilities" class="drawer-item">
            <span style="display:flex; align-items:center; gap:10px;"><span style="width:32px; height:32px; border-radius:9px; background:#EBF9F5; display:inline-flex; align-items:center; justify-content:center; font-size:16px;">💧</span> 水道・光熱費レポート</span>
            <span style="color:#9A8E94;">›</span>
          </button>
        </div>
      </div>

      <!-- メイン①：入力タブ -->
      <section id="sec-entry">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 4px; margin-bottom: 10px; padding: 0 2px;">
          <h2 style="margin: 0; font-size: 18px; font-weight: 800; color: #231E21; white-space: nowrap;">支出を記録</h2>
          <button id="saveTop" class="primary" style="padding: 10px 20px; font-size: 14px; border-radius: 999px; font-weight: 800; white-space: nowrap; flex-shrink: 0;">＋ 追加する</button>
        </div>

        <div class="card" style="margin-top: 0;">
          <!-- AI スマート入力ツールバー（iPhone幅で3等分1行にピタッと収まるグリッド） -->
          <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-bottom: 12px;">
            <button id="btnQuickVoice" type="button" class="ai-tool-tile" style="background:#FCEEF1; border-color:#F3DCE2; color:#C9465E;">🎙️ 音声入力</button>
            <button id="btnSmartInput" type="button" class="ai-tool-tile">🪄 AI文章</button>
            <button id="btnReceipt" type="button" class="ai-tool-tile">📷 レシート</button>
          </div>
          <input type="file" id="receiptInput" accept="image/*" style="display:none;">

          <div style="display: flex; justify-content: space-between; align-items: center;">
            <label class="muted" style="font-weight: 700; font-size: 11px;">相手への請求額</label>
            <div id="result" class="result" style="margin: 0;">計算結果：¥0</div>
          </div>

          <div class="money">
            <span>¥</span>
            <input type="text" id="amount" inputmode="numeric" placeholder="0" value="${currentAmt}">
          </div>
          
          ${pendingReceiptItems.length > 0 ? `
            <div style="margin-top: 8px; text-align: right;">
              <button id="reopenReceiptBtn" type="button" class="ghost" style="padding: 6px 12px; font-size: 11px; background: #FCEEF1; color: #C9465E; border: 1px solid #F3DCE2; border-radius: 10px; font-weight: 700;">
                🧾 レシート内訳を確認・再編集 (${pendingReceiptItems.length}品)
              </button>
            </div>
          ` : ''}

          <div class="calc-buttons">
            <button type="button" data-op="+">＋</button><button type="button" data-op="-">－</button>
            <button type="button" data-op="*">×</button><button type="button" data-op="/">÷</button>
          </div>
          
          <div class="quick">
            <button data-plus="100">+100</button><button data-plus="500">+500</button>
            <button data-plus="1000">+1,000</button><button id="clear">クリア</button>
          </div>
          
          <button id="split" class="split">÷ 2人で割り勘（50%）にする</button>
          
          <label class="muted" style="margin-top: 18px; display: block; font-weight: 700; font-size: 11px;">立て替えた人</label>
          <div class="payer-buttons">${members.map((m) => `<button type="button" class="payer-btn ${m.user_id === uid ? 'selected' : ''}" data-payer="${m.user_id}">${esc(name(m.user_id))}</button>`).join('')}</div>
          <input id="payer" type="hidden" value="${uid}">
          
          <div style="border-top: 1px solid #EFE9EC; margin: 16px 0 14px;"></div>

          ${subs.length > 0 ? `
            <label class="muted" style="display:block; margin-bottom:6px; font-weight:700; font-size:11px;">定額・サブスクからワンタップ入力</label>
            <div style="overflow-x: auto; white-space: nowrap; padding-bottom: 6px; margin-bottom: 12px;">
              ${subs.map((s:any) => `<div class="sub-fill-btn sub-chip" data-id="${s.id}">⚡ ${esc(s.title)}</div>`).join('')}
            </div>
          ` : ''}

          <label class="muted" style="font-weight: 700; font-size: 11px;">内容・メモ</label>
          <input id="title" class="field" placeholder="例：カフェ、スーパー、日用品" value="${currentTitle}">
          
          <label class="muted" style="font-weight: 700; font-size: 11px;">カテゴリー</label>
          <select id="cat" class="field" style="margin-bottom: 4px;">
            <option value="" selected>カテゴリーを選択（任意）</option>
            ${['食費', '外食', '生活', '家賃', '光熱費', '交通', '娯楽', '旅行', 'その他'].map(x => `<option value="${x}">${x}</option>`).join('')}
          </select>
        </div>
      </section>

      <!-- メイン②：精算タブ -->
      <section id="sec-home">
        <div class="card hero" style="padding: 26px 22px; text-align: center; margin-top: 14px;">
          <div class="muted" style="margin-bottom: 10px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;">CURRENT BALANCE</div>
          ${members.length < 2 ? '<h2 style="color:#fff;">パートナーの参加待ち</h2>' : amount < 1 ? '<div class="big" style="font-size: 26px; margin: 18px 0; color:#fff;">精算完了・差額なし ✓</div>' : `
            <div style="display:inline-flex; align-items:center; gap:10px; background:rgba(255,255,255,0.12); padding:6px 16px; border-radius:999px; font-size:14px; font-weight:700; margin-bottom:8px;">
              <span>${esc(name(sender))}</span>
              <span style="opacity:0.65;">━━▶</span>
              <span>${esc(name(receiver))}</span>
            </div>
            <div class="big" style="margin-bottom: 22px; font-size: 42px;">${yen(amount)}</div>
            <div style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18); border-radius: 18px; padding: 16px; text-align: left; backdrop-filter: blur(8px);">
              <label style="font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.85);">今回精算する金額</label>
              <div style="display: flex; gap: 8px; margin-top: 6px;">
                <input type="number" id="settleAmount" class="field" style="margin: 0; flex: 1; font-size: 18px; font-weight: 800; color:#231E21; background:#fff; border:none;" value="${amount}">
                <button id="settleFullBtn" style="background: rgba(255,255,255,0.22); color: #fff; border: 1px solid rgba(255,255,255,0.3); border-radius: 12px; padding: 0 16px; font-weight: 700;">全額</button>
              </div>
              <button id="settleBtn" class="settle" style="margin-top: 12px;">この金額で精算を記録する</button>
            </div>
          `}
        </div>
      </section>

      <!-- メイン③：履歴タブ -->
      <section id="sec-history">
        <div class="card" style="padding: 12px 14px; margin-top: 14px; display: flex; gap: 8px; align-items: center;">
          <select id="monthSelect" class="field" style="margin:0; font-weight:700; flex: 1;">
            <option value="all" ${currentMonth === 'all' ? 'selected' : ''}>すべての期間を表示</option>
            ${months.map(m => `<option value="${m}" ${currentMonth === m ? 'selected' : ''}>${m.split('-')[0]}年${m.split('-')[1]}月</option>`).join('')}
          </select>
          <button id="btnAiAnalyst" class="ghost" style="padding: 11px 14px; font-size: 12px; font-weight: 700; background: #FCEEF1; color: #C9465E; border-color: #F3DCE2; border-radius: 12px; white-space: nowrap;">🤖 AI家計診断</button>
        </div>
        <div class="card history-scroll">
          <div style="display:flex; justify-content:space-between; align-items:center; position: sticky; top: 0; background: #fff; padding-bottom: 8px; border-bottom: 1px solid #EFE9EC; z-index: 1;">
            <h2 style="margin: 0;">タイムライン</h2>
            <span class="muted" style="font-size:10px;">🧾🎙️🪄タップで内訳表示</span>
          </div>
          <div style="margin-top: 6px;">${timelineHtml}</div>
        </div>
        <div class="card history-scroll">
          <h2 style="position: sticky; top: 0; background: #fff; padding-bottom: 8px; border-bottom: 1px solid #EFE9EC; margin-top: 0; z-index: 1;">精算履歴</h2>
          ${filteredSettlements.map(s => `<div class="expense"><div class="expense-left"><div class="cat-avatar" style="background:#EBF7F2; color:#1F6E50; border-color:#D2EFE3;">✓</div><div><b class="break-text" style="font-size:14px;">${esc(name(s.from_user_id))} → ${esc(name(s.to_user_id))}</b><div class="muted" style="font-size:11px;">${new Date(s.settled_at).toLocaleDateString('ja-JP')}</div></div></div><div class="expense-right"><b style="font-size: 15px; font-variant-numeric:tabular-nums;">${yen(s.amount)}</b><br><button class="undo-settle ghost" data-id="${s.id}" style="color:#C9465E; padding:3px 9px; font-size:11px; margin-top:4px; border-radius:7px;">取り消す</button></div></div>`).join('') || '<p class="muted" style="text-align:center; padding:16px 0;">まだ精算履歴はありません</p>'}
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

      <!-- サブ機能②：🎮 待ち時間ミニゲーム（2台オンライン同時接続＆1台対戦両対応） -->
      <section id="sec-minigame" style="display: none;">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; margin-top: 10px;">
          <h2 style="margin: 0; font-size: 17px; white-space: nowrap;">🎮 オンライン対戦</h2>
          <span class="partner-online-badge" style="font-size:11px; font-weight:700; padding:4px 10px; border-radius:999px; border:1px solid #EFE9EC; background:#F7F4F6; color:#9A8E94; display:inline-flex; align-items:center; white-space:nowrap; flex-shrink:0;"></span>
        </div>
        <p class="muted" style="margin-top:0; margin-bottom:10px; font-size:11px;">2人それぞれのスマホで開くとリアルタイム通信対戦！1台のスマホを交互に触っても遊べます。</p>
        
        <div style="display: flex; gap: 6px; margin-bottom: 14px; overflow-x: auto; padding-bottom: 4px;">
          <button id="btnGameSync" class="sched-mode-btn ${miniGameMode === 'sync' ? 'active' : 'inactive'}">💞 以心伝心</button>
          <button id="btnGameTimer" class="sched-mode-btn ${miniGameMode === 'timer' ? 'active' : 'inactive'}">⏱️ 10秒止め</button>
          <button id="btnGameBalloon" class="sched-mode-btn ${miniGameMode === 'balloon' ? 'active' : 'inactive'}">🎈 風船</button>
          <button id="btnGameTtt" class="sched-mode-btn ${miniGameMode === 'ttt' ? 'active' : 'inactive'}">⭕ 消える〇×</button>
          <button id="btnGameQuiz" class="sched-mode-btn ${miniGameMode === 'quiz' ? 'active' : 'inactive'}">🤖 AIクイズ</button>
          <button id="btnGameBomb" class="sched-mode-btn ${miniGameMode === 'bomb' ? 'active' : 'inactive'}">💣 爆弾</button>
          <button id="btnGameReact" class="sched-mode-btn ${miniGameMode === 'react' ? 'active' : 'inactive'}">⚡ 反射神経</button>
        </div>

        <!-- ゲーム①（新）：💞 以心伝心チャレンジ（AIシンクロ採点） -->
        <div id="wrapGameSync" class="card" style="padding: 16px; display: ${miniGameMode === 'sync' ? 'block' : 'none'};">
          <div id="syncGameArea"></div>
        </div>

        <!-- ゲーム②（新）：⏱️ 体内時計10.00秒ピタリ止めバトル -->
        <div id="wrapGameTimer" class="card" style="padding: 16px; text-align: center; display: ${miniGameMode === 'timer' ? 'block' : 'none'};">
          <div id="timerGameArea"></div>
        </div>

        <!-- ゲーム③（新）：🎈 風船チキンレース -->
        <div id="wrapGameBalloon" class="card" style="padding: 16px; text-align: center; display: ${miniGameMode === 'balloon' ? 'block' : 'none'};">
          <div id="balloonGameArea"></div>
        </div>

        <!-- ゲーム④（新）：⭕ 消えるマルバツゲーム -->
        <div id="wrapGameTtt" class="card" style="padding: 16px; text-align: center; display: ${miniGameMode === 'ttt' ? 'block' : 'none'};">
          <div id="tttGameArea"></div>
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

        <!-- ★ 2人同時回答＆スコアリセット対応のAIクイズ -->
        <div id="wrapGameQuiz" class="card" style="padding: 16px; display: ${miniGameMode === 'quiz' ? 'block' : 'none'};">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; background:#fffafb; padding:10px 14px; border-radius:12px; border:1px solid #f0dfe4;">
            <div style="text-align:center;">
              <div style="font-size:12px; color:#5995bd; font-weight:bold;">${esc(partnerName)}</div>
              <b id="quizScoreP2Label" style="font-size:20px; color:#5995bd;">${quizScoreP2}点</b>
            </div>
            <div style="text-align:center;">
              <button id="btnQuizResetScore" class="ghost" style="padding:6px 12px; font-size:11px; border-radius:8px; color:#9b8d93; font-weight:bold;">🔄 0点に戻す</button>
            </div>
            <div style="text-align:center;">
              <div style="font-size:12px; color:#e7617d; font-weight:bold;">${esc(myName)}</div>
              <b id="quizScoreP1Label" style="font-size:20px; color:#e7617d;">${quizScoreP1}点</b>
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
          <button id="btnGenerateQuiz" class="primary full" style="padding:12px; font-size:15px;">🎲 AIでクイズを出題！(相手の画面にも同期)</button>

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
            <input id="schedEndTime" type="time" style="margin:0; flex:1;" class="field">
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
          <div style="display:flex; gap:8px; margin-top:6px; align-items:center;">
            <input id="myName" class="field" style="margin:0; flex:1; min-width:0;" value="${esc(myName)}" placeholder="あなたの名前">
            <button id="updateNameBtn" class="dark" style="padding:12px 16px; white-space:nowrap; flex-shrink:0;">更新</button>
          </div>
        </div>

        <!-- 🔐 管理者モード -->
        <div class="card" style="border: 2px solid ${isAdminMode ? '#e7617d' : '#EFE9EC'}; background: ${isAdminMode ? '#fffafb' : '#fff'};">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <div style="min-width:0; flex:1;">
              <h2 style="margin:0; font-size:16px; color:#231E21; white-space:nowrap;">🛠️ 管理者モード</h2>
              <div class="muted" style="font-size:11px; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">完全削除・部屋名変更・詳細メンテナンス</div>
            </div>
            <button id="toggleAdminModeBtn" class="${isAdminMode ? 'primary' : 'ghost'}" style="padding:8px 14px; font-size:12px; border-radius:12px; font-weight:bold; white-space:nowrap; flex-shrink:0;">
              ${isAdminMode ? '🔓 閉じる' : '🔐 開く'}
            </button>
          </div>

          ${isAdminMode ? (() => {
            const deletedCount = expenses.filter(e => typeof e.title === 'string' && e.title.startsWith('[削除済]')).length;
            const adminTargetExps = expenses
              .slice()
              .sort((a, b) => new Date(b.created_at || b.expense_date).getTime() - new Date(a.created_at || a.expense_date).getTime())
              .filter(e => adminFilter === 'all' ? true : (typeof e.title === 'string' && e.title.startsWith('[削除済]')));

            return `
              <div style="border-top: 1px dashed #e7617d; margin-top: 14px; padding-top: 14px;">

                <!-- 1. 履歴の完全削除（個別選択＆削除済一括消去） -->
                <div style="background:#fff; border:1px solid #f0dfe4; border-radius:12px; padding:12px; margin-bottom:12px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <b style="font-size:14px; color:#a13c52;">🗑️ 支出データの完全削除（DBから抹消）</b>
                    <span class="muted" style="font-size:11px;">全${expenses.length}件 (削除済:${deletedCount}件)</span>
                  </div>
                  <p class="muted" style="font-size:11px; margin-top:0; margin-bottom:8px;">通常の削除では「[削除済]」として薄く残りますが、ここから完全削除すると履歴から跡形もなく消去されます。</p>

                  <div style="display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap;">
                    <button type="button" class="admin-filter-btn ghost" data-filter="all" style="flex:1; padding:6px 10px; font-size:11px; border-radius:8px; ${adminFilter === 'all' ? 'background:#ff8fa3; color:#fff; font-weight:bold;' : ''}">すべて表示 (${expenses.length})</button>
                    <button type="button" class="admin-filter-btn ghost" data-filter="deleted" style="flex:1; padding:6px 10px; font-size:11px; border-radius:8px; ${adminFilter === 'deleted' ? 'background:#ff8fa3; color:#fff; font-weight:bold;' : ''}">[削除済]のみ (${deletedCount})</button>
                  </div>

                  ${deletedCount > 0 ? `
                    <button id="btnPurgeAllDeleted" type="button" class="ghost full" style="background:#ffe5e9; color:#a13c52; font-size:12px; padding:8px; border-radius:10px; font-weight:bold; margin-bottom:8px;">
                      🧹 薄くなっている「[削除済]」(${deletedCount}件) をすべて完全消去
                    </button>
                  ` : ''}

                  <div style="max-height:220px; overflow-y:auto; border:1px solid #f5e9ed; border-radius:8px; padding:4px 8px; margin-bottom:8px; background:#fffcfc;">
                    ${adminTargetExps.map(e => {
                      const isDel = typeof e.title === 'string' && e.title.startsWith('[削除済]');
                      const cleanTitle = isDel ? e.title.replace('[削除済] ', '').split('::').slice(1).join('::') : e.title;
                      const checked = adminSelectedExpIds.includes(e.id) ? 'checked' : '';
                      return `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:7px 0; border-bottom:1px solid #f5e9ed; font-size:12px; gap:6px;">
                          <label style="display:flex; align-items:center; gap:6px; flex:1; cursor:pointer; overflow:hidden;">
                            <input type="checkbox" class="admin-exp-check" data-id="${e.id}" ${checked} style="width:16px; height:16px; accent-color:#e7617d;">
                            <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                              ${isDel ? '<span style="background:#eee; color:#777; padding:1px 5px; border-radius:4px; font-size:10px;">削除済</span> ' : ''}
                              <b>${esc(cleanTitle)}</b>
                              <span class="muted" style="font-size:10px;">(${esc(name(e.payer_id))}・${e.expense_date || ''})</span>
                            </div>
                          </label>
                          <div style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
                            <b style="color:${isDel ? '#999' : '#e7617d'};">${yen(e.amount)}</b>
                            <button type="button" class="admin-hard-del-one ghost" data-id="${e.id}" style="padding:3px 8px; font-size:10px; background:#ffe5e9; color:#a13c52; border-radius:6px; font-weight:bold;">完全削除</button>
                          </div>
                        </div>
                      `;
                    }).join('') || '<div class="muted" style="text-align:center; padding:12px; font-size:12px;">対象の履歴がありません</div>'}
                  </div>

                  <div style="display:flex; gap:6px;">
                    <button id="btnAdminSelectAll" type="button" class="ghost" style="padding:8px 10px; font-size:11px; border-radius:8px;">全選択/解除</button>
                    <button id="btnAdminDeleteSelected" type="button" class="primary" style="flex:1; padding:8px 12px; font-size:12px; border-radius:8px; background:#bf4f68;">選択した項目 (${adminSelectedExpIds.length}件) を完全削除</button>
                  </div>
                </div>

                <!-- 2. タイムラインの表示設定（削除済みログを隠す/表示する） -->
                <div style="background:#fff; border:1px solid #f0dfe4; border-radius:12px; padding:12px; margin-bottom:12px;">
                  <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                      <b style="font-size:13px; color:#3e3438;">👁️ 履歴で「[削除済]」の薄いログを隠す</b>
                      <div class="muted" style="font-size:11px;">ONにすると通常削除した項目もタイムラインに表示されません</div>
                    </div>
                    <button id="btnToggleHideDeleted" type="button" class="${hideDeletedInTimeline ? 'primary' : 'ghost'}" style="padding:6px 12px; font-size:12px; border-radius:10px; font-weight:bold;">
                      ${hideDeletedInTimeline ? 'ON (非表示中)' : 'OFF (表示中)'}
                    </button>
                  </div>
                </div>

                <!-- 3. 部屋名（ペア名）の変更 -->
                <div style="background:#fff; border:1px solid #f0dfe4; border-radius:12px; padding:12px; margin-bottom:12px;">
                  <b style="font-size:13px; color:#3e3438; display:block; margin-bottom:6px;">🏠 部屋名（ペア名）の変更</b>
                  <div style="display:flex; gap:6px;">
                    <input id="adminPairName" class="field" style="margin:0; flex:1;" value="${esc(pairName)}" placeholder="ふたりの家計">
                    <button id="btnUpdatePairName" type="button" class="dark" style="padding:0 14px; font-size:12px;">変更</button>
                  </div>
                </div>

                <!-- 4. サブスク自動追加の強制リセット＆今すぐ実行 -->
                <div style="background:#fff; border:1px solid #f0dfe4; border-radius:12px; padding:12px; margin-bottom:12px;">
                  <b style="font-size:13px; color:#3e3438; display:block; margin-bottom:4px;">🔄 サブスク自動追加の管理・強制実行</b>
                  <div class="muted" style="font-size:11px; margin-bottom:8px;">今月の自動追加済みフラグをリセットして、今すぐ自動追加を再判定させたい時に使います。</div>
                  <button id="btnResetSubFlags" type="button" class="ghost full" style="font-size:12px; padding:8px; border-radius:8px; font-weight:bold;">今月のサブスク処理済フラグをリセットして再実行</button>
                </div>

                <!-- 5. 全データバックアップ（CSV書き出し）＆キャッシュクリア -->
                <div style="background:#fff; border:1px solid #f0dfe4; border-radius:12px; padding:12px; margin-bottom:12px;">
                  <b style="font-size:13px; color:#3e3438; display:block; margin-bottom:6px;">📦 データ書き出し・キャッシュ管理</b>
                  <div style="display:flex; gap:6px;">
                    <button id="btnExportCsv" type="button" class="ghost" style="flex:1; font-size:12px; padding:8px; border-radius:8px; font-weight:bold;">📥 履歴をCSV出力</button>
                    <button id="btnClearLocalCache" type="button" class="ghost" style="flex:1; font-size:12px; padding:8px; border-radius:8px; font-weight:bold;">🧹 キャッシュ再構築</button>
                  </div>
                </div>

                <!-- 6. 一括初期化（危険な操作） -->
                <div style="background:#fff5f7; border:1px solid #ffccd5; border-radius:12px; padding:12px;">
                  <b style="font-size:13px; color:#a13c52; display:block; margin-bottom:8px;">⚠️ 全データの一括初期化</b>
                  <button id="delAllBtn" class="ghost full" style="color:#a13c52; background:#ffe5e9; margin-bottom: 8px; font-size:12px; padding:10px;">すべての支出・精算履歴を完全に削除する</button>
                  <button id="resetUtilsBtn" class="ghost full" style="color:#a13c52; background:#ffe5e9; font-size:12px; padding:10px;">水道代・光熱費の記録をすべて削除</button>
                </div>
              </div>
            `;
          })() : ''}
        </div>
        <button id="out" class="ghost full">ログアウト</button>

        <div style="text-align: center; margin-top: 30px; font-size: 11px; color: #9A8E94; font-weight: 600;">
          App Version: 1.24.2<br>（オンライン同時接続・iPhone自動再接続 安定化版）
        </div>
      </section>

      <nav class="tabs">
        <button data-tab="entry">
          <span class="tab-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg></span>
          <span>入力</span>
        </button>
        <button data-tab="home">
          <span class="tab-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10h14l-4-4"/><path d="M17 14H3l4 4"/></svg></span>
          <span>精算</span>
        </button>
        <button data-tab="history">
          <span class="tab-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg></span>
          <span>履歴</span>
        </button>
        <button data-tab="settings">
          <span class="tab-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
          <span>設定</span>
        </button>
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

      <!-- モーダル2.5：履歴の金額タップで開く「レシート内訳詳細」 -->
      <div id="receiptDetailModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 10000; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(4px);">
        <div class="card" style="width: 100%; max-width: 420px; max-height: 85vh; display: flex; flex-direction: column; overflow: hidden;">
          <h2 id="receiptDetailTitle" style="margin-top: 0; margin-bottom: 4px; font-size: 18px;">🧾 レシート内訳</h2>
          <div id="receiptDetailMeta" class="muted" style="font-size: 12px; margin-bottom: 12px;"></div>
          <div id="receiptDetailList" style="flex: 1; overflow-y: auto; border-top: 1px solid #f0dfe4; padding-top: 8px; margin-bottom: 12px;"></div>
          <div id="receiptDetailSummary" style="background: #fffafb; border: 1px solid #f0dfe4; border-radius: 12px; padding: 12px; margin-bottom: 14px;"></div>
          <button id="closeReceiptDetailBtn" class="primary full">閉じる</button>
        </div>
      </div>

      <!-- ★ モーダル3：🪄 AIスマート文章・音声入力（マイクボタン搭載） -->
      <div id="smartInputModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 10000; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(4px);">
        <div class="card" style="width: 100%; max-width: 420px; max-height: 85vh; display: flex; flex-direction: column; overflow-y: auto;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <h2 style="margin: 0; font-size: 18px;">🪄 AI文章・音声入力</h2>
            <button id="btnVoiceInput" type="button" class="ghost" style="padding: 6px 12px; font-size: 12px; background: #ffe5e9; color: #e7617d; border-radius: 14px; font-weight: bold;">🎙️ マイクで話す</button>
          </div>
          <p class="muted" style="margin-top: 0; font-size: 11px;">「🎙️マイクで話す」を押して話し、もう一度押すと終了（最大60秒）。AIが文字起こしして、自動で支払いを分解します。</p>
          <textarea id="smartInputText" class="field" rows="3" placeholder="例：私がランチ2400円払って割り勘。相手がガソリン代3600円出して割り勘。" style="resize: none;"></textarea>
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
  updateOnlineBadges();
  renderMiniGameTabs();

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

// ★ ミニゲームタブ切り替え＆描画統括
function renderMiniGameTabs() {
  const myName = members.find(m => m.user_id === uid)?.profiles?.display_name || '自分';
  const partnerName = members.find(m => m.user_id !== uid)?.profiles?.display_name || '相手';

  const modes: { key: typeof miniGameMode; wrap: string; btn: string }[] = [
    { key: 'sync', wrap: '#wrapGameSync', btn: '#btnGameSync' },
    { key: 'timer', wrap: '#wrapGameTimer', btn: '#btnGameTimer' },
    { key: 'balloon', wrap: '#wrapGameBalloon', btn: '#btnGameBalloon' },
    { key: 'ttt', wrap: '#wrapGameTtt', btn: '#btnGameTtt' },
    { key: 'quiz', wrap: '#wrapGameQuiz', btn: '#btnGameQuiz' },
    { key: 'bomb', wrap: '#wrapGameBomb', btn: '#btnGameBomb' },
    { key: 'react', wrap: '#wrapGameReact', btn: '#btnGameReact' },
  ];

  modes.forEach(m => {
    if (q(m.wrap)) q(m.wrap).style.display = miniGameMode === m.key ? 'block' : 'none';
    if (q(m.btn)) q(m.btn).className = `sched-mode-btn ${miniGameMode === m.key ? 'active' : 'inactive'}`;
  });

  if (miniGameMode === 'sync') renderSyncGame(myName, partnerName);
  else if (miniGameMode === 'timer') renderTimerChallenge(myName, partnerName);
  else if (miniGameMode === 'balloon') renderBalloonGame(myName, partnerName);
  else if (miniGameMode === 'ttt') renderTttGame(myName, partnerName);
  else if (miniGameMode === 'bomb') {
    if (bombTiles.length === 0) initBombGame(false);
    else renderBombGame();
  } else if (miniGameMode === 'quiz' && currentQuiz) {
    renderQuizArea(myName, partnerName);
  }
}

// ==========================================
// ゲーム①（新）：💞 以心伝心チャレンジ（AIシンクロ採点）
// ==========================================
function renderSyncGame(myName: string, partnerName: string) {
  const area = q('#syncGameArea');
  if (!area) return;

  const presets = [
    '今一番食べたいものは？',
    '次の休みに行きたい場所は？',
    'ふたりの思い出の場所といえば？',
    '100万円当たったら何に使う？',
    '相手のチャームポイントは？',
    '最後の晩餐に何を食べる？'
  ];

  area.innerHTML = `
    <div style="margin-bottom:12px;">
      <div style="font-weight:800; font-size:15px; color:#e7617d; margin-bottom:4px;">💞 ふたりの以心伝心チャレンジ</div>
      <div class="muted" style="font-size:11px;">同じお題にせーので回答！AIがふたりのシンクロ率（0〜100%）を採点します。</div>
    </div>

    <div style="margin-bottom:10px;">
      ${presets.map(t => `<span class="chip-btn sync-topic-chip" data-topic="${esc(t)}">${esc(t)}</span>`).join('')}
    </div>

    <div style="display:flex; gap:6px; margin-bottom:14px;">
      <input id="syncTopicInput" class="field" style="margin:0; flex:1;" value="${esc(syncTopic)}" placeholder="お題を入力">
      <button id="btnSetSyncTopic" class="dark" style="padding:0 12px; font-size:12px; white-space:nowrap;">お題変更</button>
    </div>

    <div style="background:#fffafb; border:2px solid #ffccd5; border-radius:14px; padding:12px; margin-bottom:14px; text-align:center;">
      <div class="muted" style="font-size:11px; font-weight:bold;">現在のお題</div>
      <div style="font-size:16px; font-weight:900; color:#3e3438; margin-top:4px;">「${esc(syncTopic)}」</div>
    </div>

    <!-- 自分の回答 -->
    <div style="background:#fff; border:1px solid #f0dfe4; border-radius:12px; padding:12px; margin-bottom:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <b style="font-size:13px; color:#e7617d;">👤 ${esc(myName)}（あなた）の回答</b>
        <span style="font-size:11px; font-weight:bold; color:${syncMyAns ? '#4caf50' : '#9b8d93'};">${syncMyAns ? '🔒 入力ロック済み' : '未入力'}</span>
      </div>
      <div style="display:flex; gap:6px;">
        <input id="syncMyAnsInput" class="field" style="margin:0; flex:1;" type="${syncMyAns && !syncRevealed ? 'password' : 'text'}" value="${esc(syncMyAns)}" placeholder="秘密で答えを入力...">
        <button id="btnLockSyncAns" class="primary" style="padding:0 14px; font-size:12px; white-space:nowrap;">🔒 決定</button>
      </div>
    </div>

    <!-- 相手の回答ステータス（＋1台プレイ用入力） -->
    <div style="background:#fff; border:1px solid #f0dfe4; border-radius:12px; padding:12px; margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <b style="font-size:13px; color:#5995bd;">👤 ${esc(partnerName)}の回答</b>
        <span style="font-size:12px; font-weight:bold; color:${syncPartnerAns ? '#4caf50' : '#9b8d93'};">
          ${syncPartnerAns ? (syncRevealed ? `「${esc(syncPartnerAns)}」` : '🔒 通信で受信済み！') : '⏳ 相手のスマホからの入力待ち...'}
        </span>
      </div>
      <details style="margin-top:8px;">
        <summary style="font-size:11px; color:#9b8d93; cursor:pointer;">📱 1台のスマホで2人遊ぶ場合はこちらをタップ</summary>
        <div style="display:flex; gap:6px; margin-top:6px;">
          <input id="syncPartnerLocalInput" class="field" style="margin:0; flex:1;" type="${syncPartnerAns && !syncRevealed ? 'password' : 'text'}" value="${esc(syncPartnerAns)}" placeholder="${esc(partnerName)}の答えを入力...">
          <button id="btnLockPartnerLocalAns" class="dark" style="padding:0 12px; font-size:11px; white-space:nowrap;">セット</button>
        </div>
      </details>
    </div>

    ${syncMyAns && syncPartnerAns && !syncRevealed ? `
      <button id="btnRunSyncJudge" class="primary full" style="padding:14px; font-size:15px;">🤖 AIでシンクロ率を採点する！</button>
    ` : ''}

    ${syncResultHtml ? `
      <div style="margin-top:12px; background:#fff0f3; border:2px solid #ff8fa3; border-radius:14px; padding:14px; text-align:center;">
        ${syncResultHtml}
      </div>
    ` : ''}
  `;

  area.querySelectorAll('.sync-topic-chip').forEach((chip: any) => {
    chip.onclick = () => {
      syncTopic = chip.dataset.topic;
      syncMyAns = '';
      syncPartnerAns = '';
      syncResultHtml = '';
      syncRevealed = false;
      sendGameEvent('sync_topic', { topic: syncTopic });
      renderSyncGame(myName, partnerName);
    };
  });

  q('#btnSetSyncTopic')?.addEventListener('click', () => {
    const t = val('#syncTopicInput').trim();
    if (!t) return;
    syncTopic = t;
    syncMyAns = '';
    syncPartnerAns = '';
    syncResultHtml = '';
    syncRevealed = false;
    sendGameEvent('sync_topic', { topic: syncTopic });
    renderSyncGame(myName, partnerName);
    showToast('💞 お題を相手のスマホにも同期しました');
  });

  q('#btnLockSyncAns')?.addEventListener('click', () => {
    const a = val('#syncMyAnsInput').trim();
    if (!a) return showToast('⚠️ 回答を入力してください', true);
    syncMyAns = a;
    sendGameEvent('sync_ans', { ans: syncMyAns });
    renderSyncGame(myName, partnerName);
    if (syncMyAns && syncPartnerAns && !syncRevealed) {
      evaluateSyncGame(myName, partnerName, true);
    } else {
      showToast('🔒 回答をロックして相手に通知しました！');
    }
  });

  q('#btnLockPartnerLocalAns')?.addEventListener('click', () => {
    const a = val('#syncPartnerLocalInput').trim();
    if (!a) return;
    syncPartnerAns = a;
    renderSyncGame(myName, partnerName);
    if (syncMyAns && syncPartnerAns && !syncRevealed) {
      evaluateSyncGame(myName, partnerName, true);
    }
  });

  q('#btnRunSyncJudge')?.addEventListener('click', () => {
    evaluateSyncGame(myName, partnerName, true);
  });
}

async function evaluateSyncGame(myName: string, partnerName: string, broadcast: boolean) {
  syncRevealed = true;
  syncResultHtml = `<div style="padding:12px; color:#a76777; font-weight:bold;">🤖💞 AIがふたりのシンクロ率を判定中...</div>`;
  renderSyncGame(myName, partnerName);

  try {
    const prompt = `カップルの以心伝心ゲームの審判として、以下の2人の回答のシンクロ率(0〜100の整数)と面白い講評をJSONのみ出力せよ。
お題: 「${syncTopic}」
${myName}の回答: 「${syncMyAns}」
${partnerName}の回答: 「${syncPartnerAns}」
出力形式: {"score":85,"title":"ほぼ以心伝心！","comment":"2人とも麺類気分でバッチリ！"}`;

    const resText = await callGeminiAPI([{ text: prompt }], true);
    const data = JSON.parse(resText);
    syncScore = Number(data.score) || 0;
    syncResultHtml = `
      <div style="font-size:12px; color:#a76777; font-weight:bold;">ふたりのシンクロ率</div>
      <div style="font-size:38px; font-weight:900; color:#e7617d; margin:4px 0;">${syncScore}%</div>
      <div style="font-size:15px; font-weight:800; color:#3e3438; margin-bottom:10px;">✨ ${esc(data.title || '')}</div>
      <div style="display:flex; gap:8px; margin-bottom:10px; text-align:left;">
        <div style="flex:1; background:#fff; padding:8px 10px; border-radius:10px; border:1px solid #f0dfe4;">
          <div style="font-size:10px; color:#e7617d; font-weight:bold;">${esc(myName)}</div>
          <div style="font-size:13px; font-weight:bold; color:#3e3438;">${esc(syncMyAns)}</div>
        </div>
        <div style="flex:1; background:#fff; padding:8px 10px; border-radius:10px; border:1px solid #f0dfe4;">
          <div style="font-size:10px; color:#5995bd; font-weight:bold;">${esc(partnerName)}</div>
          <div style="font-size:13px; font-weight:bold; color:#3e3438;">${esc(syncPartnerAns)}</div>
        </div>
      </div>
      <div style="font-size:13px; color:#59464e; line-height:1.5;">${esc(data.comment || '')}</div>
    `;
  } catch {
    const exact = syncMyAns.trim() === syncPartnerAns.trim();
    syncScore = exact ? 100 : 50;
    syncResultHtml = `
      <div style="font-size:28px; font-weight:900; color:#e7617d;">${syncScore}%</div>
      <div style="font-size:13px; margin-top:6px;">${esc(myName)}: 「${esc(syncMyAns)}」 / ${esc(partnerName)}: 「${esc(syncPartnerAns)}」</div>
    `;
  }

  renderSyncGame(myName, partnerName);
  if (broadcast) {
    sendGameEvent('sync_result', { html: syncResultHtml, score: syncScore });
  }
}

// ==========================================
// ゲーム②（新）：⏱️ 体内時計 10.00秒ピタリ止めバトル
// ==========================================
function startTimerChallengeLocal() {
  if (timerAnimId) cancelAnimationFrame(timerAnimId);
  timerGameState = 'running';
  timerStartAt = performance.now();
  timerMyTime = null;
  timerPartnerTime = null;

  const myName = members.find(m => m.user_id === uid)?.profiles?.display_name || '自分';
  const partnerName = members.find(m => m.user_id !== uid)?.profiles?.display_name || '相手';
  renderTimerChallenge(myName, partnerName);

  const tick = () => {
    if (timerGameState !== 'running') return;
    const elapsed = (performance.now() - timerStartAt) / 1000;
    const disp = q('#timerClockDisplay');
    if (disp) {
      if (elapsed < 3.0) {
        disp.textContent = `${elapsed.toFixed(2)} 秒`;
        disp.style.color = '#3e3438';
      } else {
        disp.textContent = '??.?? 秒';
        disp.style.color = '#e7617d';
      }
    }
    if (elapsed < 25 && (timerMyTime === null || timerPartnerTime === null)) {
      timerAnimId = requestAnimationFrame(tick);
    } else if (timerMyTime !== null && timerPartnerTime !== null) {
      timerGameState = 'done';
      renderTimerChallenge(myName, partnerName);
    }
  };
  timerAnimId = requestAnimationFrame(tick);
}

function renderTimerChallenge(myName: string, partnerName: string) {
  const area = q('#timerGameArea');
  if (!area) return;

  const bothDone = timerMyTime !== null && timerPartnerTime !== null;
  if (bothDone) timerGameState = 'done';

  let resultHtml = '';
  if (timerMyTime !== null || timerPartnerTime !== null) {
    const myDiff = timerMyTime !== null ? Math.abs(timerMyTime - 10.0) : 999;
    const pDiff = timerPartnerTime !== null ? Math.abs(timerPartnerTime - 10.0) : 999;
    let winnerBanner = '';
    if (bothDone) {
      if (Math.abs(myDiff - pDiff) < 0.005) winnerBanner = '🎉 奇跡の同タイム引き分け！！';
      else if (myDiff < pDiff) winnerBanner = `🏆 ${esc(myName)}の勝ち！！（誤差 ${myDiff.toFixed(2)}秒）`;
      else winnerBanner = `🏆 ${esc(partnerName)}の勝ち！！（誤差 ${pDiff.toFixed(2)}秒）`;
    }

    resultHtml = `
      <div style="display:flex; gap:8px; margin-top:14px;">
        <div style="flex:1; background:#fff0f3; border:1px solid #ffccd5; border-radius:12px; padding:10px;">
          <div style="font-size:11px; color:#e7617d; font-weight:bold;">${esc(myName)}</div>
          <div style="font-size:18px; font-weight:900; color:#3e3438; margin-top:2px;">
            ${timerMyTime !== null ? (bothDone ? `${timerMyTime.toFixed(2)}秒` : '🔒 ストップ済！') : '計測中...'}
          </div>
          ${bothDone && timerMyTime !== null ? `<div class="muted" style="font-size:11px;">誤差 ${myDiff.toFixed(2)}秒</div>` : ''}
        </div>
        <div style="flex:1; background:#f0f4f8; border:1px solid #d0e1f0; border-radius:12px; padding:10px;">
          <div style="font-size:11px; color:#5995bd; font-weight:bold;">${esc(partnerName)}</div>
          <div style="font-size:18px; font-weight:900; color:#3e3438; margin-top:2px;">
            ${timerPartnerTime !== null ? (bothDone ? `${timerPartnerTime.toFixed(2)}秒` : '🔒 ストップ済！') : '計測中...'}
          </div>
          ${bothDone && timerPartnerTime !== null ? `<div class="muted" style="font-size:11px;">誤差 ${pDiff.toFixed(2)}秒</div>` : ''}
        </div>
      </div>
      ${winnerBanner ? `<div style="margin-top:12px; padding:12px; background:#fffafb; border:2px solid #e7617d; border-radius:12px; font-weight:900; font-size:16px; color:#e7617d;">${winnerBanner}</div>` : ''}
    `;
  }

  area.innerHTML = `
    <div style="font-weight:800; font-size:15px; color:#e7617d; margin-bottom:4px;">⏱️ 体内時計 10.00秒ピタリ止めバトル</div>
    <div class="muted" style="font-size:11px; margin-bottom:14px;">3秒経過で数字が「??.??」に隠れます。体内時計で10.00秒に近い方が勝ち！</div>

    <div style="background:#fffafb; border:2px solid #f0dfe4; border-radius:16px; padding:24px 12px; margin-bottom:14px;">
      <div id="timerClockDisplay" style="font-size:38px; font-weight:900; color:#3e3438; font-variant-numeric:tabular-nums;">
        ${timerGameState === 'idle' ? '0.00 秒' : (bothDone ? '10.00秒 判定完了！' : '??.?? 秒')}
      </div>
    </div>

    ${timerGameState === 'running' ? `
      <div style="display:flex; flex-direction:column; gap:8px;">
        <button id="btnStopMyTimer" class="primary full" style="padding:18px; font-size:18px;" ${timerMyTime !== null ? 'disabled' : ''}>
          ${timerMyTime !== null ? '🔒 あなたのタイム確定済み' : `🛑 ストップ！（${esc(myName)}）`}
        </button>
        <button id="btnStopPartnerLocalTimer" class="ghost full" style="padding:10px; font-size:12px; color:#5995bd;" ${timerPartnerTime !== null ? 'disabled' : ''}>
          ${timerPartnerTime !== null ? `🔒 ${esc(partnerName)}も確定済み` : `📱 1台で遊ぶ用：${esc(partnerName)}のストップ`}
        </button>
      </div>
    ` : `
      <button id="btnStartTimerGame" class="primary full" style="padding:14px; font-size:16px;">🚀 スタート！（両方のスマホで同時開始）</button>
    `}

    ${resultHtml}
  `;

  q('#btnStartTimerGame')?.addEventListener('click', () => {
    startTimerChallengeLocal();
    sendGameEvent('timer_start', {});
  });

  q('#btnStopMyTimer')?.addEventListener('click', () => {
    if (timerGameState !== 'running' || timerMyTime !== null) return;
    timerMyTime = Number(((performance.now() - timerStartAt) / 1000).toFixed(2));
    sendGameEvent('timer_stop', { time: timerMyTime });
    renderTimerChallenge(myName, partnerName);
  });

  q('#btnStopPartnerLocalTimer')?.addEventListener('click', () => {
    if (timerGameState !== 'running' || timerPartnerTime !== null) return;
    timerPartnerTime = Number(((performance.now() - timerStartAt) / 1000).toFixed(2));
    renderTimerChallenge(myName, partnerName);
  });
}

// ==========================================
// ゲーム③（新）：🎈 風船チキンレース
// ==========================================
function renderBalloonGame(myName: string, partnerName: string) {
  const area = q('#balloonGameArea');
  if (!area) return;

  const partnerUid = members.find(m => m.user_id !== uid)?.user_id || 'partner';
  if (!balloonTurnUid) balloonTurnUid = uid;
  const isMyTurn = balloonTurnUid === uid;
  const currentTurnName = isMyTurn ? myName : partnerName;
  const loserName = balloonLoserUid === uid ? myName : partnerName;

  const scale = Math.min(2.6, 1 + balloonCount * 0.055);
  const dangerRatio = Math.min(1, balloonCount / 28);
  const bgHue = Math.round(350 - dangerRatio * 10);

  area.innerHTML = `
    <div style="font-weight:800; font-size:15px; color:#e7617d; margin-bottom:4px;">🎈 風船チキンレース</div>
    <div class="muted" style="font-size:11px; margin-bottom:12px;">交互に1〜3回空気を入れよう！限界を超えて割ってしまった人の負け💥</div>

    <div style="background:#fffafb; border:2px solid #f0dfe4; border-radius:16px; height:190px; display:flex; flex-direction:column; align-items:center; justify-content:center; margin-bottom:12px; overflow:hidden; position:relative;">
      <div style="font-size:52px; transform:scale(${balloonBoom ? 2.2 : scale}); transition:transform 0.25s cubic-bezier(0.34,1.56,0.64,1); filter:drop-shadow(0 6px 12px rgba(231,97,125,${0.2 + dangerRatio * 0.5}));">
        ${balloonBoom ? '💥' : '🎈'}
      </div>
      <div style="margin-top:26px; font-weight:900; font-size:14px; color:hsl(${bgHue}, 70%, 45%);">
        現在: ${balloonCount} プッシュ
      </div>
    </div>

    ${balloonBoom ? `
      <div style="padding:12px; background:#ffe5e9; border:2px solid #bf4f68; border-radius:12px; color:#a13c52; font-weight:900; font-size:15px; margin-bottom:12px;">
        💥 ドカン！！ ${esc(loserName)}が割ってしまった！負け！
      </div>
    ` : `
      <div style="margin-bottom:10px; font-weight:bold; font-size:14px; color:${isMyTurn ? '#e7617d' : '#5995bd'};">
        👉 現在の番：<b>${esc(currentTurnName)}</b> ${isMyTurn ? '（あなたの番！）' : '（相手の操作待ち / 1台ならそのまま押せます）'}
      </div>
      <div style="display:flex; gap:8px; margin-bottom:12px;">
        <button class="balloon-push-btn primary" data-push="1" style="flex:1; padding:14px 0; font-size:15px;">💨 +1回</button>
        <button class="balloon-push-btn primary" data-push="2" style="flex:1; padding:14px 0; font-size:15px; background:#ff758f;">💨 +2回</button>
        <button class="balloon-push-btn primary" data-push="3" style="flex:1; padding:14px 0; font-size:15px; background:#e7617d;">🔥 +3回</button>
      </div>
    `}

    <button id="btnResetBalloon" class="dark full" style="padding:12px;">🔄 新しい風船でスタート（相手にも同期）</button>
  `;

  area.querySelectorAll('.balloon-push-btn').forEach((btn: any) => {
    btn.onclick = () => {
      if (balloonBoom) return;
      const push = Number(btn.dataset.push) || 1;
      const actorUid = balloonTurnUid || uid;
      balloonCount += push;
      if (balloonCount >= balloonLimit) {
        balloonBoom = true;
        balloonLoserUid = actorUid;
      } else {
        balloonTurnUid = actorUid === uid ? partnerUid : uid;
      }
      sendGameEvent('balloon_push', {
        count: balloonCount,
        boom: balloonBoom,
        loserUid: balloonLoserUid,
        nextTurnUid: balloonTurnUid
      });
      renderBalloonGame(myName, partnerName);
    };
  });

  q('#btnResetBalloon')?.addEventListener('click', () => {
    balloonCount = 0;
    balloonLimit = 15 + Math.floor(Math.random() * 20);
    balloonBoom = false;
    balloonLoserUid = '';
    balloonTurnUid = uid;
    sendGameEvent('balloon_init', { limit: balloonLimit, turnUid: balloonTurnUid });
    renderBalloonGame(myName, partnerName);
  });
}

// ==========================================
// ゲーム④（新）：⭕ 消えるマルバツゲーム（最大3個ルール）
// ==========================================
function renderTttGame(myName: string, partnerName: string) {
  const area = q('#tttGameArea');
  if (!area) return;

  const partnerUid = members.find(m => m.user_id !== uid)?.user_id || 'partner';
  if (!tttTurnUid) tttTurnUid = uid;
  const isMyTurn = tttTurnUid === uid;
  const turnName = isMyTurn ? `${myName} (⭕)` : `${partnerName} (❌)`;

  // 各プレイヤーの最古のコマ（3個置いている場合、次に消えるコマ）を特定
  const myMarks = tttMoves.filter(m => m.uid === uid);
  const partnerMarks = tttMoves.filter(m => m.uid !== uid);
  const myVanishIdx = myMarks.length >= 3 ? myMarks[0].idx : -1;
  const partnerVanishIdx = partnerMarks.length >= 3 ? partnerMarks[0].idx : -1;

  const cellsHtml = Array.from({ length: 9 }, (_, idx) => {
    const move = tttMoves.find(m => m.idx === idx);
    const isMine = move?.uid === uid;
    const mark = !move ? '' : (isMine ? '⭕' : '❌');
    const willVanish = idx === myVanishIdx || idx === partnerVanishIdx;
    return `
      <button class="ttt-cell" data-idx="${idx}" style="height:76px; border-radius:14px; border:2px ${willVanish ? 'dashed #ff8fa3' : 'solid #f0dfe4'}; background:${move ? (willVanish ? '#fff5f7' : '#fff') : '#fffafb'}; font-size:28px; cursor:pointer; display:flex; flex-direction:column; align-items:center; justify-content:center; opacity:${willVanish ? '0.55' : '1'}; position:relative;">
        <span>${mark}</span>
        ${willVanish ? '<span style="font-size:9px; color:#bf4f68; font-weight:bold; position:absolute; bottom:4px;">次消える</span>' : ''}
      </button>
    `;
  }).join('');

  const winnerName = tttWinnerUid === uid ? myName : partnerName;

  area.innerHTML = `
    <div style="font-weight:800; font-size:15px; color:#e7617d; margin-bottom:4px;">⭕ 消えるマルバツゲーム</div>
    <div class="muted" style="font-size:11px; margin-bottom:10px;">盤面に置けるのは1人3個まで！4個目を置くと一番古い自分の印が消えるから引き分けなし！</div>

    ${tttWinnerUid ? `
      <div style="padding:10px; background:#e8f5e9; border:2px solid #4caf50; border-radius:12px; color:#2e7d32; font-weight:900; font-size:15px; margin-bottom:12px;">
        🏆 ${esc(winnerName)}の勝利！！
      </div>
    ` : `
      <div style="margin-bottom:10px; font-weight:bold; font-size:14px; color:${isMyTurn ? '#e7617d' : '#5995bd'};">
        👉 手番：<b>${esc(turnName)}</b>
      </div>
    `}

    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:14px;">
      ${cellsHtml}
    </div>

    <button id="btnResetTtt" class="dark full" style="padding:12px;">🔄 盤面をリセット（相手にも同期）</button>
  `;

  const winLines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];

  area.querySelectorAll('.ttt-cell').forEach((cell: any) => {
    cell.onclick = () => {
      if (tttWinnerUid) return;
      const idx = Number(cell.dataset.idx);
      if (tttMoves.some(m => m.idx === idx)) return;

      const moverUid = tttTurnUid || uid;
      const moverExisting = tttMoves.filter(m => m.uid === moverUid);
      if (moverExisting.length >= 3) {
        const oldest = moverExisting[0];
        tttMoves = tttMoves.filter(m => !(m.idx === oldest.idx && m.uid === oldest.uid));
      }
      tttMoves.push({ idx, uid: moverUid });

      const moverIndices = tttMoves.filter(m => m.uid === moverUid).map(m => m.idx);
      const won = winLines.some(line => line.every(pos => moverIndices.includes(pos)));
      if (won) {
        tttWinnerUid = moverUid;
      } else {
        tttTurnUid = moverUid === uid ? partnerUid : uid;
      }

      sendGameEvent('ttt_move', {
        moves: tttMoves,
        nextTurnUid: tttTurnUid,
        winnerUid: tttWinnerUid
      });
      renderTttGame(myName, partnerName);
    };
  });

  q('#btnResetTtt')?.addEventListener('click', () => {
    tttMoves = [];
    tttWinnerUid = '';
    tttTurnUid = uid;
    sendGameEvent('ttt_init', { turnUid: tttTurnUid });
    renderTttGame(myName, partnerName);
  });
}

function initBombGame(broadcast = true) {
  const bombIndex = Math.floor(Math.random() * 9);
  bombTiles = Array(9).fill(null).map((_, i) => ({ hasBomb: i === bombIndex, opened: false }));
  if (broadcast) sendGameEvent('bomb_init', { tiles: bombTiles });
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
      sendGameEvent('bomb_open', { idx });
      if (bombTiles[idx].hasBomb) {
        q('#bombMsg').innerHTML = '💥 <b style="color:#bf4f68;">ドカン！！爆発した人の負け！</b>';
        bombTiles.forEach(tile => tile.opened = true);
      } else {
        q('#bombMsg').textContent = 'セーフ！次は相手の番です';
      }
      renderBombGame();
    };
  });
}

// ★ 2人同時回答＆自動採点クイズUI（2台オンライン通信＆1台両対応）
function renderQuizArea(myName: string, partnerName: string, forceEvaluate = false) {
  const area = q('#quizPlayArea');
  if (!area || !currentQuiz) return;

  const ans = currentQuiz.answerIndex;

  const evaluateQuiz = () => {
    if (quizRevealed) return;
    quizRevealed = true;
    let msg = '';
    const p1Right = quizPickP1 === ans;
    const p2Right = quizPickP2 === ans;
    if (p1Right) quizScoreP1++;
    if (p2Right) quizScoreP2++;
    if (q('#quizScoreP1Label')) q('#quizScoreP1Label').textContent = `${quizScoreP1}点`;
    if (q('#quizScoreP2Label')) q('#quizScoreP2Label').textContent = `${quizScoreP2}点`;

    if (p1Right && p2Right) msg = '🎉 ふたりとも大正解！！ (+1点ずつ)';
    else if (p1Right) msg = `⭕ ${myName}の正解！！ (+1点)`;
    else if (p2Right) msg = `⭕ ${partnerName}の正解！！ (+1点)`;
    else msg = '❌ ふたりとも不正解…！';

    showToast(msg, !p1Right && !p2Right);
  };

  if (forceEvaluate && !quizRevealed) {
    evaluateQuiz();
  }

  // 選択肢リストの表示
  const optionsHtml = currentQuiz.options.map((opt, idx) => {
    let bg = '#fff'; let col = '#3e3438'; let border = '#f0dfe4';
    if (quizRevealed && idx === ans) {
      bg = '#e8f5e9'; col = '#2e7d32'; border = '#4caf50';
    }
    return `
      <div style="padding:10px 12px; border-radius:10px; border:2px solid ${border}; background:${bg}; color:${col}; font-weight:bold; font-size:13px;">
        ${idx + 1}. ${esc(opt)}
      </div>
    `;
  }).join('');

  // 2人分の回答ボタン生成ヘルパー
  const makePlayerButtons = (player: 'P1' | 'P2', picked: number | null, labelName: string, themeColor: string) => {
    let statusBadge = picked === null
      ? '<span style="font-size:11px; color:#9b8d93;">選択待ち...</span>'
      : (quizRevealed
          ? (picked === ans
              ? '<span style="font-size:12px; color:#2e7d32; font-weight:bold;">⭕ 正解！(+1点)</span>'
              : `<span style="font-size:12px; color:#bf4f68; font-weight:bold;">❌ 不正解 (${picked + 1}を選択)</span>`)
          : '<span style="font-size:11px; color:#4caf50; font-weight:bold;">🔒 選択済み！</span>');

    const btns = [0, 1, 2, 3].map(idx => {
      let btnBg = '#fff';
      let btnCol = themeColor;
      let btnBorder = '#f0dfe4';
      if (quizRevealed) {
        if (idx === ans) {
          btnBg = '#4caf50'; btnCol = '#fff'; btnBorder = '#4caf50';
        } else if (picked === idx) {
          btnBg = '#bf4f68'; btnCol = '#fff'; btnBorder = '#bf4f68';
        }
      } else if (picked !== null) {
        btnBg = '#f5eef0'; btnCol = '#b5a6ac';
      }
      return `<button class="quiz-player-pick" data-player="${player}" data-idx="${idx}" style="flex:1; padding:12px 0; border-radius:10px; border:2px solid ${btnBorder}; background:${btnBg}; color:${btnCol}; font-weight:900; font-size:16px; cursor:pointer;">${idx + 1}</button>`;
    }).join('');

    return `
      <div style="background:#fff; border:1px solid #f0dfe4; border-radius:12px; padding:10px; margin-top:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <b style="font-size:13px; color:${themeColor};">👤 ${esc(labelName)}の回答</b>
          ${statusBadge}
        </div>
        <div style="display:flex; gap:8px;">${btns}</div>
      </div>
    `;
  };

  area.innerHTML = `
    <div style="background:#fffafb; border:1px solid #f0dfe4; border-radius:14px; padding:14px;">
      <div style="font-weight:bold; font-size:15px; color:#3e3438; margin-bottom:10px; line-height:1.5;">Q. ${esc(currentQuiz.question)}</div>
      <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px;">
        ${optionsHtml}
      </div>

      ${makePlayerButtons('P1', quizPickP1, myName, '#e7617d')}
      ${makePlayerButtons('P2', quizPickP2, partnerName, '#5995bd')}

      ${!quizRevealed ? `
        <div style="text-align:center; margin-top:10px;">
          <button id="btnRevealSingle" class="ghost" style="font-size:11px; padding:6px 12px; color:#9b8d93;">1人で遊ぶ / 今すぐ答えを見る</button>
        </div>
      ` : `
        <div style="margin-top:12px; padding:12px; background:#fff0f3; border-radius:10px; font-size:13px; color:#59464e;">
          <b>💡 正解は「${ans + 1}. ${esc(currentQuiz.options[ans])}」！</b><br>${esc(currentQuiz.explanation)}
        </div>
      `}
    </div>
  `;

  document.querySelectorAll('.quiz-player-pick').forEach((b: any) => {
    b.onclick = () => {
      if (quizRevealed) return;
      const player = b.dataset.player;
      const idx = Number(b.dataset.idx);
      if (player === 'P1') {
        quizPickP1 = idx;
        sendGameEvent('quiz_pick', { pick: idx });
      } else {
        quizPickP2 = idx;
      }

      if (quizPickP1 !== null && quizPickP2 !== null) {
        evaluateQuiz();
      }
      renderQuizArea(myName, partnerName);
    };
  });

  q('#btnRevealSingle')?.addEventListener('click', () => {
    if (quizRevealed) return;
    evaluateQuiz();
    renderQuizArea(myName, partnerName);
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
  document.querySelectorAll('.manual-sync-btn').forEach((b: any) => {
    b.onclick = () => manualSync();
  });
  document.querySelectorAll('.partner-online-badge').forEach((el: any) => {
    el.onclick = async () => {
      if (liveStatus !== 'connected') {
        showToast('🔄 オンラインサーバーへ再接続中…');
        await setupRealtime(true);
        return;
      }
      sendLivePing();
      recomputePartnerOnline();
      if (partnerOnline) {
        showToast(`🟢 ${partnerName}とリアルタイム接続中！そのまま対戦できます`);
      } else if (sameAccountOtherDevice) {
        showToast('ℹ️ 別端末も同じアカウントでログイン中です（別アカウント同士でオンラインになります）');
      } else {
        showToast(`🟡 通信サーバー接続OK！${partnerName}がアプリを開くと緑に変わります`);
      }
    };
  });
  q('#menuBtn')?.addEventListener('click', () => q('#menuDrawer').classList.remove('hide'));
  q('#closeDrawerBtn')?.addEventListener('click', () => q('#menuDrawer').classList.add('hide'));
  q('#menuDrawer')?.addEventListener('click', () => q('#menuDrawer').classList.add('hide'));
  q('#menuContent')?.addEventListener('click', (e: Event) => e.stopPropagation());

  document.querySelectorAll('[data-nav]').forEach((b: any) => {
    b.onclick = () => { 
      setTab(b.dataset.nav); 
      if(b.dataset.nav === 'schedule') renderSchedUI(); 
      if(b.dataset.nav === 'minigame') renderMiniGameTabs();
    };
  });
  document.querySelectorAll('[data-tab]').forEach((b: any) => {
    b.onclick = () => { setTab(b.dataset.tab); };
  });

  // 履歴の金額タップで「レシート内訳詳細」を表示
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

  // 履歴の金額タップで「音声・AI入力データ詳細」を表示
  document.querySelectorAll('.view-smart-detail').forEach((b: any) => {
    b.onclick = () => {
      const exp = expenses.find(x => x.id === b.dataset.id);
      if (!exp) return;
      const detail = parseSmartMemo(exp.memo);
      if (!detail) return;

      const isVoice = detail.type === 'voice';
      q('#receiptDetailTitle').textContent = `${isVoice ? '🎙️ 音声入力データ詳細' : '🪄 AI文章入力データ詳細'}`;
      q('#receiptDetailMeta').textContent = `品目: ${exp.title} (${exp.category || 'その他'}) ・ 支払: ${nameFn(exp.payer_id)} ・ ${fmtTime(exp.created_at || exp.expense_date, exp.memo, exp.expense_date)}`;

      const totalAmt = detail.totalAmount || exp.amount;
      const splitLabel = detail.splitText || detail.note || (totalAmt !== exp.amount ? '割り勘 (50%)' : 'そのまま請求');

      q('#receiptDetailList').innerHTML = `
        <div style="padding: 10px 0;">
          <div class="muted" style="font-size:11px; font-weight:bold; margin-bottom:6px;">${isVoice ? '🗣️ 聞き取った音声テキスト（入力データ）' : '📝 入力した文章データ'}</div>
          <div style="background:#fffafb; border:1px solid #f0dfe4; border-left:4px solid ${isVoice ? '#e7617d' : '#4361ee'}; border-radius:10px; padding:12px; font-size:14px; font-weight:bold; color:#3e3438; line-height:1.5;">
            「${esc(detail.rawText || '')}」
          </div>
          ${detail.note ? `
            <div class="muted" style="font-size:11px; font-weight:bold; margin-top:14px; margin-bottom:6px;">🤖 AIの解釈・計算メモ</div>
            <div style="background:#f8f9fa; border:1px solid #e9ecef; border-radius:10px; padding:10px 12px; font-size:13px; color:#59464e;">
              ${esc(detail.note)} ${detail.splitText ? `（${esc(detail.splitText)}）` : ''}
            </div>
          ` : ''}
        </div>
      `;

      q('#receiptDetailSummary').innerHTML = `
        <div style="display:flex; justify-content:space-between; font-size:13px; color:#59464e; margin-bottom:6px;">
          <span>元の支払総額:</span>
          <b>${yen(totalAmt)}</b>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:13px; color:#59464e; margin-bottom:8px;">
          <span>計算方法:</span>
          <b>${esc(splitLabel)}</b>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:16px; color:#e7617d; font-weight:800; border-top:1px dashed #f0dfe4; padding-top:8px;">
          <span>相手への請求額:</span>
          <span>${yen(exp.amount)}</span>
        </div>
      `;

      q('#receiptDetailModal').style.display = 'flex';
    };
  });

  q('#closeReceiptDetailBtn')?.addEventListener('click', () => {
    q('#receiptDetailModal').style.display = 'none';
  });

  q('#reopenReceiptBtn')?.addEventListener('click', () => {
    if (pendingReceiptItems.length === 0) return;
    receiptState = pendingReceiptItems.map(i => ({ ...i }));
    q('#receiptModal').style.display = 'flex';
    renderReceiptItems();
  });

  // ----------------------------------------
  // 機能③：🪄 AIスマート文章・音声入力（マイクボタン搭載）
  // ----------------------------------------
  q('#btnSmartInput')?.addEventListener('click', () => {
    smartInputState = [];
    q('#smartInputPreview').style.display = 'none';
    q('#applySmartInputBtn').style.display = 'none';
    q('#smartInputModal').style.display = 'flex';
  });
  q('#closeSmartInputBtn')?.addEventListener('click', () => {
    if (isListening) stopVoiceRecording(true);
    q('#smartInputModal').style.display = 'none';
  });

  // ★ トップ画面の「🎙️ 音声で追加」ボタン：押した瞬間に録音開始 → もう一度押すと直接AI解析＆自動登録！
  q('#btnQuickVoice')?.addEventListener('click', async () => {
    if (isTranscribing) return;
    if (isListening) {
      stopVoiceRecording(false);
      return;
    }
    await startVoiceRecording(true);
  });

  // ★ モーダル内の音声入力ボタン：録音 → Geminiで文字起こし → 自動でAI解析
  q('#btnVoiceInput')?.addEventListener('click', async () => {
    if (isTranscribing) return;
    if (isListening) {
      stopVoiceRecording(false);
      return;
    }
    await startVoiceRecording(false);
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
- totalAmountは支払った総額(整数、わかる場合。不明ならclaimAmountと同額)。
- claimAmountは「立て替えた人が相手に請求する金額(整数)」。割り勘・折半や特に指定がない共有支出は支払総額の半分(50%)、相手の分を全額立て替えた場合は100%にする。
- splitTextは「2人で割り勘 (50%)」「相手分を全額立替 (100%)」などの計算方法の説明。
- payerは私が払ったなら"me"、相手(${partnerName})が払ったなら"partner"。
- categoryは["食費","外食","生活","家賃","光熱費","交通","娯楽","旅行","その他"]のいずれか。
出力例: [{"title":"カフェ","totalAmount":1400,"claimAmount":700,"splitText":"2人で割り勘 (50%)","payer":"me","category":"外食","note":"1,400円の割り勘"}]
入力文: ${textInput}`;

      const resText = await callGeminiAPI([{ text: prompt }], true);
      const parsed = JSON.parse(resText);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('支出が読み取れませんでした');
      smartInputState = parsed.map((p: any) => ({ ...p, rawText: textInput }));

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
    const rawInputText = val('#smartInputText').trim();
    for (const item of smartInputState as any[]) {
      const payerId = item.payer === 'partner' ? partnerUid : uid;
      const amt = Math.round(Number(item.claimAmount) || 0);
      if (amt <= 0) continue;
      const memoJson = JSON.stringify({
        type: 'smart',
        rawText: item.rawText || rawInputText || item.note || '',
        note: item.note || '',
        totalAmount: Number(item.totalAmount) || amt,
        splitText: item.splitText || ''
      });
      expenses.unshift({
        id: 'temp-' + Date.now() + Math.random(),
        pair_id: pair,
        title: item.title || '支出',
        amount: amt,
        payer_id: payerId,
        category: item.category || 'その他',
        expense_date: date,
        memo: memoJson,
        created_at: new Date().toISOString()
      });
      await supabase.rpc('add_shared_expense', {
        input_pair_id: pair, input_title: item.title || '支出', input_amount: amt, input_payer_id: payerId, input_category: item.category || 'その他', input_expense_date: date, input_memo: memoJson
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
  // 機能②：🎮 ミニゲーム（オンライン2台同時接続＆1台対戦）
  // ----------------------------------------
  const switchMiniGame = (mode: typeof miniGameMode) => {
    miniGameMode = mode;
    sendGameEvent('switch_mode', { mode });
    renderMiniGameTabs();
  };

  q('#btnGameSync')?.addEventListener('click', () => switchMiniGame('sync'));
  q('#btnGameTimer')?.addEventListener('click', () => switchMiniGame('timer'));
  q('#btnGameBalloon')?.addEventListener('click', () => switchMiniGame('balloon'));
  q('#btnGameTtt')?.addEventListener('click', () => switchMiniGame('ttt'));
  q('#btnGameReact')?.addEventListener('click', () => switchMiniGame('react'));
  q('#btnGameBomb')?.addEventListener('click', () => switchMiniGame('bomb'));
  q('#btnGameQuiz')?.addEventListener('click', () => switchMiniGame('quiz'));

  q('#bombResetBtn')?.addEventListener('click', () => {
    q('#bombMsg').textContent = '交互にタップ！ハズレ(💣)で負け！';
    initBombGame(true);
  });

  document.querySelectorAll('.quiz-theme-chip').forEach((chip: any) => {
    chip.onclick = () => { q('#quizThemeInput').value = chip.dataset.theme; };
  });

  // ★ クイズの得点リセットボタン
  q('#btnQuizResetScore')?.addEventListener('click', () => {
    quizScoreP1 = 0;
    quizScoreP2 = 0;
    q('#quizScoreP1Label').textContent = '0点';
    q('#quizScoreP2Label').textContent = '0点';
    showToast('🔄 スコアを0点にリセットしました');
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
      quizPickP1 = null;
      quizPickP2 = null;
      quizRevealed = false;
      sendGameEvent('quiz_new', { quiz: currentQuiz });
      renderQuizArea(myName, partnerName);
    } catch (err: any) {
      alert(err.message);
    } finally {
      btn.textContent = '🎲 次のクイズを出題！(相手の画面にも同期)';
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
    pendingVoiceDetail = null;
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

  // ----------------------------------------
  // 🔐 管理者モードのイベントハンドラ
  // ----------------------------------------
  q('#toggleAdminModeBtn')?.addEventListener('click', () => {
    if (!isAdminMode) {
      const pw = prompt('🔐 管理者モードを開くにはパスワードを入力してください:');
      if (pw === null) return;
      if (pw !== '013000') {
        showToast('⚠️ パスワードが違います', true);
        return;
      }
      isAdminMode = true;
      showToast('🔓 管理者モードを解除しました');
    } else {
      isAdminMode = false;
    }
    render(false);
  });

  document.querySelectorAll('.admin-filter-btn').forEach((b: any) => {
    b.onclick = () => {
      adminFilter = b.dataset.filter;
      adminSelectedExpIds = [];
      render(false);
    };
  });

  document.querySelectorAll('.admin-exp-check').forEach((cb: any) => {
    cb.onchange = () => {
      const id = cb.dataset.id;
      if (cb.checked) {
        if (!adminSelectedExpIds.includes(id)) adminSelectedExpIds.push(id);
      } else {
        adminSelectedExpIds = adminSelectedExpIds.filter(x => x !== id);
      }
      const delSelBtn = q('#btnAdminDeleteSelected');
      if (delSelBtn) delSelBtn.textContent = `選択した項目 (${adminSelectedExpIds.length}件) を完全削除`;
    };
  });

  q('#btnAdminSelectAll')?.addEventListener('click', () => {
    const visibleChecks = Array.from(document.querySelectorAll('.admin-exp-check')) as HTMLInputElement[];
    const allIds = visibleChecks.map(c => c.dataset.id!);
    const allSelected = allIds.length > 0 && allIds.every(id => adminSelectedExpIds.includes(id));
    adminSelectedExpIds = allSelected ? [] : allIds;
    render(false);
  });

  // 1件ずつ完全削除（DBから物理削除）
  document.querySelectorAll('.admin-hard-del-one').forEach((b: any) => {
    b.onclick = async () => {
      const id = b.dataset.id;
      const target = expenses.find(x => x.id === id);
      if (!target) return;
      const cleanTitle = typeof target.title === 'string' && target.title.startsWith('[削除済]')
        ? target.title.replace('[削除済] ', '').split('::').slice(1).join('::')
        : target.title;
      if (!confirm(`「${cleanTitle} (${yen(target.amount)})」をデータベースから【完全削除】しますか？\n（薄く残るログも完全に消去され、元に戻せません）`)) return;

      expenses = expenses.filter(x => x.id !== id);
      adminSelectedExpIds = adminSelectedExpIds.filter(x => x !== id);
      render(false);

      const { error } = await supabase.from('expenses').delete().eq('id', id);
      if (error) {
        showToast('⚠️ 完全削除に失敗しました: ' + error.message, true);
        await load();
        render(false);
      } else {
        showToast('🗑️ 履歴から完全に消去しました');
        await load();
        render(false);
      }
    };
  });

  // 選択した複数項目を一括完全削除
  q('#btnAdminDeleteSelected')?.addEventListener('click', async () => {
    if (adminSelectedExpIds.length === 0) return showToast('⚠️ 完全削除する項目にチェックを入れてください', true);
    if (!confirm(`選択した ${adminSelectedExpIds.length} 件の履歴をデータベースから【完全削除】しますか？\n（この操作は元に戻せません）`)) return;

    const idsToDelete = [...adminSelectedExpIds];
    expenses = expenses.filter(x => !idsToDelete.includes(x.id));
    adminSelectedExpIds = [];
    render(false);

    const { error } = await supabase.from('expenses').delete().in('id', idsToDelete);
    if (error) {
      showToast('⚠️ 完全削除に失敗しました: ' + error.message, true);
    } else {
      showToast(`🗑️ ${idsToDelete.length}件を完全に消去しました`);
    }
    await load();
    render(false);
  });

  // 薄くなっている「[削除済]」ログのみを一括で完全消去
  q('#btnPurgeAllDeleted')?.addEventListener('click', async () => {
    const delIds = expenses
      .filter(e => typeof e.title === 'string' && e.title.startsWith('[削除済]'))
      .map(e => e.id);
    if (delIds.length === 0) return showToast('削除済みのログはありません');
    if (!confirm(`薄くなっている「[削除済]」ログ（${delIds.length}件）をすべてデータベースから【完全消去】しますか？`)) return;

    expenses = expenses.filter(x => !delIds.includes(x.id));
    adminSelectedExpIds = adminSelectedExpIds.filter(id => !delIds.includes(id));
    render(false);

    const { error } = await supabase.from('expenses').delete().in('id', delIds);
    if (error) {
      showToast('⚠️ 完全消去に失敗しました: ' + error.message, true);
    } else {
      showToast(`🧹 削除済みログ ${delIds.length}件を完全消去しました！`);
    }
    await load();
    render(false);
  });

  // タイムラインで「[削除済]」を隠すトグル
  q('#btnToggleHideDeleted')?.addEventListener('click', () => {
    hideDeletedInTimeline = !hideDeletedInTimeline;
    localStorage.setItem('pp_hide_deleted', hideDeletedInTimeline ? '1' : '0');
    showToast(hideDeletedInTimeline ? '👁️ タイムラインの[削除済]ログを非表示にしました' : '👁️ タイムラインの[削除済]ログを表示するようにしました');
    render(false);
  });

  // 部屋名（ペア名）の変更
  q('#btnUpdatePairName')?.addEventListener('click', async () => {
    const newPairName = val('#adminPairName').trim();
    if (!newPairName) return showToast('⚠️ 部屋名を入力してください', true);
    const { error } = await supabase.from('pairs').update({ name: newPairName }).eq('id', pair);
    if (error) return showToast('⚠️ 部屋名の変更に失敗しました: ' + error.message, true);
    showToast('🏠 部屋名を更新しました！');
    render(false);
  });

  // サブスク処理済フラグのリセット＆再実行
  q('#btnResetSubFlags')?.addEventListener('click', async () => {
    if (!confirm('登録されているサブスクの「今月の自動追加済みフラグ」をリセットし、今すぐ自動追加チェックを再実行しますか？')) return;
    const subs = JSON.parse(localStorage.getItem(`subs_${pair}`) || '[]');
    subs.forEach((s: any) => { delete s.lastProcessedMonth; });
    localStorage.setItem(`subs_${pair}`, JSON.stringify(subs));
    showToast('🔄 フラグをリセットしました。自動追加を実行します...');
    await processAutoSubs();
    render(false);
  });

  // CSVエクスポート
  q('#btnExportCsv')?.addEventListener('click', () => {
    if (expenses.length === 0) return showToast('⚠️ 出力する履歴がありません', true);
    const header = '日付,内容,請求額,支払者,カテゴリー,ステータス\n';
    const rows = expenses.map(e => {
      const isDel = typeof e.title === 'string' && e.title.startsWith('[削除済]');
      const cleanTitle = (isDel ? e.title.replace('[削除済] ', '').split('::').slice(1).join('::') : (e.title || '')).replace(/"/g, '""');
      const payerName = nameFn(e.payer_id).replace(/"/g, '""');
      const cat = (e.category || 'その他').replace(/"/g, '""');
      const status = isDel ? '削除済' : '有効';
      return `"${e.expense_date || ''}","${cleanTitle}",${e.amount},"${payerName}","${cat}","${status}"`;
    }).join('\n');
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, header + rows], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `PairPocket_Expenses_${getToday()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('📥 CSVファイルを書き出しました');
  });

  // キャッシュ再構築
  q('#btnClearLocalCache')?.addEventListener('click', async () => {
    localStorage.removeItem('pp_cache');
    await load();
    render(false);
    showToast('🧹 キャッシュを再構築しました！');
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
    : (pendingVoiceDetail ? JSON.stringify(pendingVoiceDetail) : null);

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
  pendingVoiceDetail = null;
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

async function logout() {
  sendLiveBye();
  localStorage.removeItem('pp_cache');
  hasBooted = false;
  uid = '';
  pair = '';
  partnerOnline = false;
  liveStatus = 'idle';
  await supabase.auth.signOut();
  boot();
}
function q(s: string) { return document.querySelector(s) as any; }
function val(s: string) { return q(s)?.value || ''; }
function fail(s: string) { app.innerHTML = `<main class="app"><div class="notice">${esc(s)}</div></main>`; }

supabase.auth.onAuthStateChange((event, session) => {
  if (session?.access_token) {
    try { supabase.realtime.setAuth(session.access_token); } catch {}
  }
  if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
    if (session && !hasBooted) boot();
    else if (session && pair && liveStatus !== 'connected') setupRealtime(true);
  } else if (event === 'SIGNED_OUT') {
    sendLiveBye();
    hasBooted = false;
    uid = ''; pair = ''; partnerOnline = false; liveStatus = 'idle';
    authView();
  }
});

// キャッシュ起動時でも必ず Realtime 接続と最新同期を走らせる
boot();
