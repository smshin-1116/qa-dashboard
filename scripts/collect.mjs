/**
 * 수집기 수동 실행 — 아침 스케줄이 붙기 전까지의 진입점이자 검증 도구.
 *
 * 사용:
 *   npm run collect          # 수집만
 *   npm run collect -- --dump  # 수집 후 저장 내용 요약 출력
 *
 * ⚠️ LLM을 호출하지 않는다. 순수 fetch·parse라 토큰 비용이 0이다.
 */
import { loadEnvLocal } from './load-env.mjs';

loadEnvLocal();

const { collectAll } = await import('../lib/workspace/collectors/index.ts');
const { getDb } = await import('../lib/workspace/db.ts');

const started = Date.now();
console.log('수집 시작…\n');

const results = await collectAll();

for (const r of results) {
  const mark = r.ok ? '✅' : '❌';
  console.log(`${mark} ${r.name.padEnd(9)} ${r.ok ? r.detail : r.error}`);
}
console.log(`\n소요 ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (process.argv.includes('--dump')) {
  const db = getDb();
  const q = (sql) => db.prepare(sql).all();

  console.log('\n── 저장 결과 ──────────────────────────────');
  for (const t of ['signal', 'test_run', 'finding', 'ticket_link', 'todo', 'notice']) {
    const c = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    console.log(`${t.padEnd(12)} ${c}행`);
  }

  console.log('\n── 실행 결과 ──────────────────────────────');
  for (const r of q(
    `SELECT runner, suite, status, passed, failed, skipped, total, started_at
     FROM test_run ORDER BY started_at DESC`,
  )) {
    console.log(
      `${r.runner.padEnd(4)} ${r.suite.padEnd(18)} ${String(r.status).padEnd(8)} ` +
        `${r.passed ?? '?'}/${r.total ?? '?'} 실패 ${r.failed ?? '?'}  ${r.started_at?.slice(0, 16) ?? ''}`,
    );
  }

  console.log('\n── 실패 분류 ──────────────────────────────');
  for (const r of q(
    `SELECT kind, verdict_by, COUNT(*) AS c FROM finding
     WHERE resolved_at IS NULL GROUP BY kind, verdict_by ORDER BY c DESC`,
  )) {
    console.log(`${String(r.kind).padEnd(16)} ${String(r.verdict_by).padEnd(6)} ${r.c}건`);
  }

  console.log('\n── QA 중 티켓 (내 리포트) ─────────────────');
  for (const r of q(
    `SELECT jira_key, status, summary FROM ticket_link
     WHERE is_mine = 1 AND status IS NOT NULL ORDER BY updated_at DESC LIMIT 8`,
  )) {
    console.log(`${r.jira_key.padEnd(8)} ${String(r.summary).slice(0, 58)}`);
  }

  console.log('\n── 최근 신호 ──────────────────────────────');
  for (const r of q(
    `SELECT source, kind, severity, title FROM signal
     ORDER BY observed_at DESC LIMIT 10`,
  )) {
    console.log(
      `${r.source.padEnd(9)} ${String(r.severity).padEnd(5)} ${String(r.title).slice(0, 62)}`,
    );
  }
}
