import './style.css'
import { supabase } from './supabase'

type Expense={id:string,title:string,amount:number,category:string,expense_date:string,payer_id:string,profiles?:{display_name:string}}
type Member={user_id:string,role:string,profiles?:{display_name:string}}
const app=document.querySelector<HTMLDivElement>('#app')!
let pairId:string|null=null, userId:string|null=null, members:Member[]=[], expenses:Expense[]=[]
const yen=(n:number)=>`¥${Math.round(n).toLocaleString('ja-JP')}`
const esc=(s:any)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))

async function boot(){
 const {data:{session}}=await supabase.auth.getSession(); userId=session?.user.id??null
 if(!userId){renderAuth();return} await loadPair();
}
function renderAuth(msg=''){
 app.innerHTML=`<div class="app"><div class="center"><p class="muted">ふたりのお金</p><h1>PairPocket</h1></div>${msg?`<div class="notice">${esc(msg)}</div>`:''}<div class="card"><h2>ログイン</h2><input id="email" class="field" type="email" placeholder="メールアドレス"><input id="password" class="field" type="password" placeholder="パスワード（6文字以上）"><div class="grid"><button id="signup" class="ghost">新規登録</button><button id="signin" class="dark">ログイン</button></div></div></div>`
 document.querySelector('#signup')!.addEventListener('click',()=>auth(true));document.querySelector('#signin')!.addEventListener('click',()=>auth(false))
}
async function auth(signup:boolean){
 const email=(document.querySelector('#email') as HTMLInputElement).value, password=(document.querySelector('#password') as HTMLInputElement).value
 const r=signup?await supabase.auth.signUp({email,password}):await supabase.auth.signInWithPassword({email,password})
 if(r.error)return renderAuth(r.error.message); if(signup&&!r.data.session)return renderAuth('確認メールを開いてからログインしてください。'); boot()
}
async function loadPair(){
 const {data,error}=await supabase.from('pair_members').select('pair_id').eq('user_id',userId!).maybeSingle()
 if(error){renderError(error.message);return} pairId=data?.pair_id??null
 if(!pairId){renderPairStart();return} await refresh(); render('home')
}
function renderPairStart(msg=''){
 app.innerHTML=`<div class="app"><div class="top"><h1>PairPocket</h1><button id="logout" class="ghost">ログアウト</button></div>${msg?`<div class="notice error">${esc(msg)}</div>`:''}<div class="card"><h2>新しいペアを作る</h2><input id="pairName" class="field" value="ふたりの家計"><button id="createPair" class="dark">ペアを作成</button></div><div class="card"><h2>招待コードで参加</h2><input id="invite" class="field" maxlength="8" placeholder="8文字のコード"><button id="joinPair" class="primary">参加する</button></div></div>`
 document.querySelector('#logout')!.addEventListener('click',logout)
 document.querySelector('#createPair')!.addEventListener('click',async()=>{const name=(document.querySelector('#pairName') as HTMLInputElement).value;const {error}=await supabase.rpc('create_pair',{pair_name:name});error?renderPairStart(error.message):loadPair()})
 document.querySelector('#joinPair')!.addEventListener('click',async()=>{const code=(document.querySelector('#invite') as HTMLInputElement).value;const {error}=await supabase.rpc('join_pair',{input_invite_code:code});error?renderPairStart(error.message):loadPair()})
}
async function refresh(){
 const [m,e]=await Promise.all([
  supabase.from('pair_members').select('user_id,role,profiles(display_name)').eq('pair_id',pairId!),
  supabase.from('expenses').select('id,title,amount,category,expense_date,payer_id').eq('pair_id',pairId!).order('expense_date',{ascending:false}).order('created_at',{ascending:false})
 ]); if(m.error||e.error){renderError((m.error||e.error)!.message);throw new Error()}; members=(m.data||[]) as any;expenses=e.data||[]
}
async function pairInfo(){return await supabase.from('pairs').select('name,invite_code').eq('id',pairId!).single()}
function calculate(){
 const paid=new Map<string,number>(), share=new Map<string,number>();members.forEach(m=>{paid.set(m.user_id,0);share.set(m.user_id,0)})
 expenses.forEach(e=>paid.set(e.payer_id,(paid.get(e.payer_id)||0)+e.amount))
 return {total:expenses.reduce((s,e)=>s+e.amount,0),paid,share}
}
async function render(tab='home'){
 const info=await pairInfo();const total=expenses.reduce((s,e)=>s+e.amount,0);const memberName=(id:string)=>members.find(m=>m.user_id===id)?.profiles?.display_name||'メンバー'
 const each=members.length?total/members.length:0;const paid1=members[0]?expenses.filter(e=>e.payer_id===members[0].user_id).reduce((s,e)=>s+e.amount,0):0;const diff=paid1-each
 app.innerHTML=`<div class="app"><div class="top"><div><div class="muted">ふたりのお金</div><div class="title">${esc(info.data?.name||'PairPocket')}</div></div><button id="logout" class="ghost">ログアウト</button></div>
 <div id="home" class="${tab==='home'?'':'hide'}"><div class="card hero"><div class="muted">合計支出</div><div class="amount">${yen(total)}</div><div class="grid">${members.map(m=>`<div class="pill"><div class="small">${esc(memberName(m.user_id))}</div><b>${yen(expenses.filter(e=>e.payer_id===m.user_id).reduce((s,e)=>s+e.amount,0))}</b></div>`).join('')}</div></div><div class="card"><div class="muted">現在の概算精算額</div><h2>${members.length<2?'パートナーの参加待ち':diff>=0?`${esc(memberName(members[1].user_id))} → ${esc(memberName(members[0].user_id))}`:`${esc(memberName(members[0].user_id))} → ${esc(memberName(members[1].user_id))}`}</h2><div class="amount">${members.length<2?'－':yen(Math.abs(diff))}</div></div><button id="openAdd" class="primary">＋ 支払いを追加</button></div>
 <div id="history" class="${tab==='history'?'':'hide'}"><div class="card"><h2>支払い履歴</h2>${expenses.length?expenses.map(e=>`<div class="expense"><div><b>${esc(e.title)}</b><div class="muted">${esc(memberName(e.payer_id))}・${esc(e.category)}・${e.expense_date}</div></div><div><b>${yen(e.amount)}</b> <button class="danger del" data-id="${e.id}">削除</button></div></div>`).join(''):'<p class="muted">まだ支払いがありません</p>'}</div></div>
 <div id="settings" class="${tab==='settings'?'':'hide'}"><div class="card"><h2>ペア設定</h2><p class="muted">パートナーにこのコードを伝えてください</p><div class="amount">${esc(info.data?.invite_code||'')}</div><p>${members.length}/2人参加</p></div></div>
 <div id="add" class="card hide"><h2>支払いを追加</h2><input id="title" class="field" placeholder="スーパー、家賃など"><input id="amount" class="field" inputmode="numeric" type="number" placeholder="金額"><select id="payer" class="field">${members.map(m=>`<option value="${m.user_id}">${esc(memberName(m.user_id))}</option>`).join('')}</select><select id="category" class="field">${['食費','外食','生活','家賃','光熱費','交通','娯楽','旅行','その他'].map(c=>`<option>${c}</option>`).join('')}</select><div class="grid"><button id="cancel" class="ghost">戻る</button><button id="save" class="primary">登録</button></div></div>
 <nav class="tabs"><button data-tab="home" class="${tab==='home'?'active':''}">ホーム</button><button data-tab="history" class="${tab==='history'?'active':''}">履歴</button><button data-tab="settings" class="${tab==='settings'?'active':''}">設定</button></nav></div>`
 document.querySelector('#logout')!.addEventListener('click',logout);document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>render((b as HTMLElement).dataset.tab)))
 document.querySelector('#openAdd')?.addEventListener('click',()=>{['home','history','settings'].forEach(x=>document.querySelector('#'+x)?.classList.add('hide'));document.querySelector('#add')?.classList.remove('hide')})
 document.querySelector('#cancel')?.addEventListener('click',()=>render('home'));document.querySelector('#save')?.addEventListener('click',saveExpense)
 document.querySelectorAll('.del').forEach(b=>b.addEventListener('click',async()=>{await supabase.from('expenses').delete().eq('id',(b as HTMLElement).dataset.id!);await refresh();render('history')}))
}
async function saveExpense(){
 const title=(document.querySelector('#title') as HTMLInputElement).value,amount=Number((document.querySelector('#amount') as HTMLInputElement).value),payer=(document.querySelector('#payer') as HTMLSelectElement).value,category=(document.querySelector('#category') as HTMLSelectElement).value
 const {error}=await supabase.rpc('add_shared_expense',{input_pair_id:pairId,input_title:title,input_amount:amount,input_payer_id:payer,input_category:category,input_expense_date:new Date().toISOString().slice(0,10),input_memo:null})
 if(error){alert(error.message);return}await refresh();render('home')
}
async function logout(){await supabase.auth.signOut();pairId=null;userId=null;boot()}
function renderError(s:string){app.innerHTML=`<div class="app"><div class="notice error"><b>エラー</b><br>${esc(s)}</div></div>`}
boot()
