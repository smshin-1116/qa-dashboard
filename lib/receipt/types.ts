/**
 * 인수증 생성 툴 — 입력/출력 타입.
 *
 * 핵심 원칙: 실제 SAP 연동 없이, 배차확정된 루티 주문 데이터로 SAP 거래명세서
 * 페이로드(STANDARD_PRICED)를 "역합성"한다. 차량/납품처/주문/품목/수량 필드를
 * 루티 데이터에서 그대로 끌어오므로 백엔드의 3대 매칭 검증이 구성상 자동 통과한다.
 *
 * 매칭 계약 (wemeet-b2b-backend 기준):
 *  - 차량:   [LIFNR, EXTI1, SIGNI] 공백결합 == driver.name
 *  - 납품처: LINE2 == master_order.consigneeName, LINE3 == master_order.address
 *  - 주문:   PRODT[].VBELN == order.client_key (배차완료 상태만 조회됨)
 *  - 품목:   MATNR == product.code, ARKTX == product.name, BXQTY == order_product.quantity
 */

/** 한 품목(라인) — 루티 order_product 1건에 대응 */
export interface ProductInput {
  /** 품목 코드 → MATNR / product.code */
  code: string;
  /** 품목명 → ARKTX / product.name (정확 일치 비교 대상이라 가공 금지) */
  name: string;
  /** 수량(박스) → BXQTY / order_product.quantity */
  quantity: number;
  /** 단가 → NETPR. 미지정 시 샘플 단가 자동 생성 (검증 대상 아님, PDF에만 인쇄) */
  unitPrice?: number;
  /** 금액 → NETWR. 미지정 시 unitPrice * quantity 로 계산 */
  amount?: number;
}

/** 주문 1건 — 루티 order 1건(= VBELN 1개)에 대응 */
export interface OrderInput {
  /** 업체 주문번호 → VBELN / order.client_key */
  clientKey: string;
  /** 납품처명 → LINE2 / master_order.consigneeName */
  consigneeName: string;
  /** 납품지 주소 → LINE3 / master_order.address */
  consigneeAddress: string;
  /** 배차확정으로 배정된 기사명 → LIFNR (driver.name 과 정확 일치) */
  driverName: string;
  products: ProductInput[];
}

/** 공급자(화주) 정보 — 헤더 필수 필드 채움용. 검증되지 않으므로 더미여도 무방. */
export interface SupplierInfo {
  /** ASTCD (사업자번호 등) */
  code: string;
  /** ASANG (공급자명) */
  name: string;
  /** AADDR (공급자 주소) */
  address: string;
}

/**
 * 거래명세서 종류(TSGUB):
 *  - STANDARD_PRICED:   일반·단가 있음 (NETPR/NETWR/TNETWR 채움)
 *  - STANDARD_UNPRICED: 일반·단가 없음 (단가 필드 빈값 "")
 *  - INTEGRATED:        통합 (PRODT2 구조 — 별도 미구현)
 */
export type Tsgub = 'STANDARD_PRICED' | 'STANDARD_UNPRICED' | 'INTEGRATED';

export interface BuildOptions {
  /** 공급자 헤더 정보 (미지정 시 기본 더미값) */
  supplier?: SupplierInfo;
  /** 거래명세서 종류. 미지정 시 STANDARD_PRICED. UNPRICED 면 단가 필드 빈값. */
  tsgub?: Tsgub;
  /** 단가 채움 전략(PRICED 일 때만 의미): 'sample' = 단가 자동 생성, 'input' = 입력값만 사용(없으면 0) */
  priceMode?: 'sample' | 'input';
  /** TSKEY/TKNUM 생성용 기준일 (YYYYMMDD). 미지정 시 호출 시점 날짜. */
  baseDate?: string;
  /**
   * TSKEY/TKNUM 충돌 방지용 시드(같은 호출 내 그룹 순번에 더해짐).
   * 미지정 시 서버 라우트가 요청 시각 기반 값으로 채워 매 전송마다 새 TSKEY 를 발급한다
   * (동일 TSKEY 재전송은 백엔드 AlreadyIssuedFilter 가 차단됨).
   */
  seed?: number;
}

/** SAP PRODT1 내부 제품 entry (수신 스키마와 동일 키) */
export interface SapProdt1 {
  MATNR: string;
  ARKTX: string;
  EAN11: string;
  LFIMG: string;
  BXQTY: string;
  EAQTY: string;
  NETPR: string;
  NETWR: string;
}

/** SAP PRODT 외부 wrapping entry (VBELN + PRODT1[]) */
export interface SapProdt {
  VBELN: string;
  PRODT1: SapProdt1[];
}

/** SAP 거래명세서 헤더 1건 (= 인수증 1건). 필드 순서는 SAP 샘플과 동일. */
export interface SapReceiptEntry {
  TSKEY: string;
  TSGUB: Tsgub;
  TKNUM: string;
  LIFNR: string;
  SIGNI: string;
  EXTI1: string;
  HOCHA: string;
  ASTCD: string;
  ASANG: string;
  AADDR: string;
  WERK0: string;
  WERKS: string;
  ADAEP: string;
  KUNNR: string;
  DNAME: string;
  CSTCD: string;
  CSANG: string;
  CADDR: string;
  CDAEP: string;
  TELNO: string;
  LINE1: string;
  LINE2: string;
  LINE3: string;
  LINE4: string;
  LINE5: string;
  LINE6: string;
  LINE7: string;
  LINE8: string;
  TLFIMG: string;
  TBXQTY: string;
  TEAQTY: string;
  TNETWR: string;
  TNETWR2: string;
  TNETWR3: string;
  TBUGA3: string;
  TAMT3: string;
  BMAMT: string;
  CMAMT: string;
  LHAMT: string;
  CHAMT: string;
  CHPNT: string;
  PRODT: SapProdt[];
  PRODT2: never[];
}

/** /v2/sap/receipt 요청 본문 */
export interface SapReceiptPayload {
  TYPE: 'create';
  DATA: SapReceiptEntry[];
}
