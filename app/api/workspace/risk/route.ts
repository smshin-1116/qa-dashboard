import { NextResponse } from 'next/server';
import {
  latestSignals,
  listRiskChecks,
  listRiskPatterns,
  riskAcceptanceStats,
  setRiskFindingVerdict,
  setRiskPatternStatus,
  type RiskCheckRow,
  type RiskFinding,
  type RiskPatternRow,
} from '@/lib/workspace/repo';
import { extractRiskPatterns } from '@/lib/workspace/extractRiskPatterns';
import { checkPrRisk } from '@/lib/workspace/checkPrRisk';

/**
 * GET /api/workspace/risk — 리스크 패턴 목록 + PR 대조 이력 + 성과 지표.
 * POST { action:'extract' } — 버그 이력에서 candidate 패턴 추출(LLM 1회).
 * POST { action:'curate', id, status } — candidate → confirmed / retired (사람 확정).
 * POST { action:'check', repo, prNumber } — PR ↔ confirmed 패턴 수동 대조(LLM 1회).
 * POST { action:'verdict', checkId, index, verdict } — finding 수용/기각 (수용률 환류).
 *
 * 원칙: 증거 없으면 카드 없음. GET(화면 로드)엔 LLM을 넣지 않는다(추출·대조는 POST로 분리).
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

function toApiCheck(c: RiskCheckRow) {
  let findings: RiskFinding[] = [];
  try {
    findings = JSON.parse(c.findings) as RiskFinding[];
  } catch {
    // 저장 경로가 항상 JSON.stringify라 정상적으론 없다
  }
  return {
    id: c.id,
    repo: c.repo,
    prNumber: c.pr_number,
    prTitle: c.pr_title,
    prUrl: c.pr_url,
    findings,
    patternsChecked: c.patterns_checked,
    createdAt: c.created_at,
  };
}

/** stage-pr 수집기가 이미 모은 병합 PR → 대조 후보 프리필 (LLM 0) */
function prCandidates() {
  const out: Array<{ repo: string; prNumber: number; title: string; url: string; detail: string | null }> = [];
  for (const s of latestSignals('stage-pr', 15)) {
    if (s.kind !== 'pr-merged' || !s.url) continue;
    const m = s.url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
    if (!m) continue;
    out.push({ repo: m[1], prNumber: Number(m[2]), title: s.title, url: s.url, detail: s.detail });
  }
  return out;
}

export function GET() {
  const patterns = listRiskPatterns().map(toApi);
  const confirmed = patterns.filter((p) => p.status === 'confirmed');
  const candidate = patterns.filter((p) => p.status === 'candidate');
  const retired = patterns.filter((p) => p.status === 'retired');
  const evidenceTotal = patterns.reduce((n, p) => n + (p.evidence?.jira_bugs?.length ?? 0), 0);
  // 성과 지표 — 발견 수가 아니라 수용률 (DESIGN §8). verdict가 쌓여야 뜬다.
  const { accepted, rejected } = riskAcceptanceStats();
  const judged = accepted + rejected;
  return NextResponse.json({
    confirmed,
    candidate,
    retired,
    checks: listRiskChecks(8).map(toApiCheck),
    prCandidates: prCandidates(),
    stats: {
      confirmed: confirmed.length,
      candidate: candidate.length,
      evidenceTotal,
      acceptanceRate: judged > 0 ? Math.round((accepted / judged) * 100) : null,
      judged,
      blockedPreDeploy: null as number | null,
    },
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    id?: number;
    status?: 'candidate' | 'confirmed' | 'retired';
    repo?: string;
    prNumber?: number;
    checkId?: number;
    index?: number;
    verdict?: 'accepted' | 'rejected' | null;
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

  if (body.action === 'check') {
    if (!body.repo || !body.prNumber) return NextResponse.json({ error: 'repo·prNumber 필요' }, { status: 400 });
    try {
      const result = await checkPrRisk(body.repo, body.prNumber);
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : '대조 실패' }, { status: 500 });
    }
  }

  if (body.action === 'verdict') {
    if (!body.checkId || body.index == null || body.verdict === undefined) {
      return NextResponse.json({ error: 'checkId·index·verdict 필요' }, { status: 400 });
    }
    const ok = setRiskFindingVerdict(body.checkId, body.index, body.verdict);
    if (!ok) return NextResponse.json({ error: '대상 finding이 없습니다 (재대조로 초기화됐을 수 있음)' }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
