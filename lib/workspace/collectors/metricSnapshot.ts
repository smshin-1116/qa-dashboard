import { buildMetricSnapshot, upsertMetricSnapshot } from '../repo';
import { buildToday } from '../todo';
import { todayKst } from '../db';
import { safely, type CollectorResult } from './shared';

/**
 * 일일 지표 스냅샷 — "추이"의 유일한 원본.
 *
 * ── 왜 필요한가 (2026-08-26) ──────────────────────────────────────────
 * 다른 저장은 전부 UPSERT(멱등)라 오늘 값이 어제 값을 덮어쓴다. 수집 안정성엔
 * 옳지만 부작용으로 이력이 증발한다 — "정체가 줄었나 · 수용률이 오르나 · 통과율
 * 추이"를 그릴 원본이 없다. 지표는 소급이 안 되므로(8/26의 상태는 8/26에만 잡힌다)
 * 하루 1행을 여기서 박제한다.
 *
 * ── 순서 제약 ─────────────────────────────────────────────────────────
 * 다른 수집기들이 오늘 데이터를 다 쓴 **뒤에** 돌아야 한다 (index.ts에서 후순위 실행).
 * 병렬 묶음에 넣으면 어제 값이 찍힌 스냅샷이 생긴다.
 *
 * ── 토큰 ──────────────────────────────────────────────────────────────
 * LLM 0 · 외부 호출 0. 전부 로컬 SQLite 집계다.
 */
export async function collectMetricSnapshot(): Promise<CollectorResult> {
  return safely('metric', async () => {
    const day = todayKst();
    // 아침 수집 스크립트는 todo를 산출하지 않는다(대시보드 API에서만) —
    // 그대로 찍으면 스냅샷의 todo가 항상 0이다. 산출은 멱등이므로 여기서 보장한다.
    buildToday(day);
    const m = buildMetricSnapshot(day);
    upsertMetricSnapshot(m);
    return {
      detail:
        `${day} 박제 — todo ${m.todoTotal}(이월 ${m.todoCarry}) · QA중 ${m.qaTickets}(최장 D+${m.qaStallMax})` +
        ` · 열린 finding ${m.findingsOpen} · 패턴 ${m.riskConfirmed}+${m.riskCandidate} · 판정 ${m.riskAccepted + m.riskRejected}`,
      count: 1,
    };
  });
}
