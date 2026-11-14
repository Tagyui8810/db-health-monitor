// scripts/monitor/db-health.mjs の確認（node scripts/monitor/test-db-health.mjs）。外部には送らない。
import assert from 'node:assert/strict';
const m = await import('./db-health.mjs');

const T0 = Date.parse('2026-11-14T08:40:00Z'); // 17:40 JST
const MIN = 60000;
const ok = (ms = 300) => ({ ok: true, ms, slow: ms > 3000 });
const fail = () => ({ ok: false, ms: 20000, status: 522, error: 'HTTP 522', slow: false });

// 1) 止まるまでの典型的な流れ: 17:40 正常 → 17:50〜18:00 遅い → 18:10〜18:50 失敗 → 19:00 復旧（10 分ごと）
const seq = [ok(), ok(3500), ok(4200), ok(5100), fail(), fail(), fail(), fail(), fail(), fail(), fail(), fail(), ok(400)];
let st, all = [];
seq.forEach((r, i) => { const { state, msgs } = m.step(st, 'DB1', r, T0 + i * 10 * MIN); st = state; all.push(...msgs.map((x) => `${i}:${x}`)); });
console.log(all.join('\n'));
assert.equal(all.filter((x) => x.includes('🟡')).length, 1, '遅いの通知は 1 回');
assert.ok(all.some((x) => x.startsWith('3:') && x.includes('🟡')), '遅いが 3 回続いた時点（17:30+30分）で知らせる');
assert.ok(all.some((x) => x.startsWith('5:') && x.includes('🔴')), '失敗が 2 回続いた時点で知らせる');
assert.equal(all.filter((x) => x.includes('🔴') && x.includes('応答していません')).length, 1, '止まった通知は 1 回');
assert.ok(all.some((x) => x.includes('まだ止まっています')), '60 分ごとの念押し');
assert.ok(all.some((x) => x.startsWith('12:') && x.includes('🟢') && x.includes('復旧')), '復旧を知らせる');
assert.deepEqual(st, { fail: 0, slow: 0, alerted: null, since: null, lastRemind: null });

// 2) 1 回だけの失敗・1〜2 回の遅さでは知らせない（誤報を避ける）
let s2; const msgs2 = [];
for (const r of [fail(), ok(), ok(3500), ok(3600), ok(), fail(), ok()]) { const o = m.step(s2, 'DB2', r, T0); s2 = o.state; msgs2.push(...o.msgs); }
assert.equal(msgs2.length, 0, msgs2.join('\n'));

// 3) 止まったあと、遅い応答で戻ったとき: 復旧を知らせ、続けて遅ければ遅いとして数え直す
let s3; const msgs3 = [];
for (const r of [fail(), fail(), ok(3500), ok(3500), ok(3500)]) { const o = m.step(s3, 'X', r, T0); s3 = o.state; msgs3.push(...o.msgs); }
assert.equal(msgs3.length, 3, msgs3.join('\n')); // 止まった・戻った（遅め）・遅い
assert.ok(msgs3[1].includes('応答するようになりました'));
assert.ok(msgs3[2].includes('🟡'));

// 4) check: 1 回目失敗 → 試し直しで成功なら成功扱い
let n = 0;
const flaky = async () => { n++; if (n === 1) throw new Error('fetch failed'); return new Response('[]', { status: 200 }); };
const r4 = await m.check({ name: 'A', url: 'https://x.supabase.co', key: 'k', table: 't' }, flaky, async () => {});
assert.equal(r4.ok, true); assert.equal(n, 2);
const r5 = await m.check({ name: 'B', url: 'https://x.supabase.co/', key: 'k', table: 't' }, async () => new Response('err', { status: 522 }), async () => {});
assert.equal(r5.ok, false); assert.equal(r5.error, 'HTTP 522');

// 5) 送る文面にメンション（@everyone 等）や鍵が入らない
assert.ok(all.every((x) => !/@everyone|@here|<@/.test(x)));

// 6) 送り先: 🔴 だけ司令室にも。🟡🟢・試験通知は通常の通知先だけ
const N = 'https://discord.example/normal', A = 'https://discord.example/alert';
assert.deepEqual(m.destinations('🔴 【X】DB が応答していません', { normal: N, alert: A }), [N, A]);
assert.deepEqual(m.destinations('🔴 【X】まだ止まっています', { normal: N, alert: A }), [N, A]);
assert.deepEqual(m.destinations('🟡 【X】遅い', { normal: N, alert: A }), [N]);
assert.deepEqual(m.destinations('🟢 【X】復旧', { normal: N, alert: A }), [N]);
assert.deepEqual(m.destinations('🔴 試験', { normal: N, alert: A, test: true }), [N]);
assert.deepEqual(m.destinations('🔴 【X】', { normal: N, alert: '' }), [N]);
assert.ok(all.filter((x) => x.includes('🔴')).every((x) => x.split(':').slice(1).join(':').startsWith('🔴')), '🔴 の文面は先頭が 🔴');

console.log('test-db-health: ok');
