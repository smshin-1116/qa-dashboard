import { setMeta, nowIso } from '../db';
import { collectApiTest } from './apiTest';
import { collectDatadog } from './datadog';
import { collectJira } from './jira';
import { collectStagePr } from './stagePr';
import { collectWebE2e } from './webE2e';
import type { CollectorResult } from './shared';

export type { CollectorResult } from './shared';

/**
 * 수집기 오케스트레이터.
 *
 * ── 원칙 ──────────────────────────────────────────────────────────────
 * 1. **LLM 호출 0.** 전부 fetch·parse·정규식이다.
 * 2. **하나가 실패해도 전체는 계속한다.** safely()가 개별 실패를 흡수하므로
 *    Jira 토큰이 만료돼도 나머지 3개는 수집된다 — 아침 브리핑이 통째로
 *    안 뜨는 것이 가장 나쁜 실패 모드이기 때문.
 * 3. **병렬 실행.** 서로 의존이 없고, gh CLI가 가장 느리다(로그 수 MB).
 */
export async function collectAll(): Promise<CollectorResult[]> {
  const results = await Promise.all([
    collectApiTest(),
    collectJira(),
    collectDatadog(),
    collectWebE2e(),
    collectStagePr(),
  ]);

  // 수집기별 마지막 실행 시각·상태 기록 (우측 패널이 읽는다)
  for (const r of results) {
    setMeta(`collector:${r.name}:at`, nowIso());
    setMeta(`collector:${r.name}:ok`, r.ok ? '1' : '0');
    setMeta(`collector:${r.name}:detail`, r.ok ? r.detail : (r.error ?? '실패'));
  }
  setMeta('collect:last_run', nowIso());

  return results;
}
