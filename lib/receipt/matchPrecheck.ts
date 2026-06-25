/**
 * 전송 전 사전 점검 — 합성된 페이로드가 백엔드 검증을 통과할 "형태"인지 정적으로 확인한다.
 *
 * 주의: 실제 매칭(주문/차량/납품처 등록 여부)은 백엔드 DB 조회로만 확정된다.
 * 여기서는 우리가 통제 가능한 형태적 결함(필수 필드 누락, 단가 0, 그룹 요약)만 잡는다.
 */
import type { OrderInput, SapReceiptPayload } from './types';

export interface PrecheckIssue {
  level: 'error' | 'warn';
  message: string;
}

export interface PrecheckResult {
  ok: boolean;
  groupCount: number;
  orderCount: number;
  issues: PrecheckIssue[];
}

export function precheck(orders: OrderInput[], payload: SapReceiptPayload): PrecheckResult {
  const issues: PrecheckIssue[] = [];

  orders.forEach((o, i) => {
    if (!o.clientKey) issues.push({ level: 'error', message: `주문[${i}] clientKey(VBELN) 누락` });
    if (!o.driverName) issues.push({ level: 'error', message: `주문[${i}] 기사명 누락 → 차량 매칭 실패` });
    if (!o.consigneeName) issues.push({ level: 'error', message: `주문[${i}] 납품처명(LINE2) 누락` });
    if (!o.consigneeAddress) issues.push({ level: 'error', message: `주문[${i}] 납품지주소(LINE3) 누락` });
    if (!o.products || o.products.length === 0) {
      issues.push({ level: 'error', message: `주문[${i}] 품목 없음` });
    }
    o.products?.forEach((p, j) => {
      if (!p.code) issues.push({ level: 'error', message: `주문[${i}] 품목[${j}] code(MATNR) 누락` });
      if (!p.name) issues.push({ level: 'error', message: `주문[${i}] 품목[${j}] name(ARKTX) 누락` });
      if (!p.quantity || p.quantity <= 0) {
        issues.push({ level: 'warn', message: `주문[${i}] 품목[${j}] 수량이 0 이하` });
      }
    });
  });

  // 단가 0 경고 (PDF에 0원으로 인쇄됨)
  payload.DATA.forEach((entry) => {
    entry.PRODT.forEach((prodt) => {
      prodt.PRODT1.forEach((line) => {
        const net = Number(line.NETPR.replace(/,/g, ''));
        if (!net) {
          issues.push({ level: 'warn', message: `${prodt.VBELN} / ${line.MATNR} 단가 0 — PDF에 0원 인쇄` });
        }
      });
    });
  });

  return {
    ok: issues.every((x) => x.level !== 'error'),
    groupCount: payload.DATA.length,
    orderCount: orders.length,
    issues,
  };
}
