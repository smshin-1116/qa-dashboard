/**
 * 인수증 생성 툴 — 서버 라우트.
 *
 * 동작:
 *  - 항상: 입력 주문으로 SAP 페이로드를 합성하고 사전 점검 결과를 반환.
 *  - send=true 일 때만: 루티에 로그인(JWT) → POST /v2/sap/receipt 로 실제 전송.
 *
 * 안전장치:
 *  - 기본은 드라이런(미전송). send=true + 환경변수 ROOUTY_ALLOW_SEND='true' 둘 다여야 전송.
 *  - 시크릿(이메일/비번/토큰)은 서버에서만 사용. 클라이언트로 노출하지 않음.
 *
 * 필요한 .env.local (전송 시):
 *   ROOUTY_BASE_URL=https://<staging-or-test>   # ⚠️ 운영 금지
 *   ROOUTY_ALLOW_SEND=true
 *   # 인증 — 둘 중 하나
 *   ROOUTY_EMAIL=...  ROOUTY_PASSWORD=...        # 로그인으로 토큰 발급(권장)
 *   ROOUTY_TOKEN=...                              # 또는 직접 토큰 주입
 *   # 선택 (기본값 존재)
 *   ROOUTY_SIGNIN_PATH=/signin
 *   ROOUTY_SAP_RECEIPT_PATH=/v2/sap/receipt
 */
import { NextRequest, NextResponse } from 'next/server';
import { buildSapReceiptPayload } from '@/lib/receipt/payloadBuilder';
import { precheck } from '@/lib/receipt/matchPrecheck';
import type { BuildOptions, OrderInput } from '@/lib/receipt/types';

interface SendRequestBody {
  orders: OrderInput[];
  options?: BuildOptions;
  /** true 일 때만 실제 전송 시도 */
  send?: boolean;
}

export async function POST(req: NextRequest) {
  let body: SendRequestBody;
  try {
    body = (await req.json()) as SendRequestBody;
  } catch {
    return NextResponse.json({ error: '잘못된 요청 본문입니다.' }, { status: 400 });
  }

  const orders = Array.isArray(body.orders) ? body.orders : [];
  if (orders.length === 0) {
    return NextResponse.json({ error: '주문 데이터가 없습니다.' }, { status: 400 });
  }

  const payload = buildSapReceiptPayload(orders, body.options ?? {});
  const check = precheck(orders, payload);
  const baseUrl = process.env.ROOUTY_BASE_URL ?? null;

  // 드라이런(기본): 페이로드 + 점검 결과만 반환, 네트워크 호출 없음
  if (!body.send) {
    return NextResponse.json({ mode: 'dry-run', baseUrl, payload, precheck: check });
  }

  // 전송 가드
  if (process.env.ROOUTY_ALLOW_SEND !== 'true') {
    return NextResponse.json(
      { error: '전송이 비활성화되어 있습니다. .env.local 에 ROOUTY_ALLOW_SEND=true 를 설정하세요.', precheck: check },
      { status: 403 },
    );
  }
  if (!baseUrl) {
    return NextResponse.json({ error: 'ROOUTY_BASE_URL 이 설정되지 않았습니다.' }, { status: 500 });
  }
  if (!check.ok) {
    return NextResponse.json(
      { error: '사전 점검 오류가 있어 전송을 중단했습니다.', precheck: check },
      { status: 422 },
    );
  }

  try {
    const token = await resolveToken(baseUrl);
    const path = process.env.ROOUTY_SAP_RECEIPT_PATH ?? '/v2/sap/receipt';
    const res = await fetch(joinUrl(baseUrl, path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: `전송 실패 (${res.status})`, response: json, precheck: check },
        { status: 502 },
      );
    }
    return NextResponse.json({ mode: 'sent', baseUrl, response: json, precheck: check });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `전송 중 오류: ${msg}`, precheck: check }, { status: 500 });
  }
}

/** ROOUTY_TOKEN 직접 주입 우선, 없으면 이메일/비번으로 로그인해 토큰 발급 */
async function resolveToken(baseUrl: string): Promise<string> {
  const direct = process.env.ROOUTY_TOKEN;
  if (direct) return direct;

  const email = process.env.ROOUTY_EMAIL;
  const password = process.env.ROOUTY_PASSWORD;
  if (!email || !password) {
    throw new Error('인증 정보 없음 — ROOUTY_TOKEN 또는 ROOUTY_EMAIL/ROOUTY_PASSWORD 필요');
  }
  const signinPath = process.env.ROOUTY_SIGNIN_PATH ?? '/signin';
  const res = await fetch(joinUrl(baseUrl, signinPath), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
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

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}
