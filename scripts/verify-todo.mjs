/**
 * todo 규칙 엔진 검증.
 *
 * 실데이터로 오늘 산출을 돌린 뒤, 규칙 ②~⑤(정렬·이월·상한·승격)를
 * 가상의 날짜를 밀어가며 확인한다. 수집 없이 DB만 읽고 쓴다.
 */
import { loadEnvLocal } from './load-env.mjs';
loadEnvLocal();

const { buildToday, listToday, promote, CARRY_LIMIT_DAYS, HOT_AFTER_DAYS } = await import(
  '../lib/workspace/todo.ts'
);
const { getDb, todayKst } = await import('../lib/workspace/db.ts');
const { activeNotices } = await import('../lib/workspace/repo.ts');

const db = getDb();

// ── 1. 실데이터로 오늘 산출 ────────────────────────────────────────────
const today = todayKst();
const r = buildToday(today);
console.log(`■ 오늘(${r.day}) 산출 — 신규 ${r.created} · 이월 ${r.carried} · 알림이동 ${r.movedToNotice}\n`);

const items = listToday(today);
for (const t of items) {
  const dplus = t.carriedDays > 0 ? `D+${t.carriedDays}${t.hot ? '🔥' : ''}` : '     ';
  const pin = t.pinned ? '📌' : '  ';
  console.log(
    `  ${t.priority} ${dplus.padEnd(7)} ${pin} [${String(t.mode).padEnd(6)}] ${t.title}`,
  );
  if (t.detail) console.log(`         ${String(t.detail).slice(0, 96)}`);
}

// ── 2. 정렬 규칙 검증 ──────────────────────────────────────────────────
const ORDER = ['P0', 'P1', 'P2', 'P3'];
let sorted = true;
for (let i = 1; i < items.length; i++) {
  const a = items[i - 1], b = items[i];
  if (a.done_at || b.done_at) continue;
  const pa = ORDER.indexOf(a.priority), pb = ORDER.indexOf(b.priority);
  if (pa > pb) sorted = false;
  if (pa === pb && a.carriedDays < b.carriedDays) sorted = false;
}
console.log(`\n■ 규칙② 정렬(우선순위→경과일 내림차순): ${sorted ? '✅ 통과' : '❌ 실패'}`);

// ── 3. 이월·상한·승격 시나리오 ────────────────────────────────────────
console.log('\n■ 규칙③④⑤ 시나리오 (가상 날짜를 밀어가며)');
const KEY = 'api:contract-drift-SIM';
const start = '2026-08-01';

// 가상 항목을 심는다
db.prepare(
  `INSERT OR REPLACE INTO todo (day,key,priority,title,source,mode,first_day,pinned,promoted,created_at)
   VALUES (?,?,?,?,?,?,?,0,0,datetime('now'))`,
).run(start, KEY, 'P2', '시뮬레이션 항목', 'api-test', 'manual', start);

function ageAt(day) {
  const ms = Date.parse(day + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z');
  return Math.round(ms / 86400000);
}
for (const day of ['2026-08-03', '2026-08-05', '2026-08-08', '2026-08-09']) {
  const age = ageAt(day);
  const hot = age > HOT_AFTER_DAYS;
  const over = age > CARRY_LIMIT_DAYS;
  console.log(
    `  ${day}  D+${String(age).padEnd(2)}  위험색=${hot ? 'O' : 'X'}  상한초과=${over ? 'O → 알림 이동' : 'X'}`,
  );
}
console.log(`  승격: P3→${promote('P3')} · P2→${promote('P2')} · P1→${promote('P1')} · P0→${promote('P0')}(최상)`);
db.prepare('DELETE FROM todo WHERE key = ?').run(KEY);

// ── 4. 알림 ────────────────────────────────────────────────────────────
const notices = activeNotices();
console.log(`\n■ 🔔 알림 ${notices.length}건`);
for (const n of notices) {
  console.log(`  [${String(n.kind).padEnd(14)}] ${n.days != null ? `${n.days}일` : '   '}  ${n.title}`);
}

// ── 5. 멱등성 ─────────────────────────────────────────────────────────
const before = listToday(today).length;
buildToday(today);
buildToday(today);
const after = listToday(today).length;
console.log(`\n■ 멱등성 (3회 산출): ${before} → ${after} ${before === after ? '✅ 통과' : '❌ 실패'}`);
