import { NextResponse } from 'next/server';
import { listRiskPatterns, setRiskPatternStatus, type RiskPatternRow } from '@/lib/workspace/repo';
import { extractRiskPatterns } from '@/lib/workspace/extractRiskPatterns';

/**
 * GET /api/workspace/risk — 리스크 패턴 목록 + 성과 지표.
 * POST { action:'extract' } — 버그 이력에서 candidate 패턴 추출(LLM 1회).
 * POST { action:'curate', id, status } — candidate → confirmed / retired (사람 확정).
 *
 * 원칙: 증거 없으면 카드 없음. GET(화면 로드)엔 LLM을 넣지 않는다(추출은 POST로 분리).
 */
export const dynamic = 'force-dynamic';

function toApi(p: RiskPatternRow) {
  const j = (s: string | null) => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  return {
    id: p.id,
    ref: p.ref,
    title: p.title,
    category: p.category,
    status: p.status,
    severity: p.severity,
    symptom: p.symptom,
    rootAssumption: p.root_assumption,
    evidence: j(p.evidence) as { jira_bugs?: string[]; occurrences?: number } | null,
    checkQuestions: (j(p.check_questions) as string[] | null) ?? [],
    updatedAt: p.updated_at,
  };
}

export function GET() {
  const patterns = listRiskPatterns().map(toApi);
  const confirmed = patterns.filter((p) => p.status === 'confirmed');
  const candidate = patterns.filter((p) => p.status === 'candidate');
  const retired = patterns.filter((p) => p.status === 'retired');
  // 성과 지표 — 아직 PR 대조·수용률 루프 전이라 축적치만. (발견 수가 아니라 수용률이 목표)
  const evidenceTotal = patterns.reduce((n, p) => n + (p.evidence?.jira_bugs?.length ?? 0), 0);
  return NextResponse.json({
    confirmed,
    candidate,
    retired,
    stats: {
      confirmed: confirmed.length,
      candidate: candidate.length,
      evidenceTotal,
      // 아직 수집 전 — 데이터 축적 후 표시
      acceptanceRate: null as number | null,
      blockedPreDeploy: null as number | null,
    },
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    id?: number;
    status?: 'candidate' | 'confirmed' | 'retired';
  };

  if (body.action === 'extract') {
    try {
      const result = await extractRiskPatterns();
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : '추출 실패' }, { status: 500 });
    }
  }

  if (body.action === 'curate') {
    if (!body.id || !body.status) return NextResponse.json({ error: 'id·status 필요' }, { status: 400 });
    setRiskPatternStatus(body.id, body.status);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
