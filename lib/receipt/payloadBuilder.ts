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
  code: '122-81-00804',
  name: '동서식품(주)',
  address: '인천광역시 부평구 새벌로 55 (청천동)',
};

/**
 * 샘플 데이터 기반 고정 헤더 필드 (공급자 물류센터·담당자·거래처 코드).
 * 실제 값을 받을 경로가 없어 가라로 고정한다 — 백엔드 검증 대상 아님(LINE2/LINE3만 납품처 매칭).
 * 납품처별로 달라지는 CSANG/CADDR/LINE2/LINE3 는 동적으로 채우므로 여기 없음.
 */
const FIXED_HEADER = {
  HOCHA: '01',
  WERK0: '8000',
  WERKS: '8000 부평물류센터',
  ADAEP: '김광수외1',
  KUNNR: '42128',
  DNAME: '남부 윤정상',
  CSTCD: '128-20-44565',
  // 텍스트 메타(샘플상 빈값)
  CDAEP: '',
  TELNO: '',
  LINE1: '',
  LINE4: '',
  LINE5: '',
  LINE6: '',
  LINE8: '',
};

/**
 * 단가와 무관한 합계/여신 계열 고정값 (샘플 그대로).
 * 단가 파생값(TNETWR/TNETWR3/TBUGA3/TAMT3)은 빌드 시 계산하므로 여기 없음.
 */
const FIXED_AMOUNTS = {
  TEAQTY: '0',
  TNETWR2: '0',
  BMAMT: '151,728',
  CMAMT: '151,728',
  LHAMT: '11,800,000,000',
  CHAMT: '19,850,000,000',
  CHPNT: '19,849,848,272',
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
  const tsgub = opts.tsgub ?? 'STANDARD_PRICED';
  const priced = tsgub === 'STANDARD_PRICED'; // 단가 채울지 여부 (UNPRICED 면 단가 필드 빈값)
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
    let headerLfimg = 0; // 라인(LFIMG) 합계

    const PRODT = groupOrders.map((order) => ({
      VBELN: order.clientKey,
      PRODT1: order.products.map((p) => {
        // 단가: PRICED 면 랜덤(샘플) 또는 입력값, UNPRICED 면 단가 없음(0 → 빈값 출력)
        const unitPrice = priced
          ? (p.unitPrice ?? (priceMode === 'sample' ? sampleUnitPrice(p.code) : 0))
          : 0;
        // 금액(NETWR) = 단가 × 수량 — 항상 정확히 계산 (PRICED 일 때만 출력)
        const amount = p.amount ?? unitPrice * p.quantity;
        headerBox += p.quantity;
        headerLfimg += 1;
        if (priced) headerNet += amount;
        return {
          MATNR: p.code,
          // ARKTX: 백엔드가 normalizeString(공백 제거) 후 product.name 과 비교 →
          // 의미 문자는 정확해야 하나 공백 차이는 무시됨. 원문 그대로 넣는다.
          ARKTX: p.name,
          EAN11: '',
          LFIMG: '1',
          BXQTY: String(p.quantity),
          EAQTY: '',
          // UNPRICED: 단가/금액 빈값. PRICED: 정확 계산값.
          NETPR: priced ? formatAmount(unitPrice) : '',
          NETWR: priced ? formatAmount(amount) : '',
        };
      }),
    }));

    // 단가 파생 합계 (PRICED 일 때만): 부가세 10%, 합계 110%
    const vat = Math.round(headerNet * 0.1);
    const total = headerNet + vat;

    DATA.push({
      TSKEY: tskey,
      TSGUB: tsgub,
      TKNUM: tknum,
      // 차량 매칭: LIFNR 에 기사명 전체를 넣어 driver.name 과 정확 일치 (EXTI1/SIGNI 공백 유지 — 샘플 EXTI1값 고정 금지)
      LIFNR: first.driverName,
      SIGNI: '',
      EXTI1: '',
      // 고정 헤더 (샘플값) — 공급자/물류센터/담당자/거래처 코드
      HOCHA: FIXED_HEADER.HOCHA,
      ASTCD: supplier.code,
      ASANG: supplier.name,
      AADDR: supplier.address,
      WERK0: FIXED_HEADER.WERK0,
      WERKS: FIXED_HEADER.WERKS,
      ADAEP: FIXED_HEADER.ADAEP,
      KUNNR: FIXED_HEADER.KUNNR,
      DNAME: FIXED_HEADER.DNAME,
      CSTCD: FIXED_HEADER.CSTCD,
      // 납품처별 동적 필드
      CSANG: first.consigneeName,
      CADDR: first.consigneeAddress,
      CDAEP: FIXED_HEADER.CDAEP,
      TELNO: FIXED_HEADER.TELNO,
      LINE1: FIXED_HEADER.LINE1,
      // 납품처 매칭 키
      LINE2: first.consigneeName,
      LINE3: first.consigneeAddress,
      LINE4: FIXED_HEADER.LINE4,
      LINE5: FIXED_HEADER.LINE5,
      LINE6: FIXED_HEADER.LINE6,
      LINE7: groupOrders.map((o) => o.clientKey).join(','),
      LINE8: FIXED_HEADER.LINE8,
      // 수량 합계 (항상 계산)
      TLFIMG: String(headerLfimg),
      TBXQTY: String(headerBox),
      TEAQTY: FIXED_AMOUNTS.TEAQTY,
      // 단가 파생 합계: PRICED 면 계산값, UNPRICED 면 빈값
      TNETWR: priced ? formatAmount(headerNet) : '',
      TNETWR2: FIXED_AMOUNTS.TNETWR2,
      TNETWR3: priced ? formatAmount(headerNet) : '',
      TBUGA3: priced ? formatAmount(vat) : '',
      TAMT3: priced ? formatAmount(total) : '',
      // 단가 무관 합계/여신 (샘플 고정)
      BMAMT: FIXED_AMOUNTS.BMAMT,
      CMAMT: FIXED_AMOUNTS.CMAMT,
      LHAMT: FIXED_AMOUNTS.LHAMT,
      CHAMT: FIXED_AMOUNTS.CHAMT,
      CHPNT: FIXED_AMOUNTS.CHPNT,
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
