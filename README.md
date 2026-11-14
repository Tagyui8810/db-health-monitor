# db-health-monitor

Supabase の DB の死活監視です。GitHub Actions で 10 分ごとに、公開用の鍵で各 DB の小さな表を 1 行だけ読み、
止まった・遅くなった・戻ったときに Discord へ知らせます。

- 対象の一覧と通知先は、すべて GitHub の Secrets に入れます（このリポジトリには書きません）。
- 2 回続けて失敗したら 🔴、3 秒超が 3 回続いたら 🟡、戻ったら 🟢。止まっている間は 60 分ごとに念押し。メンションは付けません。
- 試し方: Actions → DB Health Monitor → Run workflow（`dry_run` は送らない、`test_notify` は試験通知を 1 回）。
- 手元での確認: `node scripts/monitor/test-db-health.mjs`
