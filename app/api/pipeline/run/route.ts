import { NextRequest } from 'next/server';
import { runClaude } from '@/lib/claudeRunner';
import type { AgentMode } from '@/types/session';

// ─── 시스템 프롬프트 (chat/route.ts와 동일 BASE_CONTEXT 인라인 적용) ──────────

const ATLASSIAN_CLOUD_ID = process.env.CONFLUENCE_BASE_URL
  ? new URL(process.env.CONFLUENCE_BASE_URL).hostname
  : null;

const BASE_CONTEXT = `모든 응답은 한국어로 작성합니다.${
  ATLASSIAN_CLOUD_ID
    ? `\n\n## Atlassian 설정\n- cloudId: ${ATLASSIAN_CLOUD_ID}\n- MCP Atlassian 도구 호출 시 cloudId는 항상 "${ATLASSIAN_CLOUD_ID}"를 사용합니다.`
    : ''
}`;

const TC_FORMAT = `## TC 출력 형식 (마크다운 테이블 11컬럼)
| TC-ID | 대분류 | 중분류 | 소분류 | 검증단계 | 전제조건 | 테스트 스텝 | 기대결과 | 플랫폼 | 결과 | 비고 |
|-------|--------|--------|--------|---------|---------|-----------|---------|-------|------|------|
- 검증단계: 정상 / 부정 / 예외 / 부정+예외 합계 49~60% 목표
- 플랫폼: PC(Web) / Mobile(App) / 공통
- 결과: Not Test (기본값)`;

const SYSTEM_PROMPTS: Record<AgentMode, string> = {
  designer: `당신은 TC 설계 전문 에이전트입니다.\n${BASE_CONTEXT}\n\n기획서를 분석하여 대/중/소분류 구조, 리스크 레벨, 커버리지 매핑표, 검증단계 권장 배분을 제공합니다.`,
  writer: `당신은 TC 작성 전문 에이전트입니다.\n${BASE_CONTEXT}\n\n${TC_FORMAT}\n\nTC 품질 규칙: 1TC=1검증포인트, 추상 표현 금지, 테스트 스텝 3요소([사전상태]→[행동]→[결과]), 경계값 수치 필수.`,
  reviewer: `당신은 QA 리뷰 전문 에이전트입니다.\n${BASE_CONTEXT}\n\nEVAL-01~13 기준으로 TC를 검토하고 CRITICAL/HIGH/MEDIUM/LOW 이슈를 도출하여 리뷰 보고서를 작성합니다.`,
  fixer: `당신은 TC 수정 전문 에이전트입니다.\n${BASE_CONTEXT}\n\n${TC_FORMAT}\n\n리뷰 이슈를 CRITICAL→HIGH→MEDIUM 순으로 반영하고 수정된 TC 전체를 11컬럼 형식으로 최종 출력합니다.`,
  general: `당신은 QA 전문 에이전트입니다.\n${BASE_CONTEXT}`,
};

// ─── 단계 정의 ────────────────────────────────────────────────────────────────

interface StageConfig {
  mode: AgentMode;
  label: string;
  emoji: string;
  buildMessage: (confluenceUrl: string) => string;
}

const STAGE_CONFIGS: StageConfig[] = [
  {
    mode: 'designer',
    label: 'TC 설계',
    emoji: '📐',
    buildMessage: (url) =>
      `다음 Confluence 페이지를 분석하여 TC 설계 구조를 제안해주세요.\n\n${url}\n\n대/중/소분류 구조, 리스크 레벨, 커버리지 매핑표, 검증단계 권장 배분을 제공해주세요.`,
  },
  {
    mode: 'writer',
    label: 'TC 작성',
    emoji: '✏️',
    buildMessage: () =>
      `앞서 설계한 구조를 바탕으로 11컬럼 형식(TC-ID, 대분류, 중분류, 소분류, 검증단계, 전제조건, 테스트 스텝, 기대결과, 플랫폼, 결과, 비고)으로 TC를 생성해주세요.\n검증단계 부정+예외 합계 49~60%를 목표로 작성해주세요.`,
  },
  {
    mode: 'reviewer',
    label: 'QA 리뷰',
    emoji: '🔍',
    buildMessage: () =>
      `생성된 TC를 EVAL 기준으로 검토해주세요. 검증단계 분포, 추상적 표현 여부, 1TC=1검증포인트 준수를 중심으로 이슈를 도출하고 리뷰 보고서를 작성해주세요.`,
  },
  {
    mode: 'fixer',
    label: 'TC 수정',
    emoji: '🔧',
    buildMessage: () =>
      `리뷰에서 발견된 이슈를 반영하여 TC를 수정해주세요. CRITICAL → HIGH → MEDIUM 순으로 처리하고, 수정된 TC 전체를 11컬럼 형식으로 최종 출력해주세요.`,
  },
];

// ─── SSE 이벤트 타입 ──────────────────────────────────────────────────────────

export type PipelineEvent =
  | { type: 'start'; totalStages: number }
  | { type: 'stage_start'; stageIndex: number; stage: AgentMode; label: string; emoji: string }
  | { type: 'chunk'; content: string }
  | { type: 'tool'; label: string }
  | { type: 'stage_done'; stageIndex: number; stage: AgentMode; content: string; userMessage: string; claudeSessionId: string | null }
  | { type: 'done' }
  | { type: 'error'; message: string };

// ─── API 핸들러 ───────────────────────────────────────────────────────────────

interface PipelineRequestBody {
  confluenceUrl: string;
  claudeSessionId?: string;
}

export async function POST(req: NextRequest) {
  const body: PipelineRequestBody = await req.json();
  const { confluenceUrl, claudeSessionId: initialSessionId } = body;

  if (!confluenceUrl?.trim()) {
    return new Response(JSON.stringify({ error: 'confluenceUrl이 필요합니다.' }), { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: PipelineEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // 클라이언트 연결 끊김 무시
        }
      };

      let currentSessionId: string | null = initialSessionId ?? null;

      send({ type: 'start', totalStages: STAGE_CONFIGS.length });

      for (let i = 0; i < STAGE_CONFIGS.length; i++) {
        const stage = STAGE_CONFIGS[i];
        const userMessage = stage.buildMessage(confluenceUrl);

        send({
          type: 'stage_start',
          stageIndex: i,
          stage: stage.mode,
          label: stage.label,
          emoji: stage.emoji,
        });

        try {
          const result = await runClaude({
            message: userMessage,
            systemPrompt: SYSTEM_PROMPTS[stage.mode],
            claudeSessionId: currentSessionId,
            onChunk: (chunk) => send({ type: 'chunk', content: chunk }),
            onTool: (label) => send({ type: 'tool', label }),
          });

          currentSessionId = result.claudeSessionId;

          send({
            type: 'stage_done',
            stageIndex: i,
            stage: stage.mode,
            content: result.content,
            userMessage,
            claudeSessionId: currentSessionId,
          });
        } catch (err) {
          send({
            type: 'error',
            message: err instanceof Error ? err.message : '파이프라인 오류가 발생했습니다.',
          });
          controller.close();
          return;
        }
      }

      send({ type: 'done' });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
