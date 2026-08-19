import { NextRequest } from 'next/server';
import { runClaude } from '@/lib/claudeRunner';
import {
  createRecorder,
  isMockEnabled,
  isRecordEnabled,
  loadFixture,
  replayFixture,
} from '@/lib/pipelineFixture';
import type { AgentMode } from '@/types/session';
import type { PipelineEvent } from '@/types/pipeline';
// 프로파일 기반 명세 지시문 (기본 roouty → 동작 무변경, 골든 스냅샷 검증).
import { pipelineSpecDirective } from '@/lib/prompts/tcPrompts';

// ─── 시스템 프롬프트 (chat/route.ts와 동일 BASE_CONTEXT 인라인 적용) ──────────

const ATLASSIAN_CLOUD_ID = process.env.CONFLUENCE_BASE_URL
  ? new URL(process.env.CONFLUENCE_BASE_URL).hostname
  : null;

const ROOUTY_SPEC_DIRECTIVE = pipelineSpecDirective();

const BASE_CONTEXT = `모든 응답은 한국어로 작성합니다.`;

/**
 * 스펙 근거와 Atlassian 조회가 필요한 단계(설계·리뷰)에만 붙이는 컨텍스트.
 * TC 작성·수정 단계는 설계 결과와 리뷰 보고서만 따르면 되므로 제외합니다 —
 * 예전에는 4단계 전부가 roouty-spec 스킬을 로드하고 스펙 문서를 다시 읽었습니다.
 */
const SPEC_CONTEXT = `${BASE_CONTEXT}\n\n${ROOUTY_SPEC_DIRECTIVE}${
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

/**
 * CLI 세션 그룹.
 *
 * 예전에는 4단계를 각각 새 세션으로 띄웠습니다. CLI 호출 1회당 하네스 고정
 * 오버헤드가 실측 약 30k 토큰이라, 실작업 전에 이미 120k를 쓰고 있었습니다.
 * 이제 2개 세션으로 묶어 그 오버헤드를 1회씩만 냅니다(2턴째는 캐시 읽기).
 *
 * 왜 4단계를 1개 세션으로 합치지 않는가:
 * 리뷰어가 TC를 작성한 세션과 같으면 자기가 쓴 TC를 자기가 리뷰하게 되어
 * 무르게 봅니다. 리뷰 독립성은 절감보다 우선이므로 분리를 유지합니다.
 *
 * - analysis  : 설계 → 리뷰   (스펙 근거 필요, MCP로 Confluence 조회)
 * - authoring : 작성 → 수정   (외부 조회 불필요, MCP 없음)
 *
 * 실행 순서는 설계 → 작성 → 리뷰 → 수정로 그대로이며, 두 세션을 번갈아 씁니다.
 */
type SessionKey = 'analysis' | 'authoring';

/**
 * 세션 단위 시스템 프롬프트.
 *
 * 세션을 이어 쓸 때는 시스템 프롬프트가 바이트 단위로 동일해야 캐시가 유지됩니다.
 * 그래서 단계별로 다른 프롬프트를 주는 대신, 세션이 담당하는 두 역할을 함께
 * 기술해두고 실제 역할 전환은 각 턴의 사용자 메시지로 지시합니다.
 */
const SESSION_SYSTEM_PROMPTS: Record<SessionKey, string> = {
  analysis: `당신은 TC 설계와 QA 리뷰를 담당하는 에이전트입니다.\n${SPEC_CONTEXT}

## 담당 역할 (요청에 따라 전환)
1. **TC 설계**: 기획서를 분석하여 대/중/소분류 구조, 리스크 레벨, 커버리지 매핑표, 검증단계 권장 배분을 제공합니다.
2. **QA 리뷰**: EVAL-01~13 기준으로 TC를 검토하고 CRITICAL/HIGH/MEDIUM/LOW 이슈를 도출하여 리뷰 보고서를 작성합니다. 리뷰 시에는 앞서 본인이 설계한 구조와 대조해 누락된 커버리지도 함께 지적합니다.`,

  authoring: `당신은 TC 작성과 수정을 담당하는 에이전트입니다.\n${BASE_CONTEXT}\n\n${TC_FORMAT}

## 담당 역할 (요청에 따라 전환)
1. **TC 작성**: 전달받은 설계 구조를 바탕으로 11컬럼 형식 TC를 생성합니다.
2. **TC 수정**: 전달받은 리뷰 이슈를 CRITICAL→HIGH→MEDIUM 순으로 반영하고, 수정된 TC 전체를 11컬럼 형식으로 최종 출력합니다.

TC 품질 규칙: 1TC=1검증포인트, 추상 표현 금지, 테스트 스텝 3요소([사전상태]→[행동]→[결과]), 경계값 수치 필수.`,
};

// ─── 단계 정의 ────────────────────────────────────────────────────────────────

interface StageConfig {
  mode: AgentMode;
  label: string;
  emoji: string;
  /** 이 단계를 실행할 CLI 세션 그룹 */
  session: SessionKey;
  buildMessage: (confluenceUrl: string, outputs: string[]) => string;
}

const STAGE_CONFIGS: StageConfig[] = [
  {
    mode: 'designer',
    label: 'TC 설계',
    emoji: '📐',
    session: 'analysis',
    buildMessage: (url) =>
      `다음 Confluence 페이지를 분석하여 TC 설계 구조를 제안해주세요.\n\n${url}\n\n대/중/소분류 구조, 리스크 레벨, 커버리지 매핑표, 검증단계 권장 배분을 제공해주세요.`,
  },
  {
    mode: 'writer',
    label: 'TC 작성',
    emoji: '✏️',
    session: 'authoring',
    // 설계는 다른 세션(analysis)의 산출물이므로 본문으로 전달해야 합니다.
    buildMessage: (_url, outputs) =>
      `다음 TC 설계 구조를 바탕으로 11컬럼 형식(TC-ID, 대분류, 중분류, 소분류, 검증단계, 전제조건, 테스트 스텝, 기대결과, 플랫폼, 결과, 비고)으로 TC를 생성해주세요.\n검증단계 부정+예외 합계 49~60%를 목표로 작성해주세요.\n\n## TC 설계 구조\n${outputs[0]}`,
  },
  {
    mode: 'reviewer',
    label: 'QA 리뷰',
    emoji: '🔍',
    session: 'analysis',
    // TC는 다른 세션(authoring)의 산출물이라 전달이 필요합니다.
    // 설계 구조는 이 세션 컨텍스트에 이미 있으므로 다시 붙이지 않습니다.
    buildMessage: (_url, outputs) =>
      `이제 리뷰 역할로 전환해주세요. 다음 TC를 EVAL 기준으로 검토해주세요. 검증단계 분포, 추상적 표현 여부, 1TC=1검증포인트 준수를 중심으로 이슈를 도출하고, 앞서 본인이 설계한 구조와 대조해 누락된 커버리지도 지적하여 리뷰 보고서를 작성해주세요.\n\n## TC 목록\n${outputs[1]}`,
  },
  {
    mode: 'fixer',
    label: 'TC 수정',
    emoji: '🔧',
    session: 'authoring',
    // TC 전문은 이 세션이 직전 턴에 작성했으므로 재첨부하지 않습니다.
    // (기존 최대 낭비 지점 — TC 표가 리뷰 보고서보다 훨씬 큽니다.)
    buildMessage: (_url, outputs) =>
      `방금 작성한 TC에 대한 리뷰 결과입니다. 이 이슈를 반영하여 TC를 수정해주세요. CRITICAL → HIGH → MEDIUM 순으로 처리하고, 수정된 TC 전체를 11컬럼 형식으로 최종 출력해주세요.\n\n## 리뷰 보고서\n${outputs[2]}`,
  },
];

// ─── SSE 이벤트 타입 ──────────────────────────────────────────────────────────

// 실제 정의는 types/pipeline.ts. 재생(mock) 유틸이 같은 타입을 쓰면서
// route ↔ lib 순환 임포트가 생기지 않도록 분리했고, 기존 임포트 경로를
// 유지하기 위해 여기서 재수출합니다.
export type { PipelineEvent } from '@/types/pipeline';

// ─── API 핸들러 ───────────────────────────────────────────────────────────────

interface PipelineRequestBody {
  confluenceUrl: string;
}

export async function POST(req: NextRequest) {
  const body: PipelineRequestBody = await req.json();
  const { confluenceUrl } = body;

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

      // ── 재생 모드: CLI를 전혀 호출하지 않고 기록된 실행을 그대로 흘려보냅니다.
      //    화면·스트리밍·다운로드 확인용이므로 토큰 소모가 0입니다.
      if (isMockEnabled()) {
        const fixture = await loadFixture(confluenceUrl);
        if (!fixture) {
          send({
            type: 'error',
            message:
              'PIPELINE_MOCK=1이지만 재생할 fixture가 없습니다. PIPELINE_RECORD=1로 한 번 실제 실행해 fixtures/pipeline/에 기록하세요.',
          });
          controller.close();
          return;
        }
        await replayFixture(fixture, send, () => req.signal.aborted);
        controller.close();
        return;
      }

      // 기록 모드일 때만 send를 감싸 이벤트를 시간축과 함께 모읍니다.
      const recorder = isRecordEnabled() ? createRecorder(confluenceUrl) : null;
      const emit: (event: PipelineEvent) => void = recorder ? recorder.wrap(send) : send;

      const stageOutputs: string[] = [];
      // 세션 그룹별 CLI 세션 ID — 2턴째부터 --resume으로 이어붙입니다.
      const sessionIds: Record<SessionKey, string | null> = {
        analysis: null,
        authoring: null,
      };

      emit({ type: 'start', totalStages: STAGE_CONFIGS.length });

      for (let i = 0; i < STAGE_CONFIGS.length; i++) {
        const stage = STAGE_CONFIGS[i];
        const userMessage = stage.buildMessage(confluenceUrl, stageOutputs);

        emit({
          type: 'stage_start',
          stageIndex: i,
          stage: stage.mode,
          label: stage.label,
          emoji: stage.emoji,
        });

        try {
          const result = await runClaude({
            message: userMessage,
            systemPrompt: SESSION_SYSTEM_PROMPTS[stage.session],
            // 같은 그룹의 2턴째면 기존 세션을 이어서 사용 (하네스 오버헤드 캐시 재사용)
            claudeSessionId: sessionIds[stage.session],
            // 작성·수정 단계는 외부 조회가 없으므로 MCP를 붙이지 않습니다.
            // 그룹 내 두 턴에서 값이 동일해야 캐시가 유지됩니다.
            disableMcp: stage.session === 'authoring',
            onChunk: (chunk) => emit({ type: 'chunk', content: chunk }),
            onTool: (label) => emit({ type: 'tool', label }),
          });

          sessionIds[stage.session] = result.claudeSessionId;
          stageOutputs.push(result.content);

          emit({
            type: 'stage_done',
            stageIndex: i,
            stage: stage.mode,
            content: result.content,
            userMessage,
            claudeSessionId: result.claudeSessionId,
          });
        } catch (err) {
          // 실패한 실행은 fixture로 저장하지 않습니다 —
          // 에러만 재생하는 fixture가 기본값이 되면 재생 모드가 쓸모없어집니다.
          emit({
            type: 'error',
            message: err instanceof Error ? err.message : '파이프라인 오류가 발생했습니다.',
          });
          controller.close();
          return;
        }
      }

      emit({ type: 'done' });

      if (recorder) {
        const saved = await recorder.save();
        if (saved) console.log(`[pipeline] fixture 저장: ${saved}`);
      }

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
