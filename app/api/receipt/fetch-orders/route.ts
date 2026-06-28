/**
 * 배차 코드(routeCode)로 루티 order/list 를 조회해 OrderInput[] 로 변환하는 서버 라우트.
 * 인수증 툴 자동연동의 입력 단계 — 이 결과를 그대로 /api/receipt/send 에 넣으면 된다.
 *
 * 동작:
 *  - resolveToken(로그인/토큰) → order/list 페이지네이션 조회 → OrderInput[] 변환.
 *  - debug=true 면 변환 없이 첫 페이지 원본 JSON 을 반환(응답 envelope/연관키 확인용).
 *
 * 필요한 .env.local:
 *   ROOUTY_BASE_URL=https://<staging>          # ⚠️ 운영 금지
 *   ROOUTY_EMAIL=... ROOUTY_PASSWORD=...        # 또는 ROOUTY_TOKEN=...
 *   ROOUTY_ORDER_LIST_PATH=/order/list          # 선택(기본값 존재)
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  resolveToken,
  fetchOrderListPage,
  fetchOrderListRaw,
  fetchEpodReceiptListRaw,
  signinRaw,
} from '@/lib/receipt/rooutyClient';
import { adaptOrderList, extractOrderArray, extractTotalCount } from '@/lib/receipt/orderListAdapter';

interface FetchRequestBody {
  /** 검색어 — 주행 이름(기본) 또는 배차 코드 */
  keyword?: string;
  /** 검색 대상 (기본 routeName) */
  searchItem?: 'routeName' | 'routeCode';
  /** YYYYMMDD-YYYYMMDD (선택) */
  performedDate?: string;
  /** true 면 변환 없이 첫 페이지 원본 반환 */
  debug?: boolean;
  /** true 면 로그인 응답 "구조"만(값 redact) 반환 — 토큰 필드 위치 확인용 */
  debugAuth?: boolean;
  /** true 면 인수증 조회 API 로 실제 생성 여부 확인 (date=YYYY-MM-DD createdAt 기준) */
  probeReceipts?: boolean;
  /** probeReceipts 의 createdAt 기준일 (YYYY-MM-DD) */
  date?: string;
  /** probeReceipts 에서 인수증 list 에 그대로 넘길 쿼리(UI 필터 재현용) */
  query?: Record<string, string>;
}

/** 긴 문자열(토큰 등)은 가리고 구조만 보이게 재귀 redact */
function redactStructure(v: unknown, depth = 0): unknown {
  if (depth > 6) return '<deep>';
  if (typeof v === 'string') return v.length > 16 ? `<string len=${v.length}>` : v;
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => redactStructure(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactStructure(val, depth + 1);
    }
    return out;
  }
  return v; // number/boolean/null
}

export async function POST(req: NextRequest) {
  let body: FetchRequestBody;
  try {
    body = (await req.json()) as FetchRequestBody;
  } catch {
    return NextResponse.json({ error: '잘못된 요청 본문입니다.' }, { status: 400 });
  }

  const baseUrl = process.env.ROOUTY_BASE_URL ?? null;
  if (!baseUrl) {
    return NextResponse.json({ error: 'ROOUTY_BASE_URL 이 설정되지 않았습니다.' }, { status: 500 });
  }

  // 로그인 응답 구조 디버그 (토큰 위치 확인) — 본문/헤더 값은 redact
  if (body.debugAuth) {
    try {
      const { status, headers, text } = await signinRaw(baseUrl);
      let bodyStructure: unknown = text.slice(0, 60);
      try {
        bodyStructure = redactStructure(JSON.parse(text));
      } catch {
        bodyStructure = text ? `<non-json text len=${text.length}>` : '<empty body>';
      }
      // 헤더는 이름 전부 + auth 관련만 값 길이 표시(값 자체 redact)
      const headerNames = Object.keys(headers);
      const authHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (/auth|token|cookie|session|jwt|bearer/i.test(k)) {
          authHeaders[k] = v.length > 16 ? `<value len=${v.length}>` : v;
        }
      }
      return NextResponse.json({
        mode: 'debugAuth',
        signinStatus: status,
        contentType: headers['content-type'] ?? null,
        bodyPreview: text.slice(0, 120),
        headerNames,
        authHeaders,
        bodyStructure,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `로그인 디버그 실패: ${msg}` }, { status: 502 });
    }
  }

  // 인수증 실제 생성 여부 확인 (EpodReceipt list 조회)
  if (body.probeReceipts) {
    try {
      const token = await resolveToken(baseUrl);
      const date = body.date;
      let params: Record<string, string> = { pageSize: '100' };
      if (body.query && typeof body.query === 'object') {
        // UI 필터 재현용 임의 쿼리 통과
        params = { pageSize: '100', ...(body.query as Record<string, string>) };
      } else if (date) {
        params.dateField = 'createdAt';
        params.fromDate = date;
        params.toDate = date;
      }
      const { status, url, text } = await fetchEpodReceiptListRaw(baseUrl, token, params);
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = text.slice(0, 200);
      }
      // 우리가 어느 팀/회사로 호출 중인지 (JWT payload 디코드 — 검증 아님, claim 읽기만)
      let tokenClaims: Record<string, unknown> | null = null;
      try {
        const payload = token.split('.')[1];
        tokenClaims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      } catch {
        tokenClaims = null;
      }
      const root = (json && typeof json === 'object' ? (json as Record<string, unknown>) : {}) as Record<string, unknown>;
      const list = Array.isArray(root.receiptList) ? (root.receiptList as Record<string, unknown>[]) : [];
      const summary = list.map((r) => ({
        receiptId: r.receiptId,
        status: r.status,
        type: r.type,
        teamId: r.teamId,
        consigneeName: r.consigneeName,
        drivingDate: r.drivingDate,
        desiredDate: r.desiredDate,
        orderStatus: r.orderStatus,
      }));
      const countBy = (key: string) =>
        summary.reduce((acc: Record<string, number>, r) => {
          const k = String((r as Record<string, unknown>)[key] ?? 'null');
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {});
      return NextResponse.json({
        mode: 'probeReceipts',
        status,
        url: url.replace(baseUrl, '<baseUrl>'),
        tokenClaims: tokenClaims ? redactStructure(tokenClaims) : null,
        totalCount: root.totalCount,
        returned: summary.length,
        byStatus: countBy('status'),
        byType: countBy('type'),
        byTeamId: countBy('teamId'),
        byDrivingDate: countBy('drivingDate'),
        items: summary,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `인수증 조회 실패: ${msg}` }, { status: 502 });
    }
  }

  const keyword = (body.keyword ?? '').trim();
  if (!keyword) {
    return NextResponse.json({ error: '검색어(주행 이름 또는 배차 코드)가 필요합니다.' }, { status: 400 });
  }
  const searchItem = body.searchItem ?? 'routeName';

  try {
    const token = await resolveToken(baseUrl);

    // debug: 원본 응답 반환 (구조/에러 확인용)
    if (body.debug) {
      const { status, url, text } = await fetchOrderListRaw(baseUrl, token, {
        searchItem,
        keyword,
        performedDate: body.performedDate,
      });
      let raw: unknown = null;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text.slice(0, 200);
      }
      return NextResponse.json({
        mode: 'debug',
        status,
        url: url.replace(baseUrl, '<baseUrl>'),
        sampleOrderCount: status === 200 ? extractOrderArray(raw).length : null,
        totalCount: status === 200 ? extractTotalCount(raw) : null,
        raw,
      });
    }

    // ReadListOrder 는 page/size 미지원 — 단일 호출로 전체 반환
    const resp = await fetchOrderListPage(baseUrl, token, {
      searchItem,
      keyword,
      performedDate: body.performedDate,
    });
    const collected = extractOrderArray(resp);
    const total = extractTotalCount(resp);

    const result = adaptOrderList(collected);
    return NextResponse.json({
      mode: 'fetched',
      keyword,
      searchItem,
      totalCount: total,
      ...result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `조회 중 오류: ${msg}` }, { status: 502 });
  }
}
