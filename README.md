# db-health-monitor

Supabase の DB の死活監視です。GitHub Actions で 10 分ごとに（外部の定期実行サービスから手動実行 `mode=live` を呼ぶ）、公開用の鍵で各 DB の小さな表を 1 行だけ読み、
止まった・遅くなった・戻ったときに Discord へ知らせます。

- 対象の一覧と通知先は、すべて GitHub の Secrets に入れます（このリポジトリには書きません）。
- 2 回続けて失敗したら 🔴、3 秒超が 3 回続いたら 🟡、戻ったら 🟢。止まっている間は 60 分ごとに念押し。メンションは付けません。
- 10 分ごとの呼び出し: `POST /repos/<owner>/db-health-monitor/actions/workflows/db-health.yml/dispatches`、本文 `{"ref":"main","inputs":{"mode":"live"}}`。鍵は呼ぶ側にだけ置きます。GitHub の schedule はこのリポジトリで動かなかったので使いません。
- 止め方: Variables の `DB_HEALTH_ENABLED` を消す（live が来ても何もしない）。
- 試し方: Actions → DB Health Monitor → Run workflow（`dry_run` は送らない、`test_notify` は試験通知を 1 回）。
- 手元での確認: `node scripts/monitor/test-db-health.mjs`
