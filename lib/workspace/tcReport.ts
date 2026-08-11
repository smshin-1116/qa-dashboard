import type { TcRowDb } from './repo';

/**
 * 작업 종료 리포트 — 티켓에 등록할 코멘트 본문을 **규칙으로** 만든다.
 *
 * ── LLM을 쓰지 않는 이유 ──────────────────────────────────────────────
 * 여기서 필요한 건 창작이 아니라 집계다. Pass/Fail/Blocked를 세고, Fail·Blocked를
 * 그대로 옮기고, 인계 번호를 나열하면 끝이다. CLI 호출 1회는 하네스 고정비만
 * 실측 ~30k 토큰이라, 매 작업 종료마다 부르면 그대로 비용이 된다.
 *
 * ── 왜 Fail·Blocked만 본문에 쓰나 ─────────────────────────────────────
 * 개발자가 티켓에서 보고 싶은 것은 "뭐가 문제인가"다. Pass 3건을 나열해도
 * 읽지 않는다. 숫자로 요약하고, **조치가 필요한 것만** 문장으로 남긴다.
 *
 * ── Blocked를 따로 세는 이유 ──────────────────────────────────────────
 * Blocked는 "검증을 시도했는데 못 한 것"이다(2026-08-07 확정). Fail(틀렸다)·
 * Not Test(안 했다)와 섞이면 **명세 미정의가 그냥 안 한 것처럼 보인다.**
 */

/** 시안 그대로의 순서 — 조치가 필요한 것부터 */
export const RESULT_ORDER = ['Fail', 'Blocked', 'Pass', 'Not Test'] as const;

export interface TcTally {
  total: number;
  pass: number;
  fail: number;
  blocked: number;
  notTest: number;
  /** 하나라도 수행했는가 — 전부 Not Test면 종료할 게 없다 */
  executed: number;
}

export function tally(tcs: TcRowDb[]): TcTally {
  const c = (r: string) => tcs.filter((t) => t.result === r).length;
  const pass = c('Pass');
  const fail = c('Fail');
  const blocked = c('Blocked');
  return {
    total: tcs.length,
    pass,
    fail,
    blocked,
    notTest: c('Not Test'),
    executed: pass + fail + blocked,
  };
}

/**
 * 티켓 키 추출 — `RV-1284` · `DV-632` 형태.
 *
 * 세션 대화와 작업 제목에서 긁는다. 소스 URL 입력(⓪흡수)은 아직 없으므로
 * 여기가 유일한 출처다. 중복은 제거하고 등장 순서를 지킨다.
 *
 * ⚠️ 자동으로 **등록하지 않는다** — 뽑은 키는 화면에 보여주고,
 * 실제 코멘트 등록은 사람이 버튼을 눌러야 일어난다.
 */
const TICKET_RE = /\b([A-Z]{2,5}-\d{1,6})\b/g;

/**
 * 티켓 키 모양이지만 티켓이 **아닌** 접두들.
 *
 * `[A-Z]{2,5}-\d+`는 우리 도메인의 다른 식별자와 충돌한다 (실측 2026-08-11 DV-740):
 *   - REQ-001  : 인계 계약의 내부 요구 ID (codexAbsorb)
 *   - TC-01    : 작업 내 일련번호
 *   - PERM-004 · ROUTE-007 … : 자동화 카탈로그 TC ID (catalog 접두)
 * 이것들을 티켓으로 넘기면 존재하지 않는 Jira 이슈에 코멘트를 시도한다.
 * 카탈로그 접두는 catalog.ts의 PREFIX_BY_CATEGORY와 같은 목록이다.
 */
const NON_TICKET_PREFIXES = new Set([
  'TC', 'REQ', 'PR',
  'ROUTE', 'ORD', 'CTRL', 'RPT', 'MSG', 'SET', 'MY', 'INFO', 'PERM', 'PUB',
]);

export function extractTicketKeys(...texts: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(TICKET_RE)) {
      const prefix = m[1].split('-')[0];
      if (NON_TICKET_PREFIXES.has(prefix)) continue;
      if (!out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

/**
 * 한 줄 요약 — 기대결과가 비면 스텝으로 대신한다.
 *
 * 기대결과에 **`기대:` 라벨을 붙인다.** 안 붙이면 Fail 항목이
 * "TC-03 … — 취소가 성공한다"처럼 읽혀서 성공한 것처럼 보인다.
 * 실패 목록에 적히는 문장이므로 "무엇을 기대했는지"임을 명시해야 한다.
 */
function line(t: TcRowDb): string {
  // 기대결과가 "— 명세 미정의"처럼 대시로 시작하면 앞 대시를 걷어낸다 (구분자와 겹친다)
  const what = (t.expected?.trim() || t.steps?.trim() || '').replace(/^[—–-]\s*/, '');
  const where = [t.sub_category, t.detail_category].filter(Boolean).join(' · ');
  return `${t.local_id}${where ? ` ${where}` : ''}${what ? ` — 기대: ${what}` : ''}`;
}

export interface ReportInput {
  title: string;
  tcs: TcRowDb[];
  /** 오늘 날짜 (KST, YYYY-MM-DD) — 서버 시각에 의존하지 않도록 주입받는다 */
  today: string;
}

/**
 * 시안의 "등록될 코멘트 미리보기"를 그대로 만든다.
 *
 * ```
 * QA 검증 결과 — 2026-08-10
 * TC 5건 · Pass 3 / Fail 1 / Blocked 1
 *
 * ▪ Fail 1건 — TC-03 …
 * ▪ Blocked 1건 — TC-02 …
 * ▪ 자동화 인계 — ROUTE-014 · ROUTE-015
 * — QA Workspace 자동 등록
 * ```
 */
export function buildComment({ title, tcs, today }: ReportInput): string {
  const t = tally(tcs);
  const L: string[] = [];

  L.push(`QA 검증 결과 — ${today}`);
  if (title) L.push(title);
  L.push(
    `TC ${t.total}건 · Pass ${t.pass} / Fail ${t.fail} / Blocked ${t.blocked}` +
      (t.notTest ? ` / Not Test ${t.notTest}` : ''),
  );
  L.push('');

  const fails = tcs.filter((x) => x.result === 'Fail');
  if (fails.length) {
    L.push(`▪ Fail ${fails.length}건`);
    for (const x of fails) L.push(`  - ${line(x)}`);
  }

  const blocked = tcs.filter((x) => x.result === 'Blocked');
  if (blocked.length) {
    L.push(`▪ Blocked ${blocked.length}건 (검증 시도했으나 진행 불가 — 확인 필요)`);
    for (const x of blocked) L.push(`  - ${line(x)}`);
  }

  const notTest = tcs.filter((x) => x.result === 'Not Test');
  if (notTest.length) {
    // 안 한 것을 숨기지 않는다 — "조용한 실패 금지"와 같은 이유
    L.push(`▪ 미수행 ${notTest.length}건 — ${notTest.map((x) => x.local_id).join(' · ')}`);
  }

  const handed = tcs.filter((x) => x.handed_off_at && x.catalog_id);
  if (handed.length) {
    L.push(`▪ 자동화 인계 ${handed.length}건 — ${handed.map((x) => x.catalog_id).join(' · ')}`);
  }

  const covered = tcs.filter((x) => x.verdict === 'covered' && x.matched_catalog_id);
  if (covered.length) {
    L.push(
      `▪ 기존 자동화 커버 ${covered.length}건 — ${covered
        .map((x) => `${x.local_id}=${x.matched_catalog_id}`)
        .join(' · ')}`,
    );
  }

  if (!fails.length && !blocked.length) L.push('▪ 실패·차단 없음');

  L.push('');
  L.push('— QA Workspace 자동 등록');
  return L.join('\n');
}
