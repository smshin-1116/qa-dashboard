'use client';

import { useState } from 'react';
import DashboardHeader from '@/components/dashboard/header/DashboardHeader';
import type { AIModel } from '@/types/session';
import type { OrderInput, Tsgub } from '@/lib/receipt/types';
import { coerceToOrderInputs } from '@/lib/receipt/orderAdapter';
import type { DriverAssignment } from '@/lib/receipt/orderAdapter';

type DriverMode = 'single' | 'roundRobin';

const SAMPLE_ORDERS: OrderInput[] = [
  {
    clientKey: '95664437',
    consigneeName: '42107 쿠팡(주)-시흥2',
    consigneeAddress: '경기 시흥시 만해로 43',
    driverName: '홍길동',
    products: [
      { code: '1255', name: '카누세레니티문디카페인95G', quantity: 12, unitPrice: 4500 },
      { code: '1107', name: '카누디카페인라떼405G(30T)', quantity: 90 },
    ],
  },
];

interface ApiResult {
  mode?: 'dry-run' | 'sent';
  baseUrl?: string | null;
  payload?: unknown;
  response?: unknown;
  error?: string;
  adaptNote?: string | null;
  precheck?: {
    ok: boolean;
    groupCount: number;
    orderCount: number;
    issues: { level: 'error' | 'warn'; message: string }[];
  };
}

export default function ReceiptToolView() {
  const [model, setModel] = useState<AIModel>('claude');
  const [ordersText, setOrdersText] = useState(JSON.stringify(SAMPLE_ORDERS, null, 2));
  const [tsgub, setTsgub] = useState<Tsgub>('STANDARD_PRICED');
  const [priceMode, setPriceMode] = useState<'sample' | 'input'>('sample');
  const [driverMode, setDriverMode] = useState<DriverMode>('single');
  const [driverSingle, setDriverSingle] = useState('홍길동');
  const [driverList, setDriverList] = useState('홍길동, 김철수');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  // 배차에서 불러오기 (order/list 자동연동)
  const [routeKeyword, setRouteKeyword] = useState('');
  const [routeSearchItem, setRouteSearchItem] = useState<'routeCode' | 'routeName'>('routeCode');
  const [performedDate, setPerformedDate] = useState('');
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  // 다른 계정으로 동작 시 사용할 JWT (비우면 .env.local 계정)
  const [authToken, setAuthToken] = useState('');

  async function fetchFromRoute() {
    const keyword = routeKeyword.trim();
    if (!keyword) {
      setFetchNote('배차 코드 또는 주행 이름을 입력하세요.');
      return;
    }
    setFetchLoading(true);
    setFetchNote(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = { keyword, searchItem: routeSearchItem };
      if (performedDate.trim()) body.performedDate = performedDate.trim();
      if (authToken.trim()) body.token = authToken.trim();
      const res = await fetch('/api/receipt/fetch-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.error) {
        setFetchNote(`✖ ${json.error}`);
        return;
      }
      const orders = (json.orders ?? []) as OrderInput[];
      if (orders.length === 0) {
        setFetchNote('조회 결과가 없습니다. 코드/날짜를 확인하세요.');
        return;
      }
      // 불러온 주문은 기사명이 이미 채워져 있음 → 입력란에 그대로 반영
      setOrdersText(JSON.stringify(orders, null, 2));
      setFetchNote(`✓ ${json.note ?? `${orders.length}건 불러옴`} — 아래 [미리보기/점검]으로 확인하세요.`);
    } catch (e) {
      setFetchNote(`✖ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFetchLoading(false);
    }
  }

  function buildAssignment(): DriverAssignment {
    if (driverMode === 'roundRobin') {
      const drivers = driverList
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
      return { mode: 'roundRobin', drivers };
    }
    return { mode: 'single', driver: driverSingle.trim() };
  }

  async function run(send: boolean) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ordersText);
    } catch (e) {
      setResult({ error: `주문 JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }

    // orders.json 원본/OrderInput[] 모두 수용 → OrderInput[] 로 정규화 + 기사 배정
    let orders: OrderInput[];
    let adaptNote: string;
    try {
      const coerced = coerceToOrderInputs(parsed, buildAssignment());
      orders = coerced.orders;
      adaptNote = coerced.note;
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
      return;
    }

    if (send && !window.confirm('실제로 인수증을 전송합니다. 대상이 테스트 환경이 맞습니까?')) return;

    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/receipt/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders, options: { priceMode, tsgub }, send, token: authToken.trim() || undefined }),
      });
      const json = (await res.json()) as ApiResult;
      setResult({ ...json, adaptNote: json.adaptNote ?? adaptNote });
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-screen bg-[#0B0F17] text-slate-200">
      <DashboardHeader activeModel={model} onModelChange={setModel} activeWorkspaceKey="receipt" />

      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-5xl mx-auto space-y-5">
          <div>
            <h1 className="text-lg font-semibold text-slate-100">🧾 인수증 생성 툴</h1>
            <p className="text-[13px] text-slate-400 mt-1">
              배차확정 주문 데이터로 SAP 거래명세서(STANDARD_PRICED) 페이로드를 합성해 인수증을 생성합니다.
            </p>
          </div>

          {/* 안전 배너 */}
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
            ⚠️ 가라 인수증도 <b>[인수증 전송]</b>으로 실고객에게 발송될 수 있습니다. <b>반드시 테스트/스테이징 환경</b>에서만 전송하세요.
            전송은 <code className="text-amber-100">.env.local</code> 의 <code>ROOUTY_ALLOW_SEND=true</code> + 대상 <code>ROOUTY_BASE_URL</code> 설정 시에만 동작합니다.
          </div>

          {/* 계정 (인증 토큰) — 불러오기·전송 공통, 가장 먼저 정함 */}
          <section className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-4 space-y-1.5">
            <label className="text-[13px] font-medium text-sky-200">🔐 계정 (인증 토큰)</label>
            <input
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder="비우면 .env.local 계정 / JWT 입력 시 해당 계정으로 조회·전송"
              spellCheck={false}
              className="w-full text-[12px] font-mono rounded-md bg-[#0B0F17] border border-[#2A3347] px-3 py-2 text-slate-200 focus:outline-none focus:border-sky-500"
            />
            <p className="text-[12px] text-slate-500">
              {authToken.trim()
                ? '✓ 입력한 토큰 계정으로 아래 불러오기·전송이 동작합니다.'
                : '비어 있음 → .env.local 계정으로 동작. (다른 계정으로 만들려면 그 계정 JWT 입력)'}
            </p>
          </section>

          {/* 배차에서 불러오기 (order/list 자동연동) */}
          <section className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-sky-200">🔗 배차에서 불러오기</span>
              <span className="text-[12px] text-slate-500">루티 order/list 조회 → 기사·품목까지 자동 채움</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={routeSearchItem}
                onChange={(e) => setRouteSearchItem(e.target.value as 'routeCode' | 'routeName')}
                className="text-[13px] rounded-md bg-[#0B0F17] border border-[#2A3347] px-2 py-2 text-slate-200 focus:outline-none focus:border-sky-500"
              >
                <option value="routeCode">배차 코드</option>
                <option value="routeName">주행 이름</option>
              </select>
              <input
                type="text"
                value={routeKeyword}
                onChange={(e) => setRouteKeyword(e.target.value)}
                placeholder={routeSearchItem === 'routeCode' ? '예: 20260612R934538' : '예: 2026.06.12 (금) 배차 #2'}
                className="flex-1 min-w-[200px] text-[13px] rounded-md bg-[#0B0F17] border border-[#2A3347] px-3 py-2 text-slate-200 focus:outline-none focus:border-sky-500"
              />
              <input
                type="text"
                value={performedDate}
                onChange={(e) => setPerformedDate(e.target.value)}
                placeholder="주행일 YYYYMMDD-YYYYMMDD (선택)"
                className="w-[230px] text-[13px] rounded-md bg-[#0B0F17] border border-[#2A3347] px-3 py-2 text-slate-200 focus:outline-none focus:border-sky-500"
              />
              <button
                type="button"
                disabled={fetchLoading}
                onClick={fetchFromRoute}
                className="px-4 py-2 rounded-md bg-sky-600 hover:bg-sky-500 text-[13px] text-white disabled:opacity-50"
              >
                {fetchLoading ? '불러오는 중…' : '불러오기'}
              </button>
            </div>
            {fetchNote && (
              <div className={`text-[12px] ${fetchNote.startsWith('✖') ? 'text-rose-300' : 'text-sky-300'}`}>
                {fetchNote}
              </div>
            )}
            <p className="text-[12px] text-slate-500">
              불러오면 아래 입력란이 자동 채워지고, 기사명은 배차 결과에서 가져오므로 별도 지정이 필요 없습니다.
            </p>
          </section>

          {/* 입력 */}
          <section className="rounded-lg border border-[#1E2535] bg-[#0F1520] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-[13px] font-medium text-slate-300">주문 데이터 (OrderInput[])</label>
              <button
                type="button"
                onClick={() => setOrdersText(JSON.stringify(SAMPLE_ORDERS, null, 2))}
                className="text-[12px] text-indigo-400 hover:text-indigo-300"
              >
                샘플 채우기
              </button>
            </div>
            <textarea
              value={ordersText}
              onChange={(e) => setOrdersText(e.target.value)}
              spellCheck={false}
              className="w-full h-72 font-mono text-[12px] leading-relaxed rounded-md bg-[#0B0F17] border border-[#2A3347] p-3 text-slate-200 focus:outline-none focus:border-indigo-500"
            />
            <p className="text-[12px] text-slate-500 -mt-1">
              루티 <code className="text-slate-400">orders.json</code> 원본(<code>{'{type, data[]}'}</code>)을 그대로 붙여넣어도 됩니다 — 기사명만 아래에서 지정하세요.
            </p>
            <p className="text-[12px] text-slate-500">
              ℹ️ 주문은 <b>배차된 상태(scheduled 이상)</b>여야 매칭됩니다 — 미배차·취소·보류·삭제 주문은 백엔드에서 매칭 제외됩니다. 기사·납품처도 루티에 <b>등록·활성</b> 상태여야 합니다(이 조건은 전송 후 서버에서만 확인 가능).
            </p>

            {/* 기사 배정 — orders.json 엔 기사가 없으므로 별도 지정 (차량 매칭 키) */}
            <div className="space-y-2 border-t border-[#1E2535] pt-3">
              <div className="flex items-center gap-4 text-[13px]">
                <span className="text-slate-400">기사 배정:</span>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={driverMode === 'single'} onChange={() => setDriverMode('single')} />
                  단일 기사
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={driverMode === 'roundRobin'} onChange={() => setDriverMode('roundRobin')} />
                  납품처별 순환
                </label>
              </div>
              {driverMode === 'single' ? (
                <input
                  type="text"
                  value={driverSingle}
                  onChange={(e) => setDriverSingle(e.target.value)}
                  placeholder="배차확정에서 배정된 기사명 (driver.name 과 정확 일치)"
                  className="w-full text-[13px] rounded-md bg-[#0B0F17] border border-[#2A3347] px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              ) : (
                <input
                  type="text"
                  value={driverList}
                  onChange={(e) => setDriverList(e.target.value)}
                  placeholder="기사명 쉼표 구분 (예: 홍길동, 김철수) — 납품처 단위로 순환 배정"
                  className="w-full text-[13px] rounded-md bg-[#0B0F17] border border-[#2A3347] px-3 py-2 text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              )}
              <p className="text-[12px] text-slate-500">
                ⚠️ 기사명은 루티에 등록된 <b>driver.name</b> 과 정확히 일치해야 차량 매칭이 통과합니다.
              </p>
            </div>

            {/* 거래명세서 종류(TSGUB) */}
            <div className="flex items-center gap-3 text-[13px] border-t border-[#1E2535] pt-3">
              <span className="text-slate-400">인수증 종류(TSGUB):</span>
              <select
                value={tsgub}
                onChange={(e) => setTsgub(e.target.value as Tsgub)}
                className="text-[13px] rounded-md bg-[#0B0F17] border border-[#2A3347] px-2 py-2 text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="STANDARD_PRICED">단가 있음 (STANDARD_PRICED)</option>
                <option value="STANDARD_UNPRICED">단가 없음 (STANDARD_UNPRICED)</option>
                <option value="INTEGRATED" disabled>통합 (INTEGRATED) — 추후</option>
              </select>
              <span className="text-[12px] text-slate-500">
                {tsgub === 'STANDARD_UNPRICED' ? '단가/금액 필드를 빈값으로 생성' : '단가 랜덤 + 금액 정확 계산'}
              </span>
            </div>

            {/* 단가 채움 — PRICED 일 때만 의미 */}
            <div className="flex items-center gap-4 text-[13px]">
              <span className={tsgub === 'STANDARD_PRICED' ? 'text-slate-400' : 'text-slate-600'}>단가 채움:</span>
              <label className={`flex items-center gap-1.5 ${tsgub === 'STANDARD_PRICED' ? 'cursor-pointer' : 'opacity-40'}`}>
                <input
                  type="radio"
                  disabled={tsgub !== 'STANDARD_PRICED'}
                  checked={priceMode === 'sample'}
                  onChange={() => setPriceMode('sample')}
                />
                샘플 자동 생성
              </label>
              <label className={`flex items-center gap-1.5 ${tsgub === 'STANDARD_PRICED' ? 'cursor-pointer' : 'opacity-40'}`}>
                <input
                  type="radio"
                  disabled={tsgub !== 'STANDARD_PRICED'}
                  checked={priceMode === 'input'}
                  onChange={() => setPriceMode('input')}
                />
                입력값 사용
              </label>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                disabled={loading}
                onClick={() => run(false)}
                className="px-4 py-2 rounded-md bg-[#1E2535] hover:bg-[#28324a] text-[13px] text-slate-100 disabled:opacity-50"
              >
                ① 미리보기 / 점검
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => run(true)}
                className="px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-[13px] text-white disabled:opacity-50"
              >
                ② /v2/sap/receipt 전송
              </button>
              {loading && <span className="text-[13px] text-slate-400">처리 중…</span>}
            </div>
          </section>

          {/* 결과 */}
          {result && (
            <section className="rounded-lg border border-[#1E2535] bg-[#0F1520] p-4 space-y-3">
              {result.error && (
                <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-200">
                  ✖ {result.error}
                </div>
              )}
              {result.mode && (
                <div className="text-[13px] text-slate-300">
                  모드: <b>{result.mode === 'dry-run' ? '드라이런(미전송)' : '전송 완료'}</b>
                  {result.baseUrl && <span className="text-slate-500"> · 대상 {result.baseUrl}</span>}
                </div>
              )}
              {result.adaptNote && (
                <div className="text-[13px] text-sky-300">↳ {result.adaptNote}</div>
              )}
              {result.precheck && (
                <div className="text-[13px]">
                  <div className="text-slate-300">
                    그룹(인수증) {result.precheck.groupCount}건 · 주문 {result.precheck.orderCount}건 ·{' '}
                    {result.precheck.ok ? (
                      <span className="text-emerald-400">점검 통과</span>
                    ) : (
                      <span className="text-rose-400">오류 있음</span>
                    )}
                  </div>
                  {result.precheck.issues.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {result.precheck.issues.map((it, i) => (
                        <li key={i} className={it.level === 'error' ? 'text-rose-300' : 'text-amber-300'}>
                          {it.level === 'error' ? '✖' : '⚠'} {it.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {Boolean(result.payload || result.response) && (
                <pre className="max-h-96 overflow-auto rounded-md bg-[#0B0F17] border border-[#2A3347] p-3 text-[11px] font-mono text-slate-300">
                  {JSON.stringify(result.response ?? result.payload, null, 2)}
                </pre>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
