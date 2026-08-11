import { NextResponse } from 'next/server';
import { setTcWorkContract, tcWorkBySession, upsertTcWork } from '@/lib/workspace/repo';
import { absorbWithCodex } from '@/lib/workspace/codexAbsorb';
import { validateContract, type Contract, type ContractDecision } from '@/lib/workspace/contract';

/**
 * ⓪ 개별 흡수 · ① 교차 분석 · ② 확인 게이트의 서버 반쪽.
 *
 * POST absorb : Codex 세션 1개로 소스들을 흡수·교차분석 → 계약 저장 → 게이트 재료 반환
 * POST decide : 게이트 답변(decisions)을 계약에 고정
 * GET         : 저장된 계약 조회 — 게이트가 새로고침에도 살아남는 이유
 *
 * ── Claude 토큰 0 ─────────────────────────────────────────────────────
 * 여기서 도는 LLM은 Codex(ChatGPT 플랜)뿐이다. Claude는 ③ 설계부터 —
 * 그마저도 이 라우트가 아니라 채팅 경로로 나간다.
 */
export const dynamic = 'force-dynamic';
/** codex exec가 1차+재시도까지 7분을 쓸 수 있다 — Next 기본(무제한 아님)보다 명시가 안전 */
export const maxDuration = 900;

interface AbsorbBody {
  action: 'absorb';
  sessionId: string;
  title: string;
  urls: string[];
  text: string;
}
interface DecideBody {
  action: 'decide';
  sessionId: string;
  decisions: ContractDecision[];
}

export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get('sessionId');
  if (!sessionId) return NextResponse.json({ error: 'sessionId가 필요합니다' }, { status: 400 });

  const work = tcWorkBySession(sessionId);
  if (!work?.contract) return NextResponse.json({ contract: null });

  return NextResponse.json({ contract: JSON.parse(work.contract) as Contract });
}

export async function POST(req: Request) {
  const body = (await req.json()) as AbsorbBody | DecideBody;

  switch (body.action) {
    case 'absorb': {
      if (body.urls.length === 0 && !body.text.trim()) {
        return NextResponse.json({ error: '소스가 없습니다' }, { status: 400 });
      }

      const workId = upsertTcWork({
        sessionId: body.sessionId,
        title: body.title,
        sources: { urls: body.urls, text: body.text || undefined },
      });

      const result = await absorbWithCodex({ urls: body.urls, text: body.text });

      if (result.contract) {
        setTcWorkContract(workId, result.contract);
      }

      return NextResponse.json({
        engine: result.engine,
        contract: result.contract,
        fallbackReason: result.fallbackReason ?? null,
        tokensUsed: result.tokensUsed ?? null,
      });
    }

    // ── ② 확인 게이트 — 답변을 전제로 고정 ──────────────────────────
    // 시안: "여기서 답한 내용이 전제로 고정되어 이후 TC 전 단계에 적용된다"
    case 'decide': {
      const work = tcWorkBySession(body.sessionId);
      if (!work?.contract) {
        return NextResponse.json({ error: '계약이 없습니다 — 먼저 흡수를 실행하세요' }, { status: 404 });
      }
      const parsed = validateContract(JSON.parse(work.contract));
      if (!parsed.contract) {
        return NextResponse.json({ error: '저장된 계약이 손상됐습니다' }, { status: 500 });
      }
      parsed.contract.decisions = body.decisions;
      setTcWorkContract(work.id, parsed.contract);
      return NextResponse.json({ ok: true, decisions: body.decisions.length });
    }

    default:
      return NextResponse.json({ error: '알 수 없는 action' }, { status: 400 });
  }
}
