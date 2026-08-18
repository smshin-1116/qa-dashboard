import { NextResponse } from 'next/server';
import {
  closeTcWork,
  handOffTc,
  setTcResult,
  setTcVerdict,
  tcWorkBySession,
  tcsOfWork,
  upsertTc,
  upsertTcWork,
  upsertFinding,
  type TcRowDb,
} from '@/lib/workspace/repo';
import { assignCatalogIds, candidatesFor, loadCatalog } from '@/lib/workspace/catalog';
import { makeFingerprint } from '@/lib/workspace/fingerprint';
import { buildComment, extractTicketKeys, tally } from '@/lib/workspace/tcReport';
import { postComments } from '@/lib/workspace/jiraComment';
import { todayKst } from '@/lib/workspace/db';

/**
 * QA 작업의 TC — 저장 · 수행 결과 기입 · 자동화 인계.
 *
 * ── 독립성 (2026-08-10 결정) ──────────────────────────────────────────
 * QA 작업은 **카탈로그를 몰라도 완결**된다. 저장·수행 경로는 카탈로그를 건드리지 않고,
 * 카탈로그는 "넘기기"를 누를 때만 조회한다. 그마저도 실패하면 null을 받아
 * 후보 없이 진행한다 — 카탈로그가 깨져도 QA 작업은 멈추지 않는다.
 *
 * ── 인계는 한 방향·한 지점 ────────────────────────────────────────────
 * 넘기기는 `finding(kind='coverage-gap')` 한 줄을 남기고 끝난다.
 * 테스트 자동화 화면은 그 신호만 보며, QA 작업의 테이블을 들여다보지 않는다.
 *
 * ── 토큰 ──────────────────────────────────────────────────────────────
 * LLM 호출 0. 저장·조회·문자열 비교뿐이다.
 */
export const dynamic = 'force-dynamic';

// ─── GET: 작업의 TC 목록 ──────────────────────────────────────────────

export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId가 필요합니다' }, { status: 400 });
  }

  const work = tcWorkBySession(sessionId);
  if (!work) return NextResponse.json({ work: null, tcs: [] });

  const rows = tcsOfWork(work.id);

  return NextResponse.json({
    work,
    tcs: rows.map(toApi),
    /**
     * 시안의 "기존 자동화 대조" 행 — 화면에 들어오자마자 보여야 한다.
     * "이거 이미 자동화돼 있는데?"를 TC를 다 쓴 뒤가 아니라 **보는 즉시** 알려주는 것이 목적이다.
     * 카탈로그를 못 읽으면 null — QA 작업은 그대로 진행된다(독립성).
     */
    crosscheck: crosscheckOf(rows),
    /** 티켓 코멘트 등록 대상 후보 — 제목에서 뽑는다. 대화 본문은 클라이언트가 더해 보낸다 */
    ticketKeys: extractTicketKeys(work.title),
    tally: tally(rows),
  });
}

/** 카탈로그와 겹치는 TC를 찾아 상위 몇 건만 요약한다 (정렬용 점수, 판정 아님) */
function crosscheckOf(rows: TcRowDb[]) {
  const catalog = loadCatalog();
  if (!catalog) return null;

  const hits = rows
    .map((t) => {
      const g = candidatesFor(
        {
          category: t.category,
          subCategory: t.sub_category,
          detailCategory: t.detail_category,
          steps: t.steps,
          expected: t.expected,
        },
        catalog,
      );
      const best = g.candidates[0];
      return best ? { localId: t.local_id, entry: best } : null;
    })
    .filter((x): x is { localId: string; entry: NonNullable<typeof x>['entry'] } => x !== null)
    // 60% 미만은 "겹친다"고 말하기 어렵다 — 시끄러우면 아무도 안 본다
    .filter((x) => x.entry.score >= 0.6)
    .sort((a, b) => b.entry.score - a.entry.score);

  /**
   * 같은 카탈로그 항목을 여러 TC가 물면 한 줄로 묶는다.
   * (한 티켓의 TC들은 대개 같은 기능을 여러 각도로 보므로 최고 매치가 겹친다 —
   *  "ROUTE-007 · ROUTE-007"처럼 같은 이름이 반복되면 읽는 사람이 오해한다)
   */
  const merged = new Map<string, { catalogId: string; localIds: string[]; entry: (typeof hits)[number]['entry'] }>();
  for (const h of hits) {
    const cur = merged.get(h.entry.id);
    if (cur) cur.localIds.push(h.localId);
    else merged.set(h.entry.id, { catalogId: h.entry.id, localIds: [h.localId], entry: h.entry });
  }

  return {
    catalogTotal: catalog.entries.length,
    generatedAt: catalog.generatedAt,
    hits: [...merged.values()].map((h) => ({
      localIds: h.localIds,
      catalogId: h.catalogId,
      title: h.entry.title,
      impl: h.entry.impl,
      tier: h.entry.tier,
      score: Math.round(h.entry.score * 100),
    })),
  };
}

function toApi(t: TcRowDb) {
  return {
    id: t.id,
    localId: t.local_id,
    catalogId: t.catalog_id,
    verdict: t.verdict,
    matchedCatalogId: t.matched_catalog_id,
    matchReason: t.match_reason,
    category: t.category,
    subCategory: t.sub_category,
    detailCategory: t.detail_category,
    phase: t.phase,
    precondition: t.precondition,
    steps: t.steps,
    expected: t.expected,
    platform: t.platform,
    result: t.result,
    note: t.note,
    testRef: t.test_ref ? (JSON.parse(t.test_ref) as string[]) : [],
    handedOffAt: t.handed_off_at,
    // 11컬럼 밖의 값 — 화면이 이걸 읽어 컬럼을 늘린다 (컬럼 고정 해제의 실현부)
    extra: t.extra ? (JSON.parse(t.extra) as Record<string, string>) : null,
  };
}

// ─── POST: 저장 / 결과 기입 / 후보 조회 / 인계 ────────────────────────

interface SaveBody {
  action: 'save';
  sessionId: string;
  title: string;
  sources?: unknown;
  rows: Array<Record<string, string>>;
}
interface ResultBody {
  action: 'result';
  id: number;
  result: 'Pass' | 'Fail' | 'Blocked' | 'Not Test';
}
/**
 * 자동 수행 결과 일괄 기입 — Claude가 stage에서 수행한 결과를 파싱해 한 번에 넣는다.
 * local_id(TC-01)로 매칭한다 — 응답 표는 local_id를 쓰기 때문. 사유(note)도 함께 저장.
 */
interface AutoResultsBody {
  action: 'auto-results';
  sessionId: string;
  results: Array<{ localId: string; result: 'Pass' | 'Fail' | 'Blocked' | 'Not Test'; note?: string }>;
}
interface CandidatesBody {
  action: 'candidates';
  ids: number[];
  sessionId: string;
}
interface HandoffBody {
  action: 'handoff';
  sessionId: string;
  /** 넘길 TC — duplicateOf가 있으면 중복으로 표시하고 넘기지 않는다 */
  items: Array<{ id: number; duplicateOf?: string | null }>;
}

/** 넘기기 **전에** 카탈로그 번호가 뭐가 될지 보여주기 위한 계산 (저장 없음) */
interface PreviewBody {
  action: 'preview';
  sessionId: string;
  ids: number[];
}
/** 티켓에 등록될 코멘트 본문을 만들어 보여준다 (등록하지 않는다) */
interface ClosePreviewBody {
  action: 'close-preview';
  sessionId: string;
  /** 대화 본문에서 뽑은 티켓 키 — 제목만으로는 놓치는 게 있어 클라이언트가 보탠다 */
  hintText?: string;
}
/** 실제 등록 + 작업 종료 — 사람이 버튼을 눌러야만 온다 */
interface CloseBody {
  action: 'close';
  sessionId: string;
  keys: string[];
  body: string;
}

type Body =
  | SaveBody
  | ResultBody
  | AutoResultsBody
  | CandidatesBody
  | HandoffBody
  | PreviewBody
  | ClosePreviewBody
  | CloseBody;

export async function POST(req: Request) {
  const body = (await req.json()) as Body;

  switch (body.action) {
    // ── 파이프라인이 만든 TC를 상태 저장소로 ─────────────────────────
    // 채팅 메시지의 마크다운 표에만 있으면 수행 결과·인계를 붙일 자리가 없다.
    case 'save': {
      const workId = upsertTcWork({
        sessionId: body.sessionId,
        title: body.title,
        sources: body.sources,
      });
      let n = 0;
      for (const [i, row] of body.rows.entries()) {
        // 작업 내 일련번호 — 카탈로그 번호는 넘길 때 받는다 (2026-08-07 결정)
        const localId = row['TC-ID']?.trim() || `TC-${String(i + 1).padStart(2, '0')}`;
        const known = new Set([
          'TC-ID', '대분류', '중분류', '소분류', '검증단계',
          '전제조건', '테스트 스텝', '기대결과', '플랫폼', '결과', '비고',
        ]);
        // 11컬럼 밖의 값은 extra로 — 컬럼 고정 해제 대비 (2026-08-06 결정)
        const extra: Record<string, string> = {};
        for (const [k, v] of Object.entries(row)) if (!known.has(k) && v) extra[k] = v;

        upsertTc({
          workId,
          localId,
          category: row['대분류'] ?? null,
          subCategory: row['중분류'] ?? null,
          detailCategory: row['소분류'] ?? null,
          phase: row['검증단계'] ?? null,
          precondition: row['전제조건'] ?? null,
          steps: row['테스트 스텝'] ?? null,
          expected: row['기대결과'] ?? null,
          platform: row['플랫폼'] ?? null,
          note: row['비고'] ?? null,
          extra: Object.keys(extra).length ? extra : null,
        });
        n++;
      }
      return NextResponse.json({ ok: true, workId, saved: n });
    }

    // ── 수행 결과 기입 — 사람이 넣는다 ───────────────────────────────
    case 'result':
      setTcResult(body.id, body.result);
      return NextResponse.json({ ok: true });

    // ── 자동 수행 결과 일괄 기입 — Claude가 수행한 결과를 local_id로 매칭 ──
    case 'auto-results': {
      const work = tcWorkBySession(body.sessionId);
      if (!work) return NextResponse.json({ error: '작업을 찾을 수 없습니다' }, { status: 404 });
      const all = tcsOfWork(work.id);
      const byLocal = new Map(all.map((t) => [t.local_id, t]));
      // 정규화 키 — 대소문자·구분자·zero-padding 차이를 흡수한다.
      // (예: "TC-01" == "TC-001" == "tc 1", "MV-003" == "MV3"). local_id 형식이 작업마다
      //  달라(숫자·TC-·MV- 등) 모델이 살짝 다르게 뱉어도 매칭되게 하는 폴백. 정확 매칭 우선.
      const norm = (s: string) =>
        s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/\d+/g, (m) => String(parseInt(m, 10)));
      const byNorm = new Map(all.map((t) => [norm(t.local_id), t]));
      let applied = 0;
      const unmatched: string[] = [];
      for (const r of body.results) {
        const tc = byLocal.get(r.localId) ?? byNorm.get(norm(r.localId));
        if (!tc) {
          unmatched.push(r.localId);
          continue;
        }
        setTcResult(tc.id, r.result, r.note ?? null);
        applied++;
      }
      // 조용한 실패 금지 — 매칭 안 된 local_id를 화면이 알 수 있게 돌려준다
      return NextResponse.json({ ok: true, applied, unmatched });
    }

    // ── 넘기기 직전 중복 확인용 후보 ─────────────────────────────────
    // 판정이 아니라 **검색**이다. 카테고리로 좁히고 유사도로 정렬만 하며,
    // 잘라내지 않는다 — 잘라내면 "없다"는 잘못된 확신을 준다.
    case 'candidates': {
      const catalog = loadCatalog();
      const work = tcWorkBySession(body.sessionId);
      if (!work) return NextResponse.json({ error: '작업을 찾을 수 없습니다' }, { status: 404 });

      const all = tcsOfWork(work.id);
      const picked = all.filter((t) => body.ids.includes(t.id));

      if (!catalog) {
        // 카탈로그가 없어도 인계 자체는 가능하다 (독립성)
        return NextResponse.json({
          catalogAvailable: false,
          note: '자동화 카탈로그를 읽지 못했습니다 — 중복 확인 없이 넘길 수 있습니다',
          items: picked.map((t) => ({
            id: t.id,
            localId: t.local_id,
            summary: t.steps?.slice(0, 80) ?? '',
            group: null,
          })),
        });
      }

      return NextResponse.json({
        catalogAvailable: true,
        catalogTotal: catalog.entries.length,
        generatedAt: catalog.generatedAt,
        items: picked.map((t) => {
          const g = candidatesFor(
            {
              category: t.category,
              subCategory: t.sub_category,
              detailCategory: t.detail_category,
              steps: t.steps,
              expected: t.expected,
            },
            catalog,
          );
          return {
            id: t.id,
            localId: t.local_id,
            summary: t.steps?.slice(0, 80) ?? '',
            group: {
              section: g.section,
              prefix: g.prefix,
              total: g.candidates.length,
              candidates: g.candidates.map((c) => ({
                id: c.id,
                title: c.title,
                impl: c.impl,
                tier: c.tier,
                score: Math.round(c.score * 100),
              })),
            },
          };
        }),
      });
    }

    // ── 인계 — coverage-gap 신호 하나를 남기고 끝 ────────────────────
    case 'handoff': {
      const work = tcWorkBySession(body.sessionId);
      if (!work) return NextResponse.json({ error: '작업을 찾을 수 없습니다' }, { status: 404 });

      const catalog = loadCatalog();
      const all = tcsOfWork(work.id);
      const byId = new Map(all.map((t) => [t.id, t]));

      // 중복으로 표시한 것은 넘기지 않는다 — 기록만 남긴다
      const dupes = body.items.filter((i) => i.duplicateOf);
      for (const d of dupes) {
        setTcVerdict(d.id, 'covered', d.duplicateOf!, '사람이 중복으로 확인');
      }

      const toHand = body.items.filter((i) => !i.duplicateOf);
      const assigned = catalog
        ? assignCatalogIds(
            toHand.map((i) => ({
              id: i.id,
              category: byId.get(i.id)?.category ?? null,
              subCategory: byId.get(i.id)?.sub_category ?? null,
            })),
            catalog,
          )
        : toHand.map((i) => ({ id: i.id, catalogId: null }));

      const handed: Array<{ localId: string; catalogId: string | null }> = [];
      for (const a of assigned) {
        const t = byId.get(a.id);
        if (!t) continue;
        setTcVerdict(a.id, 'new', null, '사람이 신규로 확인 — 자동화 인계');
        if (a.catalogId) handOffTc(a.id, a.catalogId);
        handed.push({ localId: t.local_id, catalogId: a.catalogId });

        /**
         * 인계점 — 여기가 QA 작업이 테스트 자동화에 남기는 **유일한 흔적**이다.
         * 테스트 자동화는 이 finding만 보고, tc 테이블을 들여다보지 않는다.
         */
        const label = a.catalogId ?? t.local_id;
        const fp = makeFingerprint({
          runner: 'web',
          nodeId: `coverage-gap::${label}`,
          errorType: 'coverage-gap',
          message: t.steps ?? t.local_id,
        });
        upsertFinding({
          fingerprint: fp.fingerprint,
          runner: 'web',
          nodeId: label,
          kind: 'coverage-gap',
          verdictBy: 'rule',
          errorType: 'coverage-gap',
          messageNorm: fp.messageNorm,
          contractKey: a.catalogId,
          detail:
            `[QA 작업] ${work.title} — ${t.steps ?? ''} / 기대: ${t.expected ?? ''}`.slice(0, 500),
          observedAt: new Date().toISOString(),
        });
      }

      return NextResponse.json({
        ok: true,
        handed,
        markedDuplicate: dupes.length,
        catalogAvailable: Boolean(catalog),
      });
    }

    // ── 인계 미리보기 — 저장하지 않는다 ──────────────────────────────
    // 시안의 인계 행이 `TC-01 → ROUTE-014`를 **누르기 전에** 보여준다.
    // 번호는 선택 조합에 따라 순차 증가하므로 선택이 바뀔 때마다 다시 계산해야 한다.
    case 'preview': {
      const work = tcWorkBySession(body.sessionId);
      if (!work) return NextResponse.json({ error: '작업을 찾을 수 없습니다' }, { status: 404 });
      const catalog = loadCatalog();
      const byId = new Map(tcsOfWork(work.id).map((t) => [t.id, t]));
      const picked = body.ids.filter((id) => byId.has(id));

      const assigned = catalog
        ? assignCatalogIds(
            picked.map((id) => ({
              id,
              category: byId.get(id)?.category ?? null,
              subCategory: byId.get(id)?.sub_category ?? null,
            })),
            catalog,
          )
        : picked.map((id) => ({ id, catalogId: null }));

      return NextResponse.json({
        catalogAvailable: Boolean(catalog),
        items: assigned.map((a) => ({
          id: a.id,
          localId: byId.get(a.id)!.local_id,
          catalogId: a.catalogId,
        })),
      });
    }

    // ── 작업 종료 미리보기 — 코멘트 본문 + 대상 티켓 ────────────────
    case 'close-preview': {
      const work = tcWorkBySession(body.sessionId);
      if (!work) return NextResponse.json({ error: '작업을 찾을 수 없습니다' }, { status: 404 });
      const rows = tcsOfWork(work.id);
      return NextResponse.json({
        keys: extractTicketKeys(work.title, body.hintText),
        comment: buildComment({ title: work.title, tcs: rows, today: todayKst() }),
        tally: tally(rows),
        status: work.status,
      });
    }

    // ── 작업 종료 — 티켓 코멘트 등록 (외부에 쓰는 유일한 지점) ──────
    // 상태 전이는 하지 않는다. 티켓을 닫는 것은 Jira에서 사람이 직접 한다.
    case 'close': {
      const work = tcWorkBySession(body.sessionId);
      if (!work) return NextResponse.json({ error: '작업을 찾을 수 없습니다' }, { status: 404 });

      const results = body.keys.length ? await postComments(body.keys, body.body) : [];
      const failed = results.filter((r) => !r.ok);

      // 코멘트가 한 건도 성공 못 했으면 종료로 치지 않는다 — 나중에 다시 시도해야 한다
      const anyOk = results.some((r) => r.ok);
      if (anyOk || body.keys.length === 0) {
        closeTcWork(work.id, { closedAt: new Date().toISOString(), comments: results });
      }

      return NextResponse.json({
        ok: failed.length === 0,
        closed: anyOk || body.keys.length === 0,
        results,
      });
    }

    default:
      return NextResponse.json({ error: '알 수 없는 action' }, { status: 400 });
  }
}
