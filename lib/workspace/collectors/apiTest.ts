import { makeFingerprint } from '../fingerprint';
import {
  markResolvedExcept,
  removeSignal,
  upsertFinding,
  upsertSignal,
  upsertTestRun,
} from '../repo';
import type { FindingKind } from '../types';
import { run, safely, stripAnsi, stripGhLogPrefix, type CollectorResult } from './shared';

/**
 * API 자동화 수집기 (roouty-api-test → WEMEETPLACE/api-automation).
 *
 * ── 왜 gh CLI 인가 ────────────────────────────────────────────────────
 * 정기 실행은 GitHub Actions에서 돌고 로컬에는 결과가 없다.
 * 워크플로가 artifact를 업로드하지 않으므로, `summarize.mjs`가 stdout에 찍은
 * 리포트를 실행 로그에서 파싱한다.
 * (나중에 워크플로에 upload-artifact를 추가하면 이 파서는 폴백으로 남긴다)
 *
 * ── 파싱 대상 형식 (summarize.mjs 출력) ───────────────────────────────
 *   🔴 *Roouty API 자동화 리포트* — `stage` | 2026-08-07 00:49 (KST 기준 실행)
 *   ✅ 136 통과 · ❌ 17 실패 · ⏭ 38 스킵 — 총 191개, 155.7s
 *
 *   *실패 상세* (계약 매핑):
 *   • `POST /manual/route` — 수동 배차 생성 — POST /manual/route → routeId
 *      ↳ [검증 실패] Error: ...  _(manual-dispatch.spec.ts)_
 */

const REPO = process.env.API_AUTOMATION_REPO ?? 'WEMEETPLACE/api-automation';

/** 감시할 워크플로 → 러너 스위트 이름 */
const WORKFLOWS: Record<string, string> = {
  'stage-regression': 'stage-regression',
  'prod-smoke': 'prod-smoke',
};

interface GhRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  createdAt: string;
  url: string;
}

export interface ParsedReport {
  env: string;
  startedAt: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationSec: number;
  failures: Array<{
    contractKey: string | null;
    title: string;
    classify: string;
    error: string;
    file: string;
  }>;
  /** 상위 10건만 로그에 찍히므로 잘린 개수 */
  truncated: number;
}

/**
 * summarize.mjs 리포트 블록 파싱.
 * 로그 접두부와 ANSI를 벗긴 "본문 줄 배열"을 받는다.
 */
export function parseReport(lines: string[]): ParsedReport | null {
  const head = lines.find((l) => l.includes('Roouty API 자동화 리포트'));
  const stat = lines.find((l) => /통과 ·/.test(l) && /실패/.test(l));
  if (!head || !stat) return null;

  const env = head.match(/`([^`]+)`/)?.[1] ?? 'stage';
  const startedAt = head.match(/\|\s*([\d-]{10}\s[\d:]{5})/)?.[1] ?? '';

  const num = (re: RegExp) => Number(stat.match(re)?.[1] ?? 0);
  const passed = num(/✅\s*(\d+)/);
  const failed = num(/❌\s*(\d+)/);
  const skipped = num(/⏭\s*(\d+)/);
  const total = num(/총\s*(\d+)개/);
  const durationSec = Number(stat.match(/,\s*([\d.]+)s/)?.[1] ?? 0);

  const failures: ParsedReport['failures'] = [];
  let truncated = 0;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // "…외 7건"
    const more = l.match(/…외\s*(\d+)건/);
    if (more) {
      truncated = Number(more[1]);
      continue;
    }

    // "• `계약키` — 제목"  또는  "• (계약 미매핑) — 제목"
    const m = l.match(/^•\s*(?:`([^`]+)`|\(계약 미매핑\))\s*—\s*(.+)$/);
    if (!m) continue;

    const contractKey = m[1] ?? null;
    const title = m[2].trim();

    // 다음 줄이 상세: "   ↳ [분류] 에러  _(파일)_"
    const next = lines[i + 1] ?? '';
    const d = next.match(/↳\s*\[([^\]]+)\]\s*(.*?)\s*_\(([^)]+)\)_\s*$/);

    failures.push({
      contractKey,
      title,
      classify: d?.[1]?.trim() ?? '미분류',
      error: (d?.[2] ?? '').trim(),
      file: d?.[3]?.trim() ?? '',
    });
  }

  return { env, startedAt, passed, failed, skipped, total, durationSec, failures, truncated };
}

/**
 * 실패를 6종 분류로 매핑 — **규칙만 사용한다 (LLM 0)**.
 *
 * 실제 관측(2026-08-07)에서 다수를 차지한 "[전제 실패] 차량 0대"는
 * 제품 버그가 아니라 **우리 환경의 리소스 누수**다 (2026-07-28 사고와 같은 유형).
 * 이것을 bug-candidate로 올리면 매일 가짜 버그가 쌓이므로 unstable로 분류하고,
 * 별도로 환경 건강도 신호를 띄운다.
 */
export function classifyFailure(f: ParsedReport['failures'][number]): {
  kind: FindingKind;
  envBlocked: boolean;
} {
  const text = `${f.classify} ${f.error}`;

  // 환경 전제 실패 — 차량 풀 고갈 · 잔존 경로 점유
  if (/\[전제 실패\]|차량\s*0대|processing 경로에 점유/.test(text)) {
    return { kind: 'unstable', envBlocked: true };
  }
  // 계약 드리프트 — 필수 필드 추가/변경으로 400
  if (/드리프트|필수|required|erroredKey/i.test(text)) {
    return { kind: 'contract-drift', envBlocked: false };
  }
  // 제품 결함 후보 — 400이어야 하는데 500
  if (/\b500\b/.test(text) && !/\b400\b/.test(f.title)) {
    return { kind: 'bug-candidate', envBlocked: false };
  }
  // 재시도로 통과하는 것
  if (/flaky|timeout|타임아웃/i.test(text)) {
    return { kind: 'unstable', envBlocked: false };
  }
  return { kind: 'bug-candidate', envBlocked: false };
}

/** 최근 실행 목록 조회 */
async function listRuns(limit: number): Promise<GhRun[]> {
  const out = await run('gh', [
    'run', 'list',
    '--repo', REPO,
    '--limit', String(limit),
    '--json', 'databaseId,name,status,conclusion,createdAt,url',
  ]);
  return JSON.parse(out) as GhRun[];
}

/** 실행 로그에서 리포트 블록만 뽑아 파싱 */
async function fetchReport(runId: number): Promise<ParsedReport | null> {
  let raw: string;
  try {
    raw = await run('gh', ['run', 'view', String(runId), '--repo', REPO, '--log'], {
      timeoutMs: 120_000,
    });
  } catch {
    // 로그가 만료됐거나 접근 불가 — 메타만으로 진행
    return null;
  }
  const lines = raw
    .split('\n')
    .map((l) => stripAnsi(stripGhLogPrefix(l)).trimEnd())
    .filter((l) => l.length > 0);
  return parseReport(lines);
}

/**
 * 수집 실행.
 * 워크플로별 최신 1건씩만 본다 — 아침 브리핑은 "어젯밤 결과"만 필요하다.
 */
export async function collectApiTest(): Promise<CollectorResult> {
  return safely('api-test', async () => {
    const runs = await listRuns(20);
    const seenFingerprints: string[] = [];
    let handled = 0;
    let failedTotal = 0;
    let envBlockedTotal = 0;

    for (const [wf, suite] of Object.entries(WORKFLOWS)) {
      // 환경 전제 실패는 **워크플로별로** 센다.
      // (루프 밖에 두면 stage에서 누적된 값 때문에 prod-smoke에도 경고가 뜬다)
      let envBlocked = 0;
      const latest = runs.find((r) => r.name === wf && r.status === 'completed');
      if (!latest) continue;

      const report = await fetchReport(latest.databaseId);
      const status =
        latest.conclusion === 'success'
          ? 'success'
          : latest.conclusion === 'cancelled'
            ? 'cancelled'
            : latest.conclusion === 'failure'
              ? 'failure'
              : 'unknown';

      const runId = upsertTestRun({
        runner: 'api',
        suite,
        externalId: String(latest.databaseId),
        status,
        total: report?.total ?? null,
        passed: report?.passed ?? null,
        failed: report?.failed ?? null,
        skipped: report?.skipped ?? null,
        startedAt: latest.createdAt,
        durationSec: report ? Math.round(report.durationSec) : null,
        url: latest.url,
      });

      // 실행 요약 신호
      const summary = report
        ? `${report.passed} 통과 · ${report.failed} 실패 · ${report.skipped} 스킵 (총 ${report.total})`
        : `결과 ${latest.conclusion}`;

      upsertSignal({
        source: 'api-test',
        kind: 'run',
        ref: `${suite}:${latest.databaseId}`,
        title: `${suite} — ${status === 'success' ? '전체 통과' : `${report?.failed ?? '?'}건 실패`}`,
        detail: summary,
        severity: status === 'success' ? 'ok' : (report?.failed ?? 0) > 0 ? 'warn' : 'info',
        url: latest.url,
        observedAt: latest.createdAt,
        payload: report ? { failures: report.failures.length, truncated: report.truncated } : null,
      });

      failedTotal += report?.failed ?? 0;
      handled++;

      // 실패 상세 → finding
      for (const f of report?.failures ?? []) {
        const { kind, envBlocked: isEnvBlocked } = classifyFailure(f);
        if (isEnvBlocked) envBlocked++;

        const fp = makeFingerprint({
          runner: 'api',
          nodeId: `${f.file}::${f.title}`,
          errorType: f.classify,
          message: f.error,
        });
        seenFingerprints.push(fp.fingerprint);

        upsertFinding({
          fingerprint: fp.fingerprint,
          runId,
          runner: 'api',
          nodeId: fp.nodeId,
          kind,
          verdictBy: 'rule', // 규칙만으로 판정 — LLM 미사용
          errorType: fp.errorType,
          messageNorm: fp.messageNorm,
          contractKey: f.contractKey,
          detail: f.error.slice(0, 500),
          observedAt: latest.createdAt,
        });
      }

      /**
       * 환경 전제 실패가 다수면 제품 문제가 아니라 우리 스테이지가 고장난 것.
       * 2026-07-28 리소스 누수 사고와 같은 유형이므로 별도 신호로 띄운다.
       */
      envBlockedTotal += envBlocked;
      const envRef = `env-blocked:${suite}`; // 스위트별 1건 — 실행이 바뀌어도 갱신만 된다

      if (envBlocked < 3) {
        // 해소됐으면 경고를 지운다.
        // UPSERT만 있으면 한 번 뜬 경고가 영원히 남는다 — 실제로 2026-08-07에
        // 차량 풀을 복구했는데도 "환경 건강도 위험"이 계속 떠 있었다.
        removeSignal('api-test', envRef);
      } else {
        upsertSignal({
          source: 'api-test',
          kind: 'env-health',
          ref: envRef,
          title: `환경 전제 실패 ${envBlocked}건 — 차량 풀 고갈 의심 (${suite})`,
          detail:
            '잔존 processing 경로가 기사를 점유해 최적화 대상 차량이 0대. ' +
            'scripts/env_health.py --fix 로 해제 필요 (2026-07-28 사고와 같은 유형)',
          severity: 'crit',
          url: latest.url,
          observedAt: latest.createdAt,
        });
      }
    }

    // 이번에 안 나온 실패는 해결된 것으로 표시
    if (seenFingerprints.length > 0) markResolvedExcept('api', seenFingerprints);

    return {
      detail:
        handled === 0
          ? '최근 완료된 실행 없음'
          : `실행 ${handled}건 · 실패 ${failedTotal}건${envBlockedTotal ? ` (환경 전제 실패 ${envBlockedTotal})` : ''}`,
      count: handled,
    };
  });
}
