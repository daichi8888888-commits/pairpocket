# PairPocket

SupabaseとVercelで動かす、2人用の支出共有Webアプリです。

## 1. 環境変数
`.env.example`を`.env.local`へコピーし、自分のSupabase情報を設定します。

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

Secret keyやDatabase Passwordは設定しないでください。

## 2. ローカル実行
```bash
npm install
npm run dev
```

## 3. GitHub / Vercel
このフォルダーをGitHubリポジトリへ登録し、VercelでImportします。VercelのEnvironment Variablesにも上記2項目を登録します。

## 前提
Supabase SQL Editorで、会話内で作成したPairPocket用SQLを実行済みであること。
