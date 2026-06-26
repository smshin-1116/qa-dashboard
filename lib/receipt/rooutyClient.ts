/**
 * 루티 스테이징/테스트 서버 호출 공통 클라이언트 (서버 전용).
 * 시크릿(이메일/비번/토큰)은 서버에서만 사용 — 클라이언트로 노출 금지.
 *
 * ⚠️ 대상은 반드시 테스트/스테이징. ROOUTY_BASE_URL 운영 금지.
 */

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

/** ROOUTY_TOKEN 직접 주입 우선, 없으면 이메일/비번으로 로그인해 JWT 발급 */
export async function resolveToken(baseUrl: string): Promise<string> {
  const direct = process.env.ROOUTY_TOKEN;
  if (direct) return direct;

  const email = process.env.ROOUTY_EMAIL;
  const password = process.env.ROOUTY_PASSWORD;
  if (!email || !password) {
    throw new Error('인증 정보 없음 — ROOUTY_TOKEN 또는 ROOUTY_EMAIL/ROOUTY_PASSWORD 필요');
  }
  const signinPath = process.env.ROOUTY_SIGNIN_PATH ?? '/auth/signin';
  const res = await fetch(joinUrl(baseUrl, signinPath), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginAccount: email, password, loginType: 'pc' }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`로그인 실패 (${res.status})`);
  // 응답 토큰 필드는 환경마다 다를 수 있어 흔한 위치를 모두 탐색
  const token =
    json?.token ??
    json?.accessToken ??
    json?.data?.token ??
    json?.data?.accessToken ??
    json?.result?.token;
  if (!token) throw new Error('로그인 응답에서 토큰을 찾지 못했습니다. (응답 구조 확인 필요)');
  return token as string;
}

/** 로그인 원본 응답 (디버그용 — 토큰 위치 확인). 본문·헤더 모두 캡처. */
export async function signinRaw(
  baseUrl: string,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const email = process.env.ROOUTY_EMAIL;
  const password = process.env.ROOUTY_PASSWORD;
  if (!email || !password) {
    throw new Error('debugAuth 는 ROOUTY_EMAIL/ROOUTY_PASSWORD 가 필요합니다.');
  }
  const signinPath = process.env.ROOUTY_SIGNIN_PATH ?? '/auth/signin';
  const res = await fetch(joinUrl(baseUrl, signinPath), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginAccount: email, password, loginType: 'pc' }),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, headers, text };
}

export interface OrderListQuery {
  /** 검색 대상: 주행 이름(routeName, 화면 노출) 또는 배차 코드(routeCode) */
  searchItem?: 'routeName' | 'routeCode';
  /** 검색어 — 주행 이름 또는 배차 코드 값 */
  keyword: string;
  /** YYYYMMDD-YYYYMMDD (선택) */
  performedDate?: string;
  /** 기본 'all' (전체 상태). ReadListOrder 는 page/size 미지원 — 전체 반환. */
  orderStatus?: string;
}

function buildOrderListUrl(baseUrl: string, q: OrderListQuery): string {
  const path = process.env.ROOUTY_ORDER_LIST_PATH ?? '/order/list';
  const params = new URLSearchParams({
    searchItem: q.searchItem ?? 'routeName',
    keyword: q.keyword,
    orderStatus: q.orderStatus ?? 'all',
  });
  if (q.performedDate) params.set('performedDate', q.performedDate);
  return `${joinUrl(baseUrl, path)}?${params.toString()}`;
}

/** order/list 원본 조회 (디버그용 — 상태/본문 그대로, throw 안 함) */
export async function fetchOrderListRaw(
  baseUrl: string,
  token: string,
  q: OrderListQuery,
): Promise<{ status: number; url: string; text: string }> {
  const url = buildOrderListUrl(baseUrl, q);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text().catch(() => '');
  return { status: res.status, url, text };
}

/** order/list 한 페이지 조회 (응답 envelope 는 호출부에서 해석) */
export async function fetchOrderListPage(
  baseUrl: string,
  token: string,
  q: OrderListQuery,
): Promise<unknown> {
  const res = await fetch(buildOrderListUrl(baseUrl, q), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`order/list 실패 (${res.status})`);
  }
  return json;
}
