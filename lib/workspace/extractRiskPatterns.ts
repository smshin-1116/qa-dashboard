/**
 * 리스크 패턴 추출 엔진 (2026-08-21) — 리스크 탭 "패턴 추출".
 * ────────────────────────────────────────────────────────────────────────
 * 과거 버그 티켓(이력)을 LLM으로 훑어, 개별 버그가 아니라 **이 제품이 반복적으로 틀리는
 * 가정/방식**을 클러스터링해 candidate 리스크 패턴으로 제안한다(사람이 확정).
 *
 * 철칙(DESIGN.md): **증거 없으면 카드 없음.** 서로 다른 버그 2건 이상이 같은 근본 가정을
 * 공유할 때만 후보로 올린다(확정 기준 2건). 1건짜리 추측은 만들지 않는다.
 *
 * 토큰: 온디맨드(버튼) 1회. 티켓 요약을 프롬프트에 주입하므로 도구 없이(저비용) 돈다.
 * 층: 🔵 코어(도메인 무관 클러스터링) + 🟡 데이터(Jira 버그). 도메인 용어를 넣지 않는다.
 */
import { bugTicketsForExtract, insertRiskPattern, listRiskPatterns } from '@/lib/workspace/repo';
import { runClaude } from '@/lib/claudeRunner';

const MIN_EVIDENCE = 2; // 확정 기준: 서로 다른 버그 2건 이상 (2026-08-21 사용자 결정)

const SYSTEM = `당신은 QA 리스크 분석가입니다. 과거 버그 티켓 목록을 받아, 개별 버그가 아니라
**이 제품이 반복적으로 틀리는 가정·방식(리스크 패턴)** 을 찾아냅니다.
추측 금지 — 서로 다른 티켓이 같은 근본 가정을 실제로 공유할 때만 패턴으로 묶습니다.`;

function buildPrompt(bugs: Array<{ key: string; summary: string | null }>, existing: string[]): string {
  const list = bugs.map((b) => `- ${b.key}: ${b.summary ?? ''}`).join('\n');
  return [
    '[과거 버그 티켓]',
    list,
    '',
    existing.length ? `[이미 있는 패턴 — 중복 제안 금지]\n${existing.join(' / ')}\n` : '',
    '[할 일]',
    `- 위 버그들을 훑어, **같은 근본 가정을 공유하는 것 ${MIN_EVIDENCE}건 이상**을 하나의 리스크 패턴으로 묶으세요.`,
    '- 개별 사건이 아니라 "반복되는 틀림 방식"입니다. 1건짜리·추측은 만들지 마세요.',
    '- 이미 있는 패턴과 겹치면 제안하지 마세요.',
    '',
    '[출력 — JSON 배열만. 코드펜스·설명 없이]',
    '[{',
    '  "title": "짧은 패턴 이름 (예: 옵션 필드를 non-null로 가정)",',
    '  "category": "재사용 결함 클래스 (예: null-assumption, idempotency, authz-guard, partial-update)",',
    '  "severity": "high | medium | low",',
    '  "symptom": "사용자에게 어떻게 나타나나",',
    '  "root_assumption": "반복되는 잘못된 가정 한 줄",',
    '  "evidence": ["DV-xxx", "DV-yyy"],   // 이 패턴을 뒷받침하는 티켓 키 2개 이상',
    '  "check_questions": ["PR에 물어볼 대조 질문", "..."]',
    '}]',
    `증거가 ${MIN_EVIDENCE}건 미만인 패턴은 빼세요. 없으면 빈 배열 [].`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

interface RawPattern {
  title?: string;
  category?: string;
  severity?: string;
  symptom?: string;
  root_assumption?: string;
  evidence?: unknown;
  check_questions?: unknown;
}

function parse(content: string): RawPattern[] {
  const s = content.indexOf('[');
  const e = content.lastIndexOf(']');
  if (s < 0 || e <= s) return [];
  try {
    const arr = JSON.parse(content.slice(s, e + 1));
    return Array.isArray(arr) ? (arr as RawPattern[]) : [];
  } catch {
    return [];
  }
}

export interface ExtractResult {
  proposed: number;
  skipped: number; // 증거 부족·중복으로 제외
  scanned: number;
}

/** 버그 이력을 LLM으로 훑어 candidate 리스크 패턴을 제안·저장한다. */
export async function extractRiskPatterns(): Promise<ExtractResult> {
  const bugs = bugTicketsForExtract(60);
  if (bugs.length === 0) return { proposed: 0, skipped: 0, scanned: 0 };

  const existing = listRiskPatterns().map((p) => p.title);
  const { content } = await runClaude({
    message: buildPrompt(bugs, existing),
    systemPrompt: SYSTEM,
    disableMcp: true,
    model: 'sonnet',
  });

  const raw = parse(content);
  const existingLower = new Set(existing.map((t) => t.toLowerCase().trim()));
  let proposed = 0;
  let skipped = 0;
  for (const p of raw) {
    const jira = Array.isArray(p.evidence) ? (p.evidence as unknown[]).map(String).filter((k) => /^DV-/.test(k)) : [];
    const title = (p.title ?? '').trim();
    // 증거 2건 미만·제목 없음·중복 → 제외 (증거 없으면 카드 없음)
    if (!title || jira.length < MIN_EVIDENCE || existingLower.has(title.toLowerCase())) {
      skipped++;
      continue;
    }
    insertRiskPattern({
      title,
      category: p.category ?? null,
      status: 'candidate',
      severity: p.severity ?? null,
      symptom: p.symptom ?? null,
      rootAssumption: p.root_assumption ?? null,
      evidence: { jira_bugs: jira, occurrences: jira.length },
      checkQuestions: Array.isArray(p.check_questions) ? (p.check_questions as unknown[]).map(String) : [],
    });
    existingLower.add(title.toLowerCase());
    proposed++;
  }
  return { proposed, skipped, scanned: bugs.length };
}
