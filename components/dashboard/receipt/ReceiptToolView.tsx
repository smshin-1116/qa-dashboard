'use client';

import { useState } from 'react';
import DashboardHeader from '@/components/dashboard/header/DashboardHeader';
import type { AIModel } from '@/types/session';
import type { OrderInput } from '@/lib/receipt/types';

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
  const [priceMode, setPriceMode] = useState<'sample' | 'input'>('sample');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);

  async function run(send: boolean) {
    let orders: OrderInput[];
    try {
      orders = JSON.parse(ordersText);
      if (!Array.isArray(orders)) throw new Error('배열이어야 합니다');
    } catch (e) {
      setResult({ error: `주문 JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    if (send && !window.confirm('실제로 인수증을 전송합니다. 대상이 테스트 환경이 맞습니까?')) return;

    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/receipt/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders, options: { priceMode }, send }),
      });
      setResult((await res.json()) as ApiResult);
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
            <div className="flex items-center gap-4 text-[13px]">
              <span className="text-slate-400">단가 채움:</span>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" checked={priceMode === 'sample'} onChange={() => setPriceMode('sample')} />
                샘플 자동 생성
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" checked={priceMode === 'input'} onChange={() => setPriceMode('input')} />
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
