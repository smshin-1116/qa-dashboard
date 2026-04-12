import { spawn } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { NextRequest } from 'next/server';
import type { Attachment, AgentMode } from '@/types/session';
import { META_PREFIX, TOOL_PREFIX } from '@/constants/streamProtocol';

const TOOL_LABELS: Record<string, string> = {
  // Jira
  mcp__atlassian__searchJiraIssuesUsingJql: 'Jira 검색',
  mcp__atlassian__createJiraIssue: 'Jira 티켓 생성',
  mcp__atlassian__getJiraIssue: 'Jira 티켓 조회',
  mcp__atlassian__editJiraIssue: 'Jira 티켓 수정',
  mcp__atlassian__transitionJiraIssue: 'Jira 상태 변경',
  mcp__atlassian__addCommentToJiraIssue: 'Jira 댓글 추가',
  mcp__atlassian__addWorklogToJiraIssue: 'Jira 작업 로그 추가',
  // Confluence
  mcp__atlassian__getConfluencePage: 'Confluence 페이지 읽기',
  mcp__atlassian__searchConfluenceUsingCql: 'Confluence 검색',
  mcp__atlassian__createConfluencePage: 'Confluence 페이지 생성',
  mcp__atlassian__updateConfluencePage: 'Confluence 페이지 수정',
  mcp__atlassian__getPagesInConfluenceSpace: 'Confluence 스페이스 조회',
  // Figma
  mcp__claude_ai_Figma__get_design_context: 'Figma 디자인 분석',
  mcp__claude_ai_Figma__get_screenshot: 'Figma 스크린샷',
  'mcp__figma-remote-mcp__get_design_context': 'Figma 디자인 분석',
  'mcp__figma-remote-mcp__get_screenshot': 'Figma 스크린샷',
  // GitHub
  mcp__github__search_code: 'GitHub 코드 검색',
  mcp__github__list_issues: 'GitHub 이슈 목록 조회',
  mcp__github__issue_read: 'GitHub 이슈 읽기',
  mcp__github__create_pull_request: 'GitHub PR 생성',
  mcp__github__get_file_contents: 'GitHub 파일 조회',
  // Slack
  mcp__claude_ai_Slack__slack_send_message: 'Slack 메시지 전송',
  mcp__claude_ai_Slack__slack_read_channel: 'Slack 채널 읽기',
  mcp__claude_ai_Slack__slack_search_public: 'Slack 검색',
  // CLI tools
  Bash: '명령어 실행',
  Read: '파일 읽기',
  Write: '파일 작성',
  Glob: '파일 검색',
  Grep: '코드 검색',
};

function getToolLabel(toolName: string): string {
  return (
    TOOL_LABELS[toolName] ??
    toolName.split('__').pop()?.replace(/_/g, ' ') ??
    toolName
  );
}

const ATLASSIAN_CLOUD_ID = process.env.CONFLUENCE_BASE_URL
  ? new URL(process.env.CONFLUENCE_BASE_URL).hostname
  : null;

const GITHUB_REPO_BACKEND = process.env.GITHUB_REPO_BACKEND ?? null;
const GITHUB_REPO_FRONTEND = process.env.GITHUB_REPO_FRONTEND ?? null;

const BASE_CONTEXT = `
## Atlassian 설정${ATLASSIAN_CLOUD_ID ? `\n- Jira/Confluence cloudId: ${ATLASSIAN_CLOUD_ID}\n- MCP Atlassian 도구 호출 시 cloudId는 항상 "${ATLASSIAN_CLOUD_ID}"를 사용합니다.` : ''}

## GitHub 레포지토리${GITHUB_REPO_BACKEND ? `\n- 백엔드: ${GITHUB_REPO_BACKEND}` : ''}${GITHUB_REPO_FRONTEND ? `\n- 프론트엔드: ${GITHUB_REPO_FRONTEND}` : ''}${GITHUB_REPO_BACKEND || GITHUB_REPO_FRONTEND ? '\n- GitHub 코드 분석 시 위 레포를 기준으로 검색합니다.' : ''}

모든 응답은 한국어로 작성합니다.`;

const TC_TABLE_FORMAT = `## TC 출력 형식 (마크다운 테이블, 반드시 준수)

| TC-ID | 대분류 | 중분류 | 소분류 | 검증단계 | 전제조건 | 테스트 스텝 | 기대결과 | 플랫폼 | 결과 | 비고 |
|-------|--------|--------|--------|---------|---------|-----------|---------|-------|------|------|
| TC-001 | 배차 관리 | 자동 최적화 배차 | 배차 실행 | 정상 | 로그인 상태, 주문 3건 등록 | 1. 배차 실행 버튼 클릭 2. 배차 결과 화면 확인 | 주문 3건이 배차 완료 상태로 표시됨 | PC(Web) | Not Test | |

### 컬럼 규칙
- **TC-ID**: TC-001, TC-002… 형식 (3자리 zero-padding)
- **대분류 / 중분류 / 소분류**: 3단계 기능 분류 (같은 분류는 최상단 1회만 표기)
- **검증단계**: 정상 / 부정 / 예외 중 하나
- **전제조건**: 테스트 시작 전 필요한 상태 (로그인 여부, 데이터 준비 등)
- **테스트 스텝**: [사전 상태]에서 [행동]하면 [구체적 결과]가 발생하는지 확인
- **기대결과**: 사용자가 보는 화면/동작 기준으로 기술 (코드 레퍼런스 금지)
- **플랫폼**: PC(Web) / Mobile(App) / 공통 중 하나
- **결과**: Not Test (기본값) / PASS / FAIL / BLOCK / N/A
- **비고**: 추후구현, 기획변경 이력, 정책 참고 등 (없으면 빈칸)`;

const MODE_PROMPTS: Record<AgentMode, string> = {
  general: `당신은 QA(품질보증) 전문 에이전트입니다.
${BASE_CONTEXT}

## 지원 업무
- 테스트 케이스(TC) 작성 및 xlsx 형식 출력
- Jira 버그/QI 티켓 생성 및 조회
- Figma 디자인 분석 및 UI 검증
- GitHub 코드 리뷰 및 이슈 확인

${TC_TABLE_FORMAT}`,

  designer: `당신은 TC 설계 전문 에이전트입니다.
${BASE_CONTEXT}

## 역할
기획서(Confluence, 문서, URL)를 분석하여 TC 작성을 위한 기능 구조를 설계합니다.

## 설계 산출물 (기획서를 받으면 아래 순서로 제공)

### 1. 기능 분류 구조 (대/중/소분류)
\`\`\`
대분류
  └ 중분류
      └ 소분류 [리스크 레벨]
\`\`\`

### 2. 암묵적 요구사항 태깅
기획서에 명시되지 않았지만 반드시 검증해야 하는 항목을 자동으로 도출:
- [세션] 로그인 상태, 권한 분기
- [권한] 접근 제어, 역할별 기능 제한
- [데이터] 입력값 경계, NULL/빈값 처리
- [UI] 화면 표시, 레이아웃, 반응형
- [동시성] 중복 요청, 경쟁 조건, 동시 입력

### 3. 커버리지 매핑표
| 소분류 | 핵심 검증 키워드 | 리스크 | 예상 TC 수 |

### 4. 리스크 레벨 분류
- [HIGH]: 핵심 기능, 결제/인증/데이터 손실 위험
- [MEDIUM]: 주요 기능, UX에 영향
- [LOW]: 부가 기능, UI 보조 요소

### 5. 검증단계 권장 배분
소분류별 정상/부정/예외 권장 수량 (부정+예외 합계 49~60% 목표)`,

  writer: `당신은 TC 작성 전문 에이전트입니다.
${BASE_CONTEXT}

${TC_TABLE_FORMAT}

## TC 품질 규칙 (위반 시 자동으로 수정하여 출력)

| 규칙 | 위반 예시 | 올바른 예시 |
|------|----------|------------|
| 1 TC = 1 검증 포인트 | "A되고 B되는지 확인" | TC 분리 |
| 추상 표현 금지 | "정상 동작하는지 확인" | "배차 실행 버튼 클릭 시 배차 결과 화면으로 이동하는지 확인" |
| 테스트 스텝 3요소 필수 | "배차하면 확인" | "[로그인 상태, 주문 3건]에서 [배차 실행]하면 [주문 3건 배차 완료 표시]되는지 확인" |
| 경계값 수치 필수 | "주문이 없을 때" | "주문 0건인 상태에서 배차 실행 시 '배차할 주문이 없습니다' 메시지가 표시되는지 확인" |
| 플랫폼 스텝 중복 금지 | "PC에서 ~하면" (스텝에) | 플랫폼은 플랫폼 컬럼에만 명시 |

## 검증단계 분포 (TC 완성 후 반드시 집계)
- **부정 + 예외 합계: 49~60%** (권장 55%)
- **정상: 40% 이상**
- 범위 이탈 시 부족한 유형 보강 후 재출력

## 예외 케이스 필수 포함
- 경계값 (최솟값, 최댓값, 경계±1)
- 동시 요청 / 중복 실행
- 권한 없는 접근 / 비로그인 상태
- 네트워크 오류 / 서버 에러
- 빈값 / NULL 입력

## TC 완성 시 제공
1. TC 마크다운 테이블 (11컬럼)
2. 검증단계 분포 통계 (정상 N개 XX%, 부정 N개 XX%, 예외 N개 XX%)
3. 분포 범위 초과 시 ⚠️ 경고`,

  reviewer: `당신은 QA 리뷰 전문 에이전트입니다.
${BASE_CONTEXT}

## 역할
제공된 TC를 EVAL 기준으로 검증하고 이슈를 도출합니다.

## EVAL 검증 기준 (13개)

### 구조 리뷰 — "빠진 게 없는가?"
- **EVAL-01**: 기획서/요구사항 대비 TC 커버리지 전수 확인 (누락 항목 0건 목표)
- **EVAL-02**: 각 소분류에 정상+부정+예외 최소 1개씩 존재
- **EVAL-04**: 플랫폼 값이 PC(Web) / Mobile(App) / 공통 외 없음
- **EVAL-05**: TC-ID 001부터 순서대로, 중복·빠짐 없음
- **EVAL-06**: 동일 소분류 TC 연속 배치 (분산 금지)
- **EVAL-08**: 동일 분류 최상단 1회만 표기, 이후 빈칸
- **EVAL-10**: 요구사항 섹션과 TC 대분류 1:1 매핑 (누락 0건)
- **EVAL-12**: 상태가 있는 기능의 전이 케이스 커버리지

### 품질 리뷰 — "내용이 올바른가?"
- **EVAL-03**: 재현스텝 추상 표현 없음, 구체적 기대결과 포함
- **EVAL-07**: 완전 중복 TC 없음 (다른 TC와 재현스텝이 동일한 경우)
- **EVAL-09**: 1TC=1검증, 테스트 스텝에 플랫폼 중복 없음, 부정+예외 49~60%, 경계값 수치 명시
- **EVAL-11**: 취소선/미구현 항목 → 비고에 "추후구현" 표기 여부
- **EVAL-13**: 복합 조건("A이고 B이면") 기능의 단독 실패 케이스 존재

## 이슈 심각도
- **CRITICAL**: 즉시 수정 필수 (출시 불가 수준)
- **HIGH**: 수정 강력 권고
- **MEDIUM**: 개선 권고
- **LOW**: 참고 사항

## 리뷰 보고서 형식

\`\`\`
## QA 리뷰 보고서

### EVAL 결과 요약
| EVAL | 항목 | 결과 | 이슈 수 |
|------|------|------|---------|
| EVAL-01 | 커버리지 | PASS/FAIL | N |
...

### 이슈 목록
| 번호 | 심각도 | TC-ID | 이슈 내용 | 수정 방향 |
|------|--------|-------|----------|----------|

### Pass Gate
- CRITICAL: N건 / HIGH: N건
- 판정: PASS (출시 가능) / FAIL (수정 필요)
\`\`\``,

  fixer: `당신은 TC 수정 전문 에이전트입니다.
${BASE_CONTEXT}

## 역할
리뷰 보고서의 이슈를 기반으로 TC를 수정합니다.

## 수정 우선순위
**CRITICAL → HIGH → MEDIUM → LOW** 순으로 처리

## 수정 규칙
1. **이슈 1:1 대응**: 리뷰 보고서의 각 이슈를 하나씩 수정
2. **검증단계 재분류 금지**: 부정→예외 등 단순 재분류는 품질 향상 아님 → 새 시나리오 추가
3. **커버리지 누락**: 해당 소분류 위치에 TC 삽입 (흩어짐 금지)
4. **TC-ID 재채번**: 수정 후 001부터 연속 채번
5. **분포 재확인**: 수정 후 검증단계 분포(부정+예외 49~60%) 재집계

## TC 출력 형식
수정된 전체 TC를 마크다운 테이블로 출력 (11컬럼):
| TC-ID | 대분류 | 중분류 | 소분류 | 검증단계 | 전제조건 | 테스트 스텝 | 기대결과 | 플랫폼 | 결과 | 비고 |

## 완료 보고 형식

\`\`\`
## TC 수정 완료 보고

### 수정 내역
| 이슈 번호 | 심각도 | 수정 내용 |

### 검증단계 분포 (수정 후)
- 정상: N개 (XX%) / 부정: N개 (XX%) / 예외: N개 (XX%)

### 잔여 이슈
- 수정 불가 항목 및 사유
\`\`\``,
};

function buildSystemPrompt(mode: AgentMode): string {
  return MODE_PROMPTS[mode] ?? MODE_PROMPTS.general;
}

interface ChatRequestBody {
  /** 최신 사용자 메시지 (claude가 --resume으로 이전 히스토리 관리) */
  message: string;
  /** 두 번째 메시지부터 전달 — claude CLI --resume에 사용 */
  claudeSessionId?: string;
  attachments?: Attachment[];
  /** 에이전트 모드 — 모드별 시스템 프롬프트 분기 */
  agentMode?: AgentMode;
}

/** base64 첨부파일을 /tmp/qa-uploads 에 저장 후 경로 반환 */
async function saveAttachments(attachments: Attachment[]): Promise<string[]> {
  const uploadDir = join(tmpdir(), 'qa-uploads');
  await mkdir(uploadDir, { recursive: true });

  const paths: string[] = [];
  for (const att of attachments) {
    if (att.type === 'code') continue; // 코드는 메시지 인라인 처리
    const base64Data = att.data.includes(',') ? att.data.split(',')[1] : att.data;
    const buffer = Buffer.from(base64Data, 'base64');
    const filePath = join(uploadDir, `${Date.now()}_${att.name}`);
    await writeFile(filePath, buffer);
    paths.push(filePath);
  }
  return paths;
}

export async function POST(req: NextRequest) {
  const body: ChatRequestBody = await req.json();
  const agentMode: AgentMode = body.agentMode ?? 'general';

  // 첨부파일 임시 저장
  const filePaths: string[] = body.attachments?.length
    ? await saveAttachments(body.attachments)
    : [];

  // 메시지에 첨부파일 컨텍스트 추가
  let message = body.message;
  const codeSnippets = (body.attachments ?? []).filter((a) => a.type === 'code');
  for (const snippet of codeSnippets) {
    message += `\n\n\`\`\`\n${snippet.data}\n\`\`\``;
  }
  if (filePaths.length > 0) {
    message += `\n\n[첨부 파일 경로: ${filePaths.join(', ')}]`;
  }

  // claude CLI 인수 구성
  const args: string[] = [
    '-p', message,
    '--output-format', 'stream-json',
    '--verbose',                       // stream-json 에 필수
    '--include-partial-messages',
    '--dangerously-skip-permissions',  // 비대화형 모드에서 tool 자동 승인
    '--append-system-prompt', buildSystemPrompt(agentMode),
  ];

  if (body.claudeSessionId) {
    // 이전 대화 이어서 — claude가 히스토리 자체 관리
    args.push('--resume', body.claudeSessionId);
  }

  if (filePaths.length > 0) {
    args.push('--add-dir', join(tmpdir(), 'qa-uploads'));
  }

  const readable = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let claudeSessionId: string | null = null;
      let metaSent = false;
      let lastTextLength = 0; // 부분 메시지 중복 방지용 커서
      let stdoutBuffer = '';

      // claude를 찾을 수 없을 때를 대비해 which로 경로 확인
      // ANTHROPIC_API_KEY를 제거해 Claude Code 자체 OAuth(구독) 인증 사용
      const { ANTHROPIC_API_KEY: _removed, ...cleanEnv } = process.env;
      const proc = spawn('claude', args, {
        env: cleanEnv,
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'], // stdin을 /dev/null로 처리
      });

      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event: Record<string, unknown> = JSON.parse(line);

            // 세션 ID 추출 (system/init 이벤트)
            if (typeof event.session_id === 'string' && !claudeSessionId) {
              claudeSessionId = event.session_id;
            }

            // 메타데이터를 스트림 첫 데이터로 전송
            if (claudeSessionId && !metaSent) {
              const meta = JSON.stringify({ claudeSessionId });
              controller.enqueue(enc.encode(`${META_PREFIX}${meta}\n`));
              metaSent = true;
            }

            // assistant 텍스트 스트리밍 (누적 텍스트에서 새 부분만 전송)
            if (event.type === 'assistant') {
              const msg = event.message as {
                content?: Array<{ type: string; text?: string; name?: string }>;
              };
              if (msg?.content) {
                for (const block of msg.content) {
                  // 도구 실행 이벤트 전송
                  if (block.type === 'tool_use' && typeof block.name === 'string') {
                    const label = getToolLabel(block.name);
                    controller.enqueue(enc.encode(`${TOOL_PREFIX}${label}\n`));
                  }
                  // 텍스트 스트리밍
                  if (block.type === 'text' && typeof block.text === 'string') {
                    const newText = block.text.slice(lastTextLength);
                    if (newText) {
                      controller.enqueue(enc.encode(newText));
                      lastTextLength = block.text.length;
                    }
                  }
                }
              }
            }

            // 최종 결과에서 session_id 재확인
            if (event.type === 'result' && typeof event.session_id === 'string') {
              claudeSessionId = event.session_id;
            }
          } catch {
            // JSON 파싱 실패한 줄은 무시
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        // stderr는 로그로만 기록
        console.error('[claude subprocess]', chunk.toString().trim());
      });

      proc.on('close', () => {
        controller.close();
      });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        const msg =
          err.code === 'ENOENT'
            ? 'claude CLI를 찾을 수 없습니다. Claude Code가 설치되어 있는지 확인하세요.'
            : `서브프로세스 오류: ${err.message}`;
        controller.enqueue(enc.encode(`\n\n[오류: ${msg}]`));
        controller.close();
      });
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  });
}
