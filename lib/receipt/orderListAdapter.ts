/**
 * 루티 `GET /order/list` 응답 → 인수증 툴 OrderInput[] 변환 (순수 함수).
 *
 * order/list 한 건은 배차 결과를 그대로 담는다(코드 근거: wemeet-b2b-backend
 * src/router/order/index.js handleOrderList select):
 *   - clientKey                      → VBELN
 *   - consigneeName / address        → LINE2 / LINE3
 *   - orderRoute.driver.name         → LIFNR (배정 기사 — 자동)
 *   - orderProducts[].product.code   → MATNR
 *   - orderProducts[].product.name   → ARKTX
 *   - orderProducts[].quantity       → BXQTY
 *
 * 주의: Sequelize 직렬화 시 연관 alias 대소문자/키가 환경에 따라 다를 수 있어
 * (driver|Driver, product|Product, orderRoute|OrderRoute 등) 모두 방어적으로 읽는다.
 * 또 응답 envelope({success,data:{...}} 등)도 다양한 위치를 탐색한다.
 */
import type { OrderInput, ProductInput } from './types';

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

/** 객체에서 후보 키들 중 처음 존재하는 값을 꺼낸다 (대소문자 변형 대응) */
function pick(o: Obj | null, ...keys: string[]): unknown {
  if (!o) return undefined;
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function asNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * order/list 응답에서 주문 배열을 추출한다.
 * 흔한 envelope: 배열 직접 / {data:[...]} / {data:{orders|list|rows|content:[...]}} / {orders:[...]}.
 */
export function extractOrderArray(resp: unknown): unknown[] {
  if (Array.isArray(resp)) return resp;
  const root = asObj(resp);
  if (!root) return [];
  const data = root.data !== undefined ? root.data : root;
  if (Array.isArray(data)) return data;
  const d = asObj(data);
  if (!d) return [];
  for (const key of ['orders', 'list', 'rows', 'content', 'items', 'orderList']) {
    if (Array.isArray(d[key])) return d[key] as unknown[];
  }
  return [];
}

/** 응답에서 총 건수/페이지 메타 추출 (페이지네이션 루프 종료 판단용) */
export function extractTotalCount(resp: unknown): number | null {
  const root = asObj(resp);
  const data = asObj(pick(root, 'data')) ?? root;
  const v = pick(data, 'totalCount', 'total', 'totalElements', 'count');
  return v === undefined ? null : asNumber(v);
}

/** order/list 한 주문 → OrderInput (매칭 불가 주문은 호출부에서 driverName 빈값으로 걸러짐)
 *
 * 실제 /order/list 응답은 평탄화된 DTO다(코드 raw select 와 다름):
 *   driverName(최상위), product[](code/name/quantity 직접). 다른 환경 대비 중첩형도 fallback.
 */
export function adaptListOrder(raw: unknown): OrderInput {
  const o = asObj(raw) ?? {};

  // 기사: 최상위 driverName 우선, 없으면 중첩 orderRoute.driver.name
  const orderRoute = asObj(pick(o, 'orderRoute', 'OrderRoute'));
  const nestedDriver = asObj(pick(orderRoute, 'driver', 'Driver'));
  const driverName = asString(pick(o, 'driverName') ?? pick(nestedDriver, 'name'));

  // 품목: 최상위 product[] 우선(code/name/quantity 직접), 없으면 orderProducts[](중첩 product)
  const flat = pick(o, 'product', 'products');
  const nested = pick(o, 'orderProducts', 'OrderProducts');
  const productsRaw = Array.isArray(flat) ? flat : Array.isArray(nested) ? nested : [];
  const products: ProductInput[] = productsRaw.map((p) => {
    const po = asObj(p) ?? {};
    const prod = asObj(pick(po, 'product', 'Product')); // 중첩형 대비
    return {
      code: asString(pick(po, 'code') ?? pick(prod, 'code')),
      name: asString(pick(po, 'name') ?? pick(prod, 'name')),
      quantity: asNumber(pick(po, 'quantity')),
    };
  });

  return {
    clientKey: asString(pick(o, 'clientKey')),
    consigneeName: asString(pick(o, 'consigneeName')),
    consigneeAddress: asString(pick(o, 'address')),
    driverName,
    products,
  };
}

export interface AdaptListResult {
  orders: OrderInput[];
  /** 변환 요약 (UI 표시용) */
  note: string;
  /** 기사 미배정 등으로 매칭 불가 가능성이 있는 주문 수 */
  skippedDriverless: number;
}

/** order/list 주문 배열 전체 → OrderInput[] + 요약 */
export function adaptOrderList(rawOrders: unknown[]): AdaptListResult {
  const all = rawOrders.map(adaptListOrder);
  // 기사 미배정(미배차) 주문은 차량 매칭이 불가하므로 분리 카운트 (포함은 하되 경고)
  const skippedDriverless = all.filter((o) => !o.driverName.trim()).length;
  const consignees = new Set(all.map((o) => o.consigneeName));
  const drivers = new Set(all.map((o) => o.driverName).filter(Boolean));
  return {
    orders: all,
    note: `order/list ${all.length}건 → 납품처 ${consignees.size}개 · 기사 ${drivers.size}명${
      skippedDriverless ? ` · ⚠️ 기사 미배정 ${skippedDriverless}건` : ''
    }`,
    skippedDriverless,
  };
}
