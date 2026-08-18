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

/** 마크다운 표 셀 정리 — 파이프·개행 이스케이프 + 길이 컷 (표 깨짐 방지) */
function cell(s: string | null | undefined, max = 70): string {
  let v = (s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  if (v.length > max) v = `${v.slice(0, max)}…`;
  return v || '—';
}

const RESULT_ICON: Record<string, string> = {
  Pass: '✅',
  Fail: '❌',
  Blocked: '⛔',
  'Not Test': '➖',
};
const RESULT_LABEL: Record<string, string> = {
  Pass: 'PASS',
  Fail: 'FAIL',
  Blocked: 'BLOCKED',
  'Not Test': 'N/A',
};

/** 결과 칸 — 아이콘 + 결과 + 사유(note). "어떻게 검증했는지"가 note에 담긴다 */
function resultCell(t: TcRowDb): string {
  const r = t.result ?? '';
  const icon = RESULT_ICON[r] ?? '·';
  const label = RESULT_LABEL[r] ?? (r || '?');
  const note = cell(t.note, 90);
  return `${icon} **${label}**${note !== '—' ? ` — ${note}` : ''}`;
}

/**
 * 작업 대화에서 "수행 플랜" 개요를 뽑는다. 수행 프롬프트가 실행 전에 플랜을 밝히게 하므로
 * ("플랜: 백엔드 N건 / 화면 그룹 …") 그 표식 줄부터 빈 줄·표 직전까지 몇 줄을 취한다.
 * 못 찾으면 undefined — 코멘트는 등록 전 미리보기로 사람이 검토하므로, 애매하면 안 넣는 게 낫다.
 */
export function extractRunPlan(text: string): string | undefined {
  const lines = (text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/수행\s*플랜|(^|\s)플랜\s*[:：]/.test(lines[i])) {
      const out: string[] = [];
      for (let j = i; j < lines.length && out.length < 6; j++) {
        const l = lines[j].trim();
        if (!l) {
          if (out.length) break;
          continue;
        }
        if (l.startsWith('|')) break; // 결과 표 시작 → 중단
        out.push(l.replace(/^[#*>\s]+/, ''));
      }
      if (out.length) return out.join('\n');
    }
  }
  return undefined;
}

export interface ReportInput {
  title: string;
  tcs: TcRowDb[];
  /** 오늘 날짜 (KST, YYYY-MM-DD) — 서버 시각에 의존하지 않도록 주입받는다 */
  today: string;
  /**
   * 수행 플랜 — 작업 대화에서 뽑은 개요(백엔드/화면 그룹 등). 있으면 "어떻게 검증했는지"를
   * 코멘트에 근거로 남긴다 (2026-08-18 요청 — 작업자가 검증 방식을 이해하도록).
   */
  plan?: string;
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
export function buildComment({ title, tcs, today, plan }: ReportInput): string {
  const t = tally(tcs);
  const L: string[] = [];

  // 헤더 + 한 줄 요약 (DV-534 신식문님 QA 결과 코멘트 형식)
  L.push(`## QA 검증 결과 — ${today} (stage)`);
  if (title) L.push(title);
  L.push('');
  L.push(
    `TC ${t.total}건 검증 결과입니다. **${t.pass} PASS / ${t.fail} FAIL / ${t.blocked} BLOCKED**` +
      (t.notTest ? ` · 미수행 ${t.notTest}` : '') +
      '.',
  );

  // 결과 표 — # | TC-ID | 기대결과 | 결과(아이콘 + 사유). 사유(note)에 "어떻게 검증했는지"가 담긴다.
  if (tcs.length) {
    L.push('');
    L.push('| # | TC-ID | 기대결과 | 결과 |');
    L.push('| --- | --- | --- | --- |');
    tcs.forEach((x, i) => {
      const expected = cell((x.expected || x.steps || '').replace(/^[—–-]\s*/, ''), 70);
      L.push(`| ${i + 1} | ${x.local_id} | ${expected} | ${resultCell(x)} |`);
    });
  }

  // 수행 플랜 — "어떻게 검증했는지"의 개요 (대화에서 추출)
  if (plan?.trim()) {
    L.push('');
    L.push('## 수행 플랜');
    for (const ln of plan.trim().split('\n')) L.push(ln.trim());
  }

  // 조치 필요 — Fail·Blocked는 사유와 함께 따로 모아 눈에 띄게
  const issues = tcs.filter((x) => x.result === 'Fail' || x.result === 'Blocked');
  if (issues.length) {
    L.push('');
    L.push(`## 조치 필요 (${issues.length}건)`);
    for (const x of issues) {
      const why = x.note?.trim() || line(x);
      L.push(`- ${x.local_id} [${x.result}] ${why}`);
    }
  }

  // 참고 — 인계·커버·미수행 (있을 때만)
  const extra: string[] = [];
  const handed = tcs.filter((x) => x.handed_off_at && x.catalog_id);
  if (handed.length)
    extra.push(`자동화 인계 ${handed.length}건 — ${handed.map((x) => x.catalog_id).join(' · ')}`);
  const covered = tcs.filter((x) => x.verdict === 'covered' && x.matched_catalog_id);
  if (covered.length)
    extra.push(
      `기존 자동화 커버 ${covered.length}건 — ${covered
        .map((x) => `${x.local_id}=${x.matched_catalog_id}`)
        .join(' · ')}`,
    );
  const notTested = tcs.filter((x) => x.result === 'Not Test');
  if (notTested.length)
    extra.push(`미수행 ${notTested.length}건 — ${notTested.map((x) => x.local_id).join(' · ')}`);
  if (extra.length) {
    L.push('');
    L.push('## 참고');
    for (const e of extra) L.push(`- ${e}`);
  }

  L.push('');
  L.push('— QA Workspace 자동 등록');
  return L.join('\n');
}
