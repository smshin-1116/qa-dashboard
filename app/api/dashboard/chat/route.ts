import { spawn } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { NextRequest } from 'next/server';
import type { Attachment } from '@/types/session';
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

const QA_SYSTEM_PROMPT = `당신은 QA(품질보증) 전문 에이전트입니다.

## 지원 업무
- 테스트 케이스(TC) 작성 및 xlsx 형식 출력
- Jira 버그/QI 티켓 생성 및 조회
- Figma 디자인 분석 및 UI 검증
- GitHub 코드 리뷰 및 이슈 확인

## TC 출력 규칙 (중요)
테스트 케이스를 작성할 때는 반드시 아래 마크다운 테이블 형식만 사용합니다.

| ID | 카테고리 | 테스트 케이스 제목 | 전제 조건 | 테스트 스텝 | 기대 결과 | 우선순위 | 상태 |
|----|---------|-----------------|---------|-----------|---------|---------|------|
| TC-001 | 로그인 | 정상 로그인 | 유효한 계정 | 1. ID 입력 2. PW 입력 3. 클릭 | 대시보드 이동 | High | Not Run |

- ID: TC-001 형식, 우선순위: Highest/High/Medium/Low, 상태: Not Run
- 모든 응답은 한국어로 작성합니다`;

interface ChatRequestBody {
  /** 최신 사용자 메시지 (claude가 --resume으로 이전 히스토리 관리) */
  message: string;
  /** 두 번째 메시지부터 전달 — claude CLI --resume에 사용 */
  claudeSessionId?: string;
  attachments?: Attachment[];
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
    '--append-system-prompt', QA_SYSTEM_PROMPT,
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
