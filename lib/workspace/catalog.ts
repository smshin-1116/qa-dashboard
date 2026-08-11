import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 자동화 TC 카탈로그 (roouty-test-automation) — **읽기 전용 조회 도우미**.
 *
 * ── 이 모듈의 역할은 "판정"이 아니라 "검색"이다 ───────────────────────
 * 자동화할지 말지는 **사람이 정한다**(반복 검증 가치가 있나 / 1회성인가).
 * 여기가 하는 일은 넘기기 직전에 "혹시 이미 있나?"를 찾아주는 것뿐이다.
 * 유사도는 **정렬 순서**로만 쓰고, 잘라내지 않는다 — 사람이 목록을 직접 본다.
 *
 * ── 독립성 (2026-08-10 결정) ──────────────────────────────────────────
 * QA 작업은 카탈로그를 몰라도 완결되어야 한다(분석 → TC → 수행).
 * 그래서 이 모듈은 **절대 throw하지 않는다.** 파일이 없거나 깨지면 null을 돌려주고,
 * 화면은 "카탈로그 없음"만 표시한 뒤 나머지 기능을 정상 진행한다.
 *
 * ── 하드코딩 금지 ─────────────────────────────────────────────────────
 * 카탈로그는 살아있는 데이터다 — 2026-07-31 89건 → 08-05 90건으로 닷새 만에 변했고,
 * 그때 시안에 박아둔 번호(ROUTE-013)가 실제 TC와 충돌했다. 매번 파일을 읽는다.
 * 원본은 `docs/test-catalog.md`이며 그것도 코드의 `@tc` 메타에서 생성된 투영이다.
 *
 * ── 토큰 ──────────────────────────────────────────────────────────────
 * LLM 미사용. 마크다운 파싱 + 문자열 비교뿐이다.
 */

const WEB_DIR =
  process.env.WEB_E2E_DIR ?? path.join(os.homedir(), 'Projects', 'roouty-test-automation');

const CATALOG_PATH = path.join(WEB_DIR, 'docs', 'test-catalog.md');

export interface CatalogEntry {
  /** ORD-007 */
  id: string;
  /** 접두 (ORD) */
  prefix: string;
  seq: number;
  title: string;
  tier: string;
  priority: string;
  /** test_orders.py::test_order_single_delete — "아 이게 그거구나"를 돕는다 */
  impl: string;
  note: string;
  /** 소속 섹션 라벨 ("주문 관리") */
  section: string;
}

export interface Catalog {
  entries: CatalogEntry[];
  generatedAt: string | null;
  fileMtime: string;
  /** 접두별 다음 빈 번호 */
  nextSeq: Record<string, number>;
  /** 접두 → 섹션 라벨 */
  sections: Record<string, string>;
}

/** `| ORD-007 | 제목 | tier | priority | impl | note |` */
const ROW_RE = /^\|\s*([A-Z]+)-(\d{3})\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/;
/** `## 주문 관리 (orders) — 17개` */
const SECTION_RE = /^##\s+(.+?)\s*\(([a-z]+)\)\s*—/;

let cache: { at: number; value: Catalog | null } | null = null;
/** 짧게만 캐시 — 카탈로그가 바뀌면 곧 반영되어야 한다 */
const CACHE_MS = 30_000;

/**
 * 카탈로그를 읽는다. **실패하면 null** (throw하지 않는다).
 */
export function loadCatalog(force = false): Catalog | null {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  let value: Catalog | null = null;
  try {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
    const stat = fs.statSync(CATALOG_PATH);

    const entries: CatalogEntry[] = [];
    const sections: Record<string, string> = {};
    let currentSection = '';

    for (const line of raw.split('\n')) {
      const t = line.trim();
      const sec = SECTION_RE.exec(t);
      if (sec) {
        currentSection = sec[1];
        continue;
      }
      const m = ROW_RE.exec(t);
      if (!m) continue;
      const [, prefix, seqStr, title, tier, priority, impl, note] = m;
      if (!sections[prefix]) sections[prefix] = currentSection;
      entries.push({
        id: `${prefix}-${seqStr}`,
        prefix,
        seq: Number(seqStr),
        title: title.trim(),
        tier: tier.trim(),
        priority: priority.trim(),
        impl: impl.replace(/`/g, '').trim(),
        note: note.trim(),
        section: currentSection,
      });
    }

    if (entries.length === 0) throw new Error('표를 파싱하지 못했습니다');

    const nextSeq: Record<string, number> = {};
    for (const e of entries) nextSeq[e.prefix] = Math.max(nextSeq[e.prefix] ?? 0, e.seq + 1);

    value = {
      entries,
      generatedAt: raw.match(/생성:\s*([\d-]+\s[\d:]+)/)?.[1] ?? null,
      fileMtime: stat.mtime.toISOString(),
      nextSeq,
      sections,
    };
  } catch {
    value = null; // 독립성 — QA 작업을 막지 않는다
  }

  cache = { at: Date.now(), value };
  return value;
}

export function catalogPath(): string {
  return CATALOG_PATH;
}

// ─── 유사도 (정렬 전용) ───────────────────────────────────────────────

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[·・,./\\()[\]{}<>"'`~!?:;+\-—–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 문자 바이그램.
 *
 * ⚠️ 공백 토큰 비교는 한국어에서 안 먹힌다 — 조사 때문에
 * `삭제` ≠ `삭제를`, `주문` ≠ `주문이` 가 되어 실측에서 29%까지 떨어졌다.
 * 공백을 걷어내고 2글자씩 자르면 조사 영향이 크게 줄어든다.
 */
function bigrams(s: string): Set<string> {
  const t = norm(s).replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 카탈로그 제목이 TC 본문에 **얼마나 담겨 있는가**.
 *
 * 자카드(교집합/합집합)를 쓰면 안 된다 — 카탈로그 제목은 짧고
 * TC 본문은 길어서(전제+스텝+기대결과) 길이 비대칭만으로 점수가 희석된다.
 * 묻는 것은 "이 TC가 그 항목을 다루는가"이므로 **제목 쪽 커버리지**가 맞다.
 */
export function titleCoverage(title: string, text: string): number {
  const bt = bigrams(title);
  const bx = bigrams(text);
  if (bt.size === 0) return 0;
  let hit = 0;
  for (const g of bt) if (bx.has(g)) hit++;
  return hit / bt.size;
}

// ─── 카테고리 좁히기 ──────────────────────────────────────────────────

/** TC 카테고리(한국어) → 카탈로그 접두 */
const PREFIX_BY_CATEGORY: Array<{ re: RegExp; prefix: string }> = [
  { re: /배차|경로|최적화|route/i, prefix: 'ROUTE' },
  { re: /주문|order/i, prefix: 'ORD' },
  { re: /관제|모니터링|control/i, prefix: 'CTRL' },
  { re: /리포트|보고서|주행\s*내역|report/i, prefix: 'RPT' },
  { re: /메시지|알림|message/i, prefix: 'MSG' },
  { re: /설정|납품처|특수\s*조건|차량|기사|setting/i, prefix: 'SET' },
  { re: /마이\s*페이지|결제|mypage/i, prefix: 'MY' },
  { re: /공지|이용안내|정보|info/i, prefix: 'INFO' },
  { re: /권한|permission/i, prefix: 'PERM' },
  { re: /로그인|회원가입|랜딩|public/i, prefix: 'PUB' },
];

export function prefixFor(...hints: Array<string | null | undefined>): string | null {
  const text = hints.filter(Boolean).join(' ');
  return PREFIX_BY_CATEGORY.find((p) => p.re.test(text))?.prefix ?? null;
}

export interface Candidate extends CatalogEntry {
  /** 0~1 — 정렬 전용. 판정에 쓰지 않는다 */
  score: number;
}

export interface CandidateGroup {
  /** 좁혀진 접두 (없으면 전체) */
  prefix: string | null;
  section: string;
  /** 유사도 내림차순 — **자르지 않는다**. 사람이 목록 전체를 본다 */
  candidates: Candidate[];
}

/**
 * 넘기려는 TC에 대해 **같은 카테고리의 카탈로그 전체**를 유사도 순으로 돌려준다.
 *
 * 90건을 다 보라고 하면 판단이 불가능하지만, 카테고리로 좁히면 5~17건이라
 * 사람이 훑을 수 있다. 유사도는 위쪽에 후보가 오게 하는 용도일 뿐이고,
 * **잘라내지 않는다** — 잘라내면 "없다"는 잘못된 확신을 준다.
 */
export function candidatesFor(
  tc: {
    category?: string | null;
    subCategory?: string | null;
    detailCategory?: string | null;
    steps?: string | null;
    expected?: string | null;
  },
  catalog: Catalog,
): CandidateGroup {
  const prefix = prefixFor(tc.category, tc.subCategory, tc.detailCategory);
  const pool = prefix ? catalog.entries.filter((e) => e.prefix === prefix) : catalog.entries;
  const text = [tc.subCategory, tc.detailCategory, tc.steps, tc.expected]
    .filter(Boolean)
    .join(' ');

  const candidates: Candidate[] = pool
    .map((e) => ({ ...e, score: titleCoverage(e.title, text) }))
    .sort((a, b) => b.score - a.score);

  return {
    prefix,
    section: prefix ? (catalog.sections[prefix] ?? prefix) : '전체',
    candidates,
  };
}

/**
 * 넘길 TC들에 카탈로그 번호를 부여한다.
 * 같은 접두가 여러 개면 순차 증가시켜 번호 충돌을 막는다.
 * 카테고리를 못 가리면 `null`을 돌려 사람이 직접 고르게 한다.
 */
export function assignCatalogIds(
  items: Array<{ id: number; category?: string | null; subCategory?: string | null }>,
  catalog: Catalog,
): Array<{ id: number; catalogId: string | null }> {
  const counter = { ...catalog.nextSeq };
  return items.map((it) => {
    const prefix = prefixFor(it.category, it.subCategory);
    if (!prefix) return { id: it.id, catalogId: null };
    const seq = counter[prefix] ?? 1;
    counter[prefix] = seq + 1;
    return { id: it.id, catalogId: `${prefix}-${String(seq).padStart(3, '0')}` };
  });
}
