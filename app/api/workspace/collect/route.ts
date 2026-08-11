import { NextResponse } from 'next/server';
import { todayKst } from '@/lib/workspace/db';
import { collectAll } from '@/lib/workspace/collectors';
import { buildToday } from '@/lib/workspace/todo';

/**
 * POST /api/workspace/collect — 수집 후 오늘 할 일 재산출.
 *
 * 평소에는 스케줄러(아침 08:00)가 `npm run collect`로 부르고,
 * 이 라우트는 화면의 "지금 수집" 버튼용이다.
 *
 * ── 토큰 ──────────────────────────────────────────────────────────────
 * **LLM 호출 0.** gh CLI · Jira REST · 로컬 파일 읽기뿐이다.
 */
export const dynamic = 'force-dynamic';
// gh run view --log 가 수 MB라 기본 타임아웃으로는 부족할 수 있다
export const maxDuration = 300;

export async function POST() {
  const started = Date.now();
  try {
    const results = await collectAll();
    const build = buildToday(todayKst());

    return NextResponse.json({
      ok: results.every((r) => r.ok),
      elapsedMs: Date.now() - started,
      collectors: results,
      todo: build,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
