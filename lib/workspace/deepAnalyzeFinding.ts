/**
 * 자동화 실패 심층 분석 (2026-08-21) — 버그 티켓 근거 만들기.
 * ────────────────────────────────────────────────────────────────────────
 * 1번 "실패 일괄 분석"은 도구 없이(저비용) 분류만 한다 → 원인(코드) 미확정.
 * 하지만 버그 티켓을 등록하려면 **어느 화면/케이스에서 왜 깨졌는지**를 실제로 파악해야 한다.
 * 이 모듈은 에이전트에게 **테스트 소스 + 제품 repo를 read-only로 읽혀** 근본 원인까지
 * 분석하게 하고, DV-647 형식 BugSections를 만든다.
 *
 * 토큰: 버그 등록 시점에만(온디맨드) 도는 무거운 호출이다. 매일 도는 경로가 아니다.
 * MCP는 끄되(Atlassian 불필요) Bash·Read·gh 같은 내장 도구로 repo를 읽는다.
 *
 * 층: 🔵 분석 파이프라인(코어) + 🟡 repo 위치(env). 도메인 용어는 넣지 않는다.
 */
import os from 'node:os';
import path from 'node:path';
import { runClaude } from '@/lib/claudeRunner';
import type { FindingRow } from '@/lib/workspace/types';
import type { BugSections, Confidence } from '@/lib/workspace/bugTemplate';

/** 웹 E2E 테스트 소스(pytest) — 로컬 체크아웃 */
const E2E_SOURCE_DIR = process.env.E2E_SOURCE_DIR ?? path.join(os.homedir(), 'Projects', 'roouty-test-automation');
/** API 테스트 소스 — 원격 repo (gh로 읽는다) */
const API_TEST_REPO = process.env.API_AUTOMATION_REPO ?? 'WEMEETPLACE/api-automation';
const BACKEND = process.env.GITHUB_REPO_BACKEND ?? null;
const FRONTEND = process.env.GITHUB_REPO_FRONTEND ?? null;

const SYSTEM = `당신은 자동화 테스트 실패를 분석해 **버그 티켓 근거**를 만드는 QA 분석 전문가입니다.
"테스트 X 실패" 수준이 아니라, 어느 화면·기능의 어떤 케이스가 왜 깨졌는지를 소스로 규명합니다.
전부 read-only입니다 — clone·push·파일 수정 절대 금지. 모르는 것을 아는 척하지 마세요.`;

function buildPrompt(f: FindingRow): string {
  const node = f.node_id ?? f.contract_key ?? `finding-${f.id}`;
  const testName = (node.split('::').pop() ?? node).replace(/\[.*$/, '').trim();
  const isApi = f.runner === 'api';
  const sourceHint = isApi
    ? [
        `   - API 테스트 소스는 원격 repo **${API_TEST_REPO}** 에 있습니다. gh로 read-only 조회:`,
        `     \`gh search code "${testName}" --repo ${API_TEST_REPO}\` 또는 \`gh api repos/${API_TEST_REPO}/contents/경로\`.`,
      ]
    : [
        `   - 웹 E2E 테스트 소스는 로컬 **${E2E_SOURCE_DIR}** 에 있습니다.`,
        `     \`grep -rn "${testName}" ${E2E_SOURCE_DIR}\` 로 파일을 찾고, 테스트 함수·페이지 오브젝트/셀렉터/스텝을 Read로 확인.`,
      ];
  return [
    '[실패한 자동화 테스트]',
    `- node: ${node}`,
    `- 러너: ${f.runner ?? '-'}`,
    `- 에러:\n${(f.detail ?? '(없음)').slice(0, 1200)}`,
    '',
    '[분석 절차 — 전부 read-only]',
    `1. 테스트 소스를 읽어 이 테스트가 **무슨 화면·기능·어떤 케이스**를 검증하는지 파악하세요.`,
    ...sourceHint,
    '2. 에러 메시지를 소스와 대조해 **무슨 단언이 왜 실패**했는지, **어떤 전제/케이스**에서 발생했는지 파악하세요.',
    '3. 제품 repo를 gh로 read-only 확인해 **근본 원인**을 찾으세요 — 어디서 깨지는지 `파일:라인`.',
    FRONTEND ? `   - 프론트: ${FRONTEND}` : '',
    BACKEND ? `   - 백엔드: ${BACKEND}` : '',
    `   - gh 예: \`gh search code "키워드" --repo ${FRONTEND ?? BACKEND ?? 'OWNER/REPO'}\`, \`gh api repos/OWNER/REPO/contents/경로\`.`,
    '   - 코드로 원인을 특정 못 하면 rootCause에 "미확정"이라 정직하게 쓰세요.',
    '',
    '[출력 — 오직 JSON 객체 하나. 코드펜스·설명 없이]',
    '{',
    '  "summary": "[화면/기능] 사람이 읽는 실제 증상 한 줄 (테스트 이름 금지)",',
    '  "context": "어떤 화면/기능의 어떤 케이스인지 1~2줄",',
    '  "reproduction": ["최소 재현 스텝", "..."],',
    '  "actual": "실제 결과(증상/에러)",',
    '  "expected": "기대 결과",',
    '  "rootCause": "원인 `파일:라인` + 설명 (미확정이면 그렇게)",',
    '  "impact": "영향 — 누가/어디서 겪는가, 발생 가능성",',
    '  "fixProposal": "수정 방향(제안)",',
    '  "confidence": "confirmed | probable | api-only"',
    '}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface DeepResult {
  summary: string;
  sections: BugSections;
}

function parse(content: string): DeepResult | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
    const conf = str(j.confidence);
    const summary = str(j.summary);
    if (!summary) return null;
    return {
      summary: summary.slice(0, 200),
      sections: {
        context: str(j.context),
        reproduction: Array.isArray(j.reproduction) ? (j.reproduction as unknown[]).map(String) : undefined,
        actual: str(j.actual),
        expected: str(j.expected),
        rootCause: str(j.rootCause),
        impact: str(j.impact),
        fixProposal: str(j.fixProposal),
        confidence: (['confirmed', 'probable', 'api-only'] as const).includes(conf as Confidence)
          ? (conf as Confidence)
          : undefined,
      },
    };
  } catch {
    return null;
  }
}

/** 실패 1건을 소스까지 읽어 심층 분석 → 버그 섹션. result=null이면 호출부가 얕은 초안으로 폴백. */
export async function deepAnalyzeFinding(f: FindingRow): Promise<{ result: DeepResult | null; raw: string }> {
  const { content } = await runClaude({
    message: buildPrompt(f),
    systemPrompt: SYSTEM,
    disableMcp: true, // MCP 불필요 — Bash/Read/gh 내장 도구로 repo를 읽는다
    model: 'sonnet',
  });
  return { result: parse(content), raw: content };
}
