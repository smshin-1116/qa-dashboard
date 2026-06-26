/**
 * 배차확정 주문 데이터 → SAP 거래명세서(STANDARD_PRICED) 페이로드 합성기 (순수 함수).
 *
 * 그룹핑: (기사명 + 납품처명 + 납품지주소) 단위로 1 헤더(= 1 인수증)를 만든다.
 *   한 헤더의 PRODT 는 그 그룹의 주문(VBELN)들, PRODT1 은 각 주문의 품목들.
 *
 * UI/스크립트/테스트 어디서든 재사용. 네트워크/환경 의존 없음.
 */
import type {
  BuildOptions,
  OrderInput,
  SapReceiptEntry,
  SapReceiptPayload,
  SupplierInfo,
} from './types';

const DEFAULT_SUPPLIER: SupplierInfo = {
  code: '000-00-00000',
  name: 'QA 테스트 공급자',
  address: '테스트 주소',
};

/** 천단위 콤마 포맷 (SAP 원본 표기와 동일하게 문자열로 보관) */
function formatAmount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 코드 문자열에서 안정적인 샘플 단가 산출 (재현 가능, 1,000~50,000 범위) */
function sampleUnitPrice(code: string): number {
  let h = 0;
  for (let i = 0; i < code.length; i += 1) h = (h * 31 + code.charCodeAt(i)) % 50000;
  return 1000 + (h % 49) * 1000;
}

function groupKey(o: OrderInput): string {
  return `${o.driverName}||${o.consigneeName}||${o.consigneeAddress}`;
}

/**
 * 주문 목록을 SAP 페이로드로 합성한다.
 * @param orders 배차확정된 주문(품목 포함)
 * @param opts   공급자/단가전략/기준일/시드
 */
export function buildSapReceiptPayload(
  orders: OrderInput[],
  opts: BuildOptions = {},
): SapReceiptPayload {
  const supplier = opts.supplier ?? DEFAULT_SUPPLIER;
  const priceMode = opts.priceMode ?? 'sample';
  const baseDate = opts.baseDate ?? toYyyymmdd(new Date());
  const seed = opts.seed ?? 0;

  // (기사+납품처) 단위 그룹핑
  const groups = new Map<string, OrderInput[]>();
  for (const o of orders) {
    const k = groupKey(o);
    const list = groups.get(k);
    if (list) list.push(o);
    else groups.set(k, [o]);
  }

  const DATA: SapReceiptEntry[] = [];
  let idx = 0;
  for (const [, groupOrders] of groups) {
    idx += 1;
    const first = groupOrders[0];

    // TKNUM: 기준일 + 그룹 순번 기반 의사난수. TSKEY: 기준일 + TKNUM + 시드(유니크).
    const tknum = String(4_000_000 + ((seed + idx) * 7919) % 5_999_999);
    const tskey = `${baseDate}${tknum}${String(seed + idx).padStart(4, '0')}`;

    let headerBox = 0;
    let headerNet = 0;

    const PRODT = groupOrders.map((order) => ({
      VBELN: order.clientKey,
      PRODT1: order.products.map((p) => {
        const unitPrice =
          p.unitPrice ?? (priceMode === 'sample' ? sampleUnitPrice(p.code) : 0);
        const amount = p.amount ?? unitPrice * p.quantity;
        headerBox += p.quantity;
        headerNet += amount;
        return {
          MATNR: p.code,
          // ARKTX: 백엔드가 normalizeString(공백 제거) 후 product.name 과 비교 →
          // 의미 문자는 정확해야 하나 공백 차이는 무시됨. 원문 그대로 넣는다.
          ARKTX: p.name,
          EAN11: '',
          LFIMG: '1',
          BXQTY: String(p.quantity),
          EAQTY: '',
          NETPR: formatAmount(unitPrice),
          NETWR: formatAmount(amount),
        };
      }),
    }));

    DATA.push({
      TSKEY: tskey,
      TSGUB: 'STANDARD_PRICED',
      TKNUM: tknum,
      // 차량 매칭: LIFNR 에 기사명 전체를 넣어 driver.name 과 정확 일치 (EXTI1/SIGNI 공백)
      LIFNR: first.driverName,
      EXTI1: '',
      SIGNI: '',
      // 헤더 필수 필드 (검증되지 않으므로 더미 허용, 단 비어있으면 안 됨)
      KUNNR: 'QA00000',
      ASTCD: supplier.code,
      ASANG: supplier.name,
      AADDR: supplier.address,
      CSTCD: 'QA00000',
      CSANG: first.consigneeName,
      CADDR: first.consigneeAddress,
      // 납품처 매칭 키
      LINE2: first.consigneeName,
      LINE3: first.consigneeAddress,
      LINE7: groupOrders.map((o) => o.clientKey).join(','),
      TBXQTY: String(headerBox),
      TNETWR: formatAmount(headerNet),
      TNETWR3: formatAmount(headerNet),
      PRODT,
      PRODT2: [],
    });
  }

  return { TYPE: 'create', DATA };
}

function toYyyymmdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
