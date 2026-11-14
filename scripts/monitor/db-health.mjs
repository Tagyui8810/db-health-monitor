// Supabase の DB の死活監視（2026-11-14）。
// どこで動かしても同じ（GitHub Actions を想定）。依存パッケージなし・Node 20 以上。
//
// しくみ:
//   各 DB に「公開用の鍵（anon）で小さな表を1行だけ読む」要求を送る。RLS で中身は空でも、
//   PostgREST が Postgres に問い合わせるので、DB が止まれば 5xx・時間切れになる（今回は 522）。
//   1回の確かめで最大2回試し（間 20 秒）、2回とも失敗なら「失敗」。成功でも 3 秒を超えたら「遅い」。
//   前回までの状態をファイル（STATE_FILE）に持ち、続けて起きたときだけ知らせる:
//     ・失敗が 2 回続いたら「止まっている」（10 分ごとの実行なら 10〜20 分で気づく）
//     ・遅いが 3 回続いたら「弱り始め」
//     ・止まっている間は 60 分ごとに「まだ止まっている」
//     ・知らせたあとに 1 回成功したら「復旧した」（止まっていた時間つき）
//   通知先は Discord の Webhook。メンションは付けない（夜中に起こさない）。
//     DISCORD_WEBHOOK_URL       … すべての通知（🔴🟡🟢）
//     DISCORD_WEBHOOK_URL_ALERT … 🔴（止まった・まだ止まっている）だけ。無ければ送らない
//   Webhook が無いとき、または DRY_RUN=1 のときは、送る文面を標準出力に出すだけ。
//   TEST_NOTIFY=1 のときは、いまの結果を「試験通知」として DISCORD_WEBHOOK_URL にだけ 1 回送る（状態は進めない）。
//
// 対象は環境変数 DB_HEALTH_TARGETS（JSON 配列）:
//   [{"name":"表示名","url":"https://<project>.supabase.co","key":"<anon>","table":"<小さな表>"}, ...]
//   url・key はリポジトリに書かない（GitHub の Secrets から渡す）。
// 負荷: 1 回の確かめで、各 DB に limit=1 の読み取り 1〜2 回だけ（10 分ごとなら 1 日 144〜288 件）。

import fs from 'node:fs';

const FAIL_STREAK = Number(process.env.FAIL_STREAK || 2);
const SLOW_STREAK = Number(process.env.SLOW_STREAK || 3);
const SLOW_MS = Number(process.env.SLOW_MS || 3000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 15000);
const RETRY_WAIT_MS = Number(process.env.RETRY_WAIT_MS ?? 20000);
const REMIND_MIN = Number(process.env.REMIND_MIN || 60);
const STATE_FILE = process.env.STATE_FILE || '.db-health-state.json';
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const ALERT_WEBHOOK = process.env.DISCORD_WEBHOOK_URL_ALERT || '';
const DRY = process.env.DRY_RUN === '1' || !WEBHOOK;
const TEST = process.env.TEST_NOTIFY === '1';

const jst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ').replace('-', '/');
const mins = (ms) => Math.max(1, Math.round(ms / 60000));

export async function probe(t, fetchImpl = fetch) {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${t.url.replace(/\/$/, '')}/rest/v1/${t.table}?select=*&limit=1`, {
      headers: { apikey: t.key, Authorization: `Bearer ${t.key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    await res.text().catch(() => '');
    if (res.status >= 200 && res.status < 300) return { ok: true, ms, status: res.status };
    return { ok: false, ms, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, status: 0, error: e?.name === 'TimeoutError' ? `${TIMEOUT_MS / 1000}秒で応答なし` : String(e?.message || e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 80) };
  }
}

/** 1 つの DB を確かめる（失敗なら 1 回だけ試し直す） */
export async function check(t, fetchImpl = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let r = await probe(t, fetchImpl);
  if (!r.ok) { await wait(RETRY_WAIT_MS); r = await probe(t, fetchImpl); }
  return { ...r, slow: r.ok && r.ms > SLOW_MS };
}

/** 状態を進めて、送る文面（無ければ null）を返す。純粋関数（テスト用） */
export function step(prev, name, r, now) {
  const s = { fail: 0, slow: 0, alerted: null, since: null, lastRemind: null, ...(prev || {}) };
  const msgs = [];
  if (!r.ok) {
    s.fail += 1; s.slow = 0;
    if (!s.since) s.since = now;
    if (s.fail >= FAIL_STREAK && s.alerted !== 'down') {
      msgs.push(`🔴 【${name}】DB が応答していません（${s.fail} 回続けて失敗・${r.error}）。${jst(s.since)} JST ごろから。管理画面の STATUS と Reports を確認してください。`);
      s.alerted = 'down'; s.lastRemind = now;
    } else if (s.alerted === 'down' && now - (s.lastRemind || 0) >= REMIND_MIN * 60000) {
      msgs.push(`🔴 【${name}】まだ止まっています（${jst(s.since)} JST から 約${mins(now - s.since)}分・${r.error}）。`);
      s.lastRemind = now;
    }
  } else if (r.slow) {
    if (s.alerted === 'down') {
      msgs.push(`🟢 【${name}】DB が応答するようになりました（止まっていたのは ${jst(s.since)}〜${jst(now)} JST・約${mins(now - s.since)}分）。ただし応答が遅め（${(r.ms / 1000).toFixed(1)}秒）です。`);
      s.alerted = null; s.since = null; s.lastRemind = null; s.slow = 0;
    }
    s.fail = 0; s.slow += 1;
    if (s.slow >= SLOW_STREAK && !s.alerted) {
      msgs.push(`🟡 【${name}】DB の応答が遅くなっています（${s.slow} 回続けて ${SLOW_MS / 1000} 秒超・今回 ${(r.ms / 1000).toFixed(1)}秒）。止まる前ぶれのことがあります。管理画面の Disk IO とメモリを確認してください。`);
      s.alerted = 'slow';
    }
  } else {
    if (s.alerted === 'down') msgs.push(`🟢 【${name}】DB が復旧しました（止まっていたのは ${jst(s.since)}〜${jst(now)} JST・約${mins(now - s.since)}分・今回 ${(r.ms / 1000).toFixed(1)}秒）。`);
    else if (s.alerted === 'slow') msgs.push(`🟢 【${name}】DB の応答がふだんに戻りました（今回 ${(r.ms / 1000).toFixed(1)}秒）。`);
    return { state: { fail: 0, slow: 0, alerted: null, since: null, lastRemind: null }, msgs };
  }
  return { state: s, msgs };
}

/** 送り先: すべて → 通常の通知先。🔴 だけ → 司令室用にも（ALERT_WEBHOOK があれば） */
export function destinations(text, { normal = WEBHOOK, alert = ALERT_WEBHOOK, test = false } = {}) {
  const out = [];
  if (normal) out.push(normal);
  if (!test && alert && text.startsWith('🔴') && alert !== normal) out.push(alert);
  return out;
}

async function post(text, opts = {}) {
  if (DRY && process.env.GITHUB_ACTIONS === 'true') { console.log(`[dry-run] 通知 1 件（公開の実行記録には文面を出しません）`); return; }
  if (DRY) { console.log(`[dry-run${opts.test ? '' : ALERT_WEBHOOK && text.startsWith('🔴') ? '・司令室にも' : ''}] ` + text); return; }
  for (const url of destinations(text, opts)) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }) });
    if (!res.ok) console.error(`Discord への送信に失敗: HTTP ${res.status}`);
  }
}

async function main() {
  let targets;
  try { targets = JSON.parse(process.env.DB_HEALTH_TARGETS || '[]'); } catch { console.error('DB_HEALTH_TARGETS が JSON ではありません'); process.exit(2); }
  if (!targets.length) { console.error('DB_HEALTH_TARGETS が空です'); process.exit(2); }
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* 初回 */ }
  const results = await Promise.all(targets.map((t) => check(t)));
  const now = Date.now();
  if (TEST) {
    const lines = targets.map((t, i) => { const r = results[i]; return `・${t.name}: ${r.ok ? `正常（${(r.ms / 1000).toFixed(1)}秒${r.slow ? '・遅め' : ''}）` : `応答なし（${r.error}）`}`; });
    await post(`🧪 【試験通知】DB の見守りの設定確認です（この通知は試験で、ここにだけ送っています）。\n${lines.join('\n')}`, { test: true });
    return; // 状態は進めない
  }
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i], r = results[i];
    const { state: ns, msgs } = step(state[t.name], t.name, r, now);
    state[t.name] = ns;
    // 公開リポジトリの実行記録は誰でも読めるので、対象の名前は出さず番号だけ（文面は Discord にだけ送る）
    console.log(`#${i + 1}: ${r.ok ? (r.slow ? 'slow' : 'ok') : 'FAIL'} ${r.ms}ms ${r.error || ''} (fail=${ns.fail} slow=${ns.slow} alerted=${ns.alerted})`);
    if (msgs.length) console.log(`#${i + 1}: 通知 ${msgs.length} 件`);
    for (const m of msgs) await post(m);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

if (/[\\/]scripts[\\/]monitor[\\/]db-health\.mjs$/.test(process.argv[1] || '')) main();
