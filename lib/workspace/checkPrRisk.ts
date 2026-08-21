/**
 * PR ↔ 리스크 패턴 수동 대조 (2026-08-21) — DESIGN ⑤의 수동 버전.
 * ────────────────────────────────────────────────────────────────────────
 * confirmed 리스크 패턴("이 제품이 반복적으로 틀리는 가정")과 PR diff를 대조해,
 * 확정 결함이 아니라 **"확인이 필요한 질문"**을 근거와 함께 만든다.
 *
 * 왜 수동 트리거인가: 시안이 열어둔 질문("diff 붙여넣기 vs 자동 대조")을
 * 토큰 규칙 1("매일 자동으로 도는 층에 LLM 금지")이 정한다 — 대조는 LLM이
 * 필요하므로 자동 수집층에 못 넣는다. 대신 stage-pr 수집기가 이미 모은
 * 병합 PR을 후보로 프리필해 클릭 한 번으로 잇는다.
 *
 * 거짓양성 스팸이 이 기능의 최대 리스크(DESIGN §9) — 3중 억제:
 *   ① 프롬프트: diff에서 구체 근거(파일·변경 내용)를 못 대면 내지 마라
 *   ② 서버 검증: pattern ref가 confirmed 실물이 아니거나 evidence가 비면 버린다
 *   ③ 사람 verdict: 수용/기각이 수용률 지표로 환류 (발견 수는 지표가 아니다)
 *
 * 읽기 전용: 서비스 레포는 `gh pr view/diff` 조회만. 토큰: 온디맨드(버튼) 1회.
 * 층: 🔵 코어(패턴 대조 추론) + 🟡 어댑터(gh diff 조회 · WEMEETPLACE 한정).
 */
import { listRiskPatterns, upsertRiskCheck, type RiskFinding } from '@/lib/workspace/repo';
import { run } from '@/lib/workspace/collectors/shared';
import { runClaude } from '@/lib/claudeRunner';

/** 조회 허용 조직 — 임의 레포 조회를 막는다 (수동 입력도 이 안에서만) */
const ALLOWED_ORG = 'WEMEETPLACE';

/** diff 프롬프트 예산 — 초과분은 자르고 결과에 명시한다 (조용한 절단 금지) */
const DIFF_BUDGET_CHARS = 60_000;

const SYSTEM = `당신은 QA 리스크 대조자입니다. 이 제품에서 반복 확인된 리스크 패턴 목록과
새 PR의 diff를 받아, **이 diff가 어느 패턴의 영역을 실제로 건드리는지**만 찾습니다.
확정 결함 선언이 아니라 "확인이 필요한 질문"을 만드는 일입니다.
철칙: diff 안의 구체 근거(파일·변경 내용) 없이 패턴을 매칭하지 마십시오.
범용 지적("동시성 확인하세요" 류)은 금지 — 주어진 패턴에 근거해서만 말합니다.`;

interface ConfirmedPattern {
  ref: string;
  title: string;
  severity: string | null;
  rootAssumption: string | null;
  symptom: string | null;
  questions: string[];
}

function buildPrompt(patterns: ConfirmedPattern[], pr: { title: string; body: string; diff: string; truncated: boolean }): string {
  const patternBlock = patterns
    .map((p) =>
      [
        `### ${p.ref} — ${p.title}${p.severity ? ` (${p.severity})` : ''}`,
        p.rootAssumption ? `잘못된 가정: ${p.rootAssumption}` : '',
        p.symptom ? `증상: ${p.symptom}` : '',
        p.questions.length ? `기본 대조 질문: ${p.questions.join(' / ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');

  return [
    '[확정 리스크 패턴]',
    patternBlock,
    '',
    '[PR]',
    `제목: ${pr.title}`,
    pr.body ? `설명: ${pr.body.slice(0, 2000)}` : '',
    '',
    '[diff]' + (pr.truncated ? ' (길이 초과로 앞부분만 — 근거는 이 범위 안에서만 대라)' : ''),
    '```diff',
    pr.diff,
    '```',
    '',
    '[할 일]',
    '- 각 패턴에 대해: 이 diff가 그 패턴이 반복되던 영역·방식을 실제로 건드리는가?',
    '- 건드린다고 판단되면, diff 안의 **구체 근거**(파일 경로 + 어떤 변경이 왜 그 패턴 영역인지)를 대세요.',
    '- 근거를 못 대는 패턴은 내지 마세요. 매칭이 하나도 없으면 빈 배열이 정답입니다.',
    '- questions는 기본 대조 질문을 이 PR의 실제 변경에 맞춰 구체화하세요 (엔드포인트·필드명 등).',
    '',
    '[출력 — JSON 배열만. 코드펜스·설명 없이]',
    '[{',
    '  "pattern": "RP-001",',
    '  "evidence": "src/.../order.ts에 신규 POST 핸들러 추가 — body 필드를 검증 없이 바로 쿼리에 사용",',
    '  "questions": ["이 PR에 맞춘 확인 질문", "..."]',
    '}]',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function parseFindings(content: string): Array<{ pattern?: string; evidence?: string; questions?: unknown }> {
  const s = content.indexOf('[');
  const e = content.lastIndexOf(']');
  if (s < 0 || e <= s) return [];
  try {
    const arr = JSON.parse(content.slice(s, e + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export interface CheckPrResult {
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  findings: RiskFinding[];
  patternsChecked: number;
  skipped: number; // 근거 없음·미확정 ref로 버린 수 (거짓양성 억제 ②)
  diffTruncated: boolean;
}

/** confirmed 패턴 × PR diff 대조 — LLM 1회, 결과는 risk_check에 저장 */
export async function checkPrRisk(repo: string, prNumber: number): Promise<CheckPrResult> {
  if (!repo.startsWith(`${ALLOWED_ORG}/`) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`${ALLOWED_ORG} 조직 레포만 대조할 수 있습니다 (받은 값: ${repo})`);
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error(`PR 번호가 올바르지 않습니다: ${prNumber}`);

  const confirmed: ConfirmedPattern[] = listRiskPatterns()
    .filter((p) => p.status === 'confirmed' && p.ref)
    .map((p) => ({
      ref: p.ref!,
      title: p.title,
      severity: p.severity,
      rootAssumption: p.root_assumption,
      symptom: p.symptom,
      questions: (() => {
        try {
          return p.check_questions ? ((JSON.parse(p.check_questions) as unknown[]).map(String)) : [];
        } catch {
          return [];
        }
      })(),
    }));
  if (confirmed.length === 0) {
    throw new Error('confirmed 패턴이 없습니다 — 후보 큐에서 먼저 확정하세요 (대조는 확정 패턴에만 근거합니다)');
  }

  // 읽기 전용 조회 — PR 메타 + diff
  const metaRaw = await run('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'title,body,url'], { timeoutMs: 30_000 });
  const meta = JSON.parse(metaRaw) as { title: string; body: string | null; url: string };
  const diffRaw = await run('gh', ['pr', 'diff', String(prNumber), '--repo', repo], { timeoutMs: 60_000 });
  const diffTruncated = diffRaw.length > DIFF_BUDGET_CHARS;
  const diff = diffTruncated ? diffRaw.slice(0, DIFF_BUDGET_CHARS) : diffRaw;

  const { content } = await runClaude({
    message: buildPrompt(confirmed, { title: meta.title, body: meta.body ?? '', diff, truncated: diffTruncated }),
    systemPrompt: SYSTEM,
    disableMcp: true,
    model: 'sonnet',
  });

  const sevOf = new Map(confirmed.map((p) => [p.ref, p.severity]));
  const findings: RiskFinding[] = [];
  let skipped = 0;
  for (const raw of parseFindings(content)) {
    const ref = (raw.pattern ?? '').trim();
    const evidence = (raw.evidence ?? '').trim();
    // 억제 ②: confirmed 실물 ref + 근거 필수. 아니면 버린다 (증거 없으면 카드 없음)
    if (!sevOf.has(ref) || !evidence) {
      skipped++;
      continue;
    }
    findings.push({
      pattern: ref,
      severity: sevOf.get(ref) ?? null,
      evidence,
      questions: Array.isArray(raw.questions) ? (raw.questions as unknown[]).map(String).filter(Boolean) : [],
      verdict: null,
    });
  }

  upsertRiskCheck({
    repo,
    prNumber,
    prTitle: meta.title,
    prUrl: meta.url,
    findings,
    patternsChecked: confirmed.length,
  });

  return {
    repo,
    prNumber,
    prTitle: meta.title,
    prUrl: meta.url,
    findings,
    patternsChecked: confirmed.length,
    skipped,
    diffTruncated,
  };
}
