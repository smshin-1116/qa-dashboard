/**
 * 실제 루티 orders.json → 인수증 툴 OrderInput[] 변환기 (순수 함수).
 *
 * 표준 입력 파일은 `{ type: 'update' | 'create', data: RawOrder[] }` 형태이며,
 * 필드명이 OrderInput 과 다르고(`address`/`product[]`) 기사 정보가 없다.
 * 이 모듈이 그 차이를 흡수한다:
 *   - address        → consigneeAddress (LINE3 매칭 키)
 *   - product[]      → products[]       (code/name/quantity)
 *   - driverName     → 입력에 없으므로 DriverAssignment 로 별도 주입 (차량 매칭 키)
 *
 * 기사 매칭(LIFNR == driver.name)은 실제 배차확정에서 배정된 기사명과 정확히
 * 일치해야 하므로, 어떤 기사명을 넣을지는 호출자가 명시적으로 정한다.
 */
import type { OrderInput, ProductInput } from './types';

/** orders.json 한 품목 — 매핑에 쓰는 필드만 선언, 나머지는 무시 */
export interface RawProduct {
  code: string;
  name: string;
  quantity: number;
  [extra: string]: unknown;
}

/** orders.json 한 주문(data[] 1건) */
export interface RawOrder {
  clientKey: string;
  consigneeName: string;
  address: string;
  detailAddress?: string;
  product: RawProduct[];
  [extra: string]: unknown;
}

/** orders.json 전체 파일 */
export interface RawOrdersFile {
  type?: string;
  data: RawOrder[];
}

/**
 * 기사 배정 전략 — orders.json 에 기사가 없으므로 외부에서 주입한다.
 *  - single:      모든 주문에 같은 기사 → 인수증은 (납품처+주소) 단위로 통합됨
 *  - roundRobin:  납품처 단위로 기사 목록을 순환 배정 (납품처별로 다른 기사 묶음)
 *  - byConsignee: 납품처명 → 기사명 명시 매핑 (없으면 fallback)
 */
export type DriverAssignment =
  | { mode: 'single'; driver: string }
  | { mode: 'roundRobin'; drivers: string[] }
  | { mode: 'byConsignee'; map: Record<string, string>; fallback?: string };

/** 입력 파싱 결과가 raw orders.json 형태인지 판별 */
export function isRawOrdersFile(value: unknown): value is RawOrdersFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { data?: unknown }).data)
  );
}

/** 입력 파싱 결과가 이미 OrderInput[] 형태인지 판별 */
export function isOrderInputArray(value: unknown): value is OrderInput[] {
  return (
    Array.isArray(value) &&
    (value.length === 0 ||
      (typeof value[0] === 'object' && value[0] !== null && 'products' in value[0]))
  );
}

/**
 * 납품처명 목록(등장 순서, 중복 제거) 기준으로 기사명을 결정하는 함수를 만든다.
 * roundRobin 은 "같은 납품처 = 같은 기사"가 되도록 납품처 단위로 순환한다.
 */
function makeDriverResolver(
  orders: RawOrder[],
  assignment: DriverAssignment,
): (o: RawOrder) => string {
  if (assignment.mode === 'single') {
    const d = assignment.driver;
    return () => d;
  }
  if (assignment.mode === 'byConsignee') {
    const { map, fallback } = assignment;
    return (o) => map[o.consigneeName] ?? fallback ?? '';
  }
  // roundRobin: 등장 순서대로 고유 납품처에 기사 순환 배정
  const drivers = assignment.drivers.filter((d) => d.trim() !== '');
  const consigneeToDriver = new Map<string, string>();
  let next = 0;
  for (const o of orders) {
    if (!consigneeToDriver.has(o.consigneeName) && drivers.length > 0) {
      consigneeToDriver.set(o.consigneeName, drivers[next % drivers.length]);
      next += 1;
    }
  }
  return (o) => consigneeToDriver.get(o.consigneeName) ?? '';
}

export interface AdaptOptions {
  /** address 에 detailAddress 를 붙여 LINE3 로 사용할지 (기본 false: master_order.address 와 일치 우선) */
  appendDetailAddress?: boolean;
}

/** raw orders.json 한 주문을 OrderInput 으로 변환 */
function adaptOne(
  raw: RawOrder,
  driver: string,
  opts: AdaptOptions,
): OrderInput {
  const products: ProductInput[] = (raw.product ?? []).map((p) => ({
    code: p.code,
    name: p.name,
    quantity: p.quantity,
  }));
  const address =
    opts.appendDetailAddress && raw.detailAddress
      ? `${raw.address} ${raw.detailAddress}`.trim()
      : raw.address;
  return {
    clientKey: raw.clientKey,
    consigneeName: raw.consigneeName,
    consigneeAddress: address,
    driverName: driver,
    products,
  };
}

/** orders.json 전체를 OrderInput[] 로 변환 (기사 배정 주입) */
export function adaptRawOrders(
  file: RawOrdersFile,
  assignment: DriverAssignment,
  opts: AdaptOptions = {},
): OrderInput[] {
  const orders = Array.isArray(file.data) ? file.data : [];
  const resolveDriver = makeDriverResolver(orders, assignment);
  return orders.map((o) => adaptOne(o, resolveDriver(o), opts));
}

export interface CoerceResult {
  orders: OrderInput[];
  /** 입력 형태 감지 결과 */
  source: 'orderInput' | 'rawOrders';
  /** 사람이 읽을 변환 요약 (UI 표시용) */
  note: string;
}

/**
 * 임의의 파싱 결과(원본 orders.json 또는 OrderInput[])를 OrderInput[] 로 통일한다.
 *  - raw orders.json → adaptRawOrders 로 변환(기사 배정 주입)
 *  - OrderInput[]    → 그대로 사용하되, driverName 이 비어있으면 배정으로 채움
 */
export function coerceToOrderInputs(
  parsed: unknown,
  assignment: DriverAssignment,
  opts: AdaptOptions = {},
): CoerceResult {
  if (isRawOrdersFile(parsed)) {
    const orders = adaptRawOrders(parsed, assignment, opts);
    const uniqueDrivers = new Set(orders.map((o) => o.driverName).filter(Boolean));
    const uniqueConsignees = new Set(orders.map((o) => o.consigneeName));
    return {
      orders,
      source: 'rawOrders',
      note: `orders.json ${orders.length}건 → 납품처 ${uniqueConsignees.size}개 · 기사 ${uniqueDrivers.size}명 배정`,
    };
  }

  if (isOrderInputArray(parsed)) {
    const resolveDriver = (() => {
      // OrderInput 은 RawOrder 형태가 아니므로 single/byConsignee 만 의미 있음.
      if (assignment.mode === 'single') return () => assignment.driver;
      if (assignment.mode === 'byConsignee') {
        return (o: OrderInput) => assignment.map[o.consigneeName] ?? assignment.fallback ?? '';
      }
      return null; // roundRobin 은 OrderInput[] 직접 입력 시 미적용
    })();

    const orders = parsed.map((o) => ({
      ...o,
      driverName: o.driverName?.trim() ? o.driverName : resolveDriver ? resolveDriver(o) : o.driverName,
    }));
    return {
      orders,
      source: 'orderInput',
      note: `OrderInput ${orders.length}건 (직접 입력)`,
    };
  }

  throw new Error('입력이 orders.json({type,data[]}) 또는 OrderInput[] 형태가 아닙니다.');
}
