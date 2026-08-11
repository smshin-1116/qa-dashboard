import { NextResponse } from 'next/server';
import { setTodoDone } from '@/lib/workspace/repo';

/**
 * PATCH /api/workspace/todo — 할 일 체크/해제.
 *
 * ── 왜 이것만 있나 ────────────────────────────────────────────────────
 * **자동 완료는 도입하지 않는다** (2026-08-04 결정 — 운영해보고 재결정).
 * 완료는 전부 사람이 누르므로, 서버가 할 일은 이 토글 하나뿐이다.
 * 체크해도 목록에서 사라지지 않는다 — 오늘 뭘 했는지 남아야 하루가 마감된다.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request) {
  const body = (await req.json()) as { id?: number; done?: boolean };

  if (typeof body.id !== 'number' || typeof body.done !== 'boolean') {
    return NextResponse.json({ error: 'id(number)와 done(boolean)이 필요합니다' }, { status: 400 });
  }

  setTodoDone(body.id, body.done);
  return NextResponse.json({ ok: true });
}
