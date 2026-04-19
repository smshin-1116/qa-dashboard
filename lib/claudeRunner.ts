import { spawn } from 'child_process';
import type { AgentMode } from '@/types/session';

// buildSystemPrompt는 chat/route.ts에 있으므로 여기서 직접 MODE_PROMPTS를 임포트하지 않고
// 파이프라인 API에서 필요한 프롬프트를 직접 전달받습니다.

export interface ClaudeRunOptions {
  message: string;
  systemPrompt: string;
  claudeSessionId?: string | null;
  onChunk?: (text: string) => void;
  onTool?: (label: string) => void;
}

export interface ClaudeRunResult {
  content: string;
  claudeSessionId: string | null;
}

const TOOL_LABELS: Record<string, string> = {
  mcp__atlassian__getConfluencePage: 'Confluence 페이지 읽기',
  mcp__atlassian__searchConfluenceUsingCql: 'Confluence 검색',
  mcp__atlassian__searchJiraIssuesUsingJql: 'Jira 검색',
  mcp__atlassian__getJiraIssue: 'Jira 티켓 조회',
  Bash: '명령어 실행',
  Read: '파일 읽기',
  Write: '파일 작성',
};

function getToolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.split('__').pop()?.replace(/_/g, ' ') ?? name;
}

/**
 * Claude CLI를 서브프로세스로 실행하고 결과를 Promise로 반환합니다.
 * 스트리밍 청크는 onChunk 콜백으로 실시간 전달됩니다.
 */
export function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return new Promise((resolve, reject) => {
    const { message, systemPrompt, claudeSessionId, onChunk, onTool } = options;

    const args: string[] = [
      '-p', message,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--append-system-prompt', systemPrompt,
    ];

    if (claudeSessionId) {
      args.push('--resume', claudeSessionId);
    }

    const { ANTHROPIC_API_KEY: _removed, ...cleanEnv } = process.env;
    const proc = spawn('claude', args, {
      env: cleanEnv,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let fullContent = '';
    let resultSessionId: string | null = claudeSessionId ?? null;
    const lastTextLengths = new Map<number, number>(); // 블록 인덱스별 커서 (다중 텍스트 블록 대응)
    let stdoutBuffer = '';
    let stderrBuffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event: Record<string, unknown> = JSON.parse(line);

          if (typeof event.session_id === 'string') {
            resultSessionId = event.session_id;
          }

          if (event.type === 'assistant') {
            const msg = event.message as {
              content?: Array<{ type: string; text?: string; name?: string }>;
            };
            if (msg?.content) {
              msg.content.forEach((block, blockIdx) => {
                if (block.type === 'tool_use' && typeof block.name === 'string') {
                  onTool?.(getToolLabel(block.name));
                }
                if (block.type === 'text' && typeof block.text === 'string') {
                  const prev = lastTextLengths.get(blockIdx) ?? 0;
                  const newText = block.text.slice(prev);
                  if (newText) {
                    fullContent += newText;
                    onChunk?.(newText);
                    lastTextLengths.set(blockIdx, block.text.length);
                  }
                }
              });
            }
          }

          if (event.type === 'result' && typeof event.session_id === 'string') {
            resultSessionId = event.session_id;
          }
        } catch {
          // JSON 파싱 실패 무시
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      stderrBuffer += text + '\n';
      console.error('[claudeRunner]', text);
    });

    proc.on('close', (code) => {
      if (code !== 0 && fullContent === '') {
        const detail = stderrBuffer.trim()
          ? `\n[stderr]: ${stderrBuffer.trim()}`
          : '';
        reject(new Error(`Claude 프로세스가 코드 ${code}로 종료됐습니다.${detail}`));
      } else {
        resolve({ content: fullContent, claudeSessionId: resultSessionId });
      }
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? 'claude CLI를 찾을 수 없습니다. Claude Code가 설치되어 있는지 확인하세요.'
            : err.message
        )
      );
    });
  });
}
