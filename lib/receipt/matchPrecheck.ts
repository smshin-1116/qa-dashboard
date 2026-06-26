/**
 * 전송 전 사전 점검 — 합성된 페이로드가 백엔드 검증을 통과할 "형태"인지 정적으로 확인한다.
 *
 * 주의: 실제 매칭은 백엔드 DB 조회로만 확정된다. 여기서 못 잡는 것:
 *  - 주문 상태: 백엔드는 status NOT IN (unassigned/deleted/canceled/skipped) 인 주문만 매칭
 *    (즉 배차확정=scheduled 이상이어야 하고, 취소·보류·미배차는 매칭 안 됨). DB 조회 필요.
 *  - 기사/납품처가 실제 루티에 등록·활성(activated)인지. DB 조회 필요.
 *  - TSKEY 가 이미 발행된 인수증과 충돌하는지(AlreadyIssuedFilter). DB 조회 필요.
 * 여기서는 통제 가능한 형태적 결함(필수 필드 누락, 단가 0, 건수 상한)만 잡는다.
 *
 * 백엔드 계약 근거: wemeet-b2b-backend src/services/epod/validation/rules/
 *   StandardRequiredFieldRule(헤더 필수필드), StandardVehicleMatchRule, StandardOrderMatchRule,
 *   ClientRegistrationClassifier(LINE2/LINE3) / DeliveryReceiptDataController(DATA ≤ 5000).
 */
import type { OrderInput, SapReceiptEntry, SapReceiptPayload } from './types';

/** STANDARD 문서가 비어있으면 안 되는 헤더 필수 필드 (StandardRequiredFieldRule) */
const REQUIRED_HEADER_FIELDS: (keyof SapReceiptEntry)[] = [
  'KUNNR', 'ASTCD', 'ASANG', 'AADDR', 'CSTCD', 'CSANG', 'CADDR', 'LINE2', 'LINE3',
];

/** 1회 요청 최대 거래명세서 건수 (DeliveryReceiptDataController Joi) */
const MAX_ENTRIES = 5000;

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

  // 건수 상한 (백엔드 Joi: DATA 1~5000)
  if (payload.DATA.length > MAX_ENTRIES) {
    issues.push({
      level: 'error',
      message: `거래명세서 ${payload.DATA.length}건 — 1회 요청 최대 ${MAX_ENTRIES}건 초과`,
    });
  }

  // 헤더 단위 형태 점검: 필수 필드 누락 / VBELN·ARKTX 누락 / 단가 0
  payload.DATA.forEach((entry) => {
    const tskey = String(entry.TSKEY ?? '').trim() || '(TSKEY 없음)';
    if (tskey === '(TSKEY 없음)') {
      issues.push({ level: 'error', message: `헤더 TSKEY 비어있음 → 멱등 키 누락` });
    }
    REQUIRED_HEADER_FIELDS.forEach((field) => {
      if (!String(entry[field] ?? '').trim()) {
        issues.push({
          level: 'error',
          message: `${tskey} 헤더 ${field} 비어있음 → STANDARD_REQUIRED_FIELD 실패`,
        });
      }
    });
    entry.PRODT.forEach((prodt) => {
      if (!String(prodt.VBELN ?? '').trim()) {
        issues.push({ level: 'error', message: `${tskey} PRODT VBELN 비어있음` });
      }
      prodt.PRODT1.forEach((line) => {
        if (!String(line.ARKTX ?? '').trim()) {
          issues.push({
            level: 'error',
            message: `${prodt.VBELN} 품목 ARKTX 비어있음 → STANDARD_REQUIRED_FIELD 실패`,
          });
        }
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
