BRASS+ 修正版候補

含まれるファイル: index.html / server.js / package.json

今回の修正候補:
- 重複定義されていた goalMini / practiceMini / issueMini を1つに整理
- 練習・課題点の完了状態をメンバー名別で管理し、同期時も他メンバーの完了状態を保持
- SUPABASE_URL と SUPABASE_SECRET_KEY が設定されていれば Supabase の public.brass_groups テーブルへ永続保存
- Supabase環境変数がない場合は従来どおりJSONファイル保存

注意:
- 実際のRender/Supabaseへデプロイしての複数端末テストは未実施です。
- Supabase側は public.brass_groups (code text primary key, group_data jsonb, updated_at timestamptz) が必要です。
- このZIPをGitHubへ上書きする前に、既存の動作とデータを確認してください。
