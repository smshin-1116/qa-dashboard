import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * 수집기 공통 유틸.
 *
 * ── 설계 원칙 (토큰 예산) ─────────────────────────────────────────────
 * **수집기는 LLM을 절대 쓰지 않는다.**
 * 매일 아침 자동으로 도는 층에 LLM을 넣으면 매일 비용이 나간다.
 * 여기 있는 것은 전부 fetch · parse · 정규식이다.
 */

const execFileAsync = promisify(execFile);

/** 수집기 1개의 실행 결과 */
export interface CollectorResult {
  name: string;
  ok: boolean;
  /** 화면에 뿌릴 한 줄 요약 */
  detail: string;
  /** 실패 시 원인 (ok=false일 때만) */
  error?: string;
  /** 수집된 항목 수 */
  count?: number;
}

/**
 * 외부 명령 실행 (gh CLI 등).
 * 타임아웃을 반드시 건다 — 수집이 매달리면 아침 브리핑이 안 뜬다.
 */
export async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: opts.timeoutMs ?? 60_000,
    cwd: opts.cwd,
    maxBuffer: 32 * 1024 * 1024, // gh run --log는 수 MB가 나온다
    encoding: 'utf8',
  });
  return stdout;
}

/**
 * ANSI 이스케이프 제거.
 * Playwright 에러 메시지에 색상 코드가 섞여 들어와 fingerprint를 오염시킨다.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '').replace(/\^\[\[[0-9;]*m/g, '');
}

/**
 * GitHub Actions 로그 한 줄에서 접두부를 벗긴다.
 *   "job\tstep\t2026-08-07T00:51:47.391Z 실제내용"
 */
export function stripGhLogPrefix(line: string): string {
  const parts = line.split('\t');
  const tail = parts.length >= 3 ? parts.slice(2).join('\t') : line;
  return tail.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
}

/** 환경변수 필수 조회 — 없으면 수집기가 명확히 실패하도록 던진다 */
export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`환경변수 ${key} 가 설정되지 않았습니다 (.env.local 확인)`);
  return v;
}

/** 실패해도 전체 수집을 멈추지 않도록 감싸는 래퍼 */
export async function safely(
  name: string,
  fn: () => Promise<Omit<CollectorResult, 'name' | 'ok'>>,
): Promise<CollectorResult> {
  try {
    const r = await fn();
    return { name, ok: true, ...r };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, ok: false, detail: '수집 실패', error: msg.slice(0, 300) };
  }
}
