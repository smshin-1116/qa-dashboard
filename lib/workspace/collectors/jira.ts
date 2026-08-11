import { clearMissingTickets, upsertSignal, upsertTicket } from '../repo';
import { requireEnv, safely, type CollectorResult } from './shared';

/**
 * Jira 수집기 — QA 중 티켓 상태.
 *
 * ── 왜 MCP가 아니라 REST 인가 ─────────────────────────────────────────
 * MCP 도구는 LLM이 호출하는 물건이다. 수집기는 LLM을 쓰지 않으므로
 * REST를 직접 부른다. 여기서는 ADF 본문이 필요 없고 키·요약·상태만 쓰기 때문에
 * MCP의 강점(ADF→마크다운 변환)이 필요 없다.
 * (본문 해석이 필요한 QA 작업 탭에서는 반대로 MCP를 쓴다)
 *
 * ── 인증 ──────────────────────────────────────────────────────────────
 * Confluence용으로 이미 있는 Atlassian API 토큰이 Jira에도 그대로 쓰인다.
 * CONFLUENCE_EMAIL : CONFLUENCE_API_TOKEN 을 Basic 인증으로 보낸다.
 */

/** 감시 대상 — 상태명은 공백 포함 "QA 중" 이다 (실측 확인) */
const WATCH_STATUS = 'QA 중';
const PROJECT = process.env.JIRA_PROJECT ?? 'DV';

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    updated: string;
    labels?: string[];
    reporter?: { accountId?: string; emailAddress?: string };
  };
  changelog?: {
    histories?: Array<{
      created: string;
      items?: Array<{ field?: string; toString?: string }>;
    }>;
  };
}

/**
 * "이 상태가 된 시각"을 changelog에서 찾는다.
 *
 * ⚠️ `fields.updated`(최종 수정)를 쓰면 안 된다 — 상태와 무관한 편집에도 갱신된다.
 * 실측(2026-08-08): 티켓 12건이 8/1에 일괄 편집되어 전부 `updated`가 같았고,
 * 그대로 쓰면 전부 "D+7 정체"로 보였다. 실제 QA 중 전이는 7/22~7/29로 제각각(최대 D+17)이다.
 * 정체 감지의 핵심 값이므로 changelog의 마지막 전이 시각을 쓴다.
 */
function statusSinceOf(issue: JiraIssue, statusName: string): string | null {
  let last: string | null = null;
  for (const h of issue.changelog?.histories ?? []) {
    for (const it of h.items ?? []) {
      if (it.field === 'status' && it.toString === statusName) last = h.created;
    }
  }
  return last;
}

function auth(): { base: string; header: string } {
  const base = requireEnv('CONFLUENCE_BASE_URL').replace(/\/$/, '');
  const email = requireEnv('CONFLUENCE_EMAIL');
  const token = requireEnv('CONFLUENCE_API_TOKEN');
  const header = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  return { base, header };
}

/** 내 accountId — "내가 리포터인 티켓"(자동화가 발굴한 버그) 판별용 */
async function myAccountId(base: string, header: string): Promise<string | null> {
  const res = await fetch(`${base}/rest/api/3/myself`, {
    headers: { Authorization: header, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const me = (await res.json()) as { accountId?: string };
  return me.accountId ?? null;
}

async function searchJql(
  base: string,
  header: string,
  jql: string,
  fields: string[],
): Promise<JiraIssue[]> {
  const url = new URL(`${base}/rest/api/3/search/jql`);
  url.searchParams.set('jql', jql);
  url.searchParams.set('fields', fields.join(','));
  // 상태 전이 시각을 알아야 정체 감지가 정확해진다.
  // 검색이 changelog expand를 지원하므로 티켓별 추가 요청이 필요 없다 (실측 2026-08-08).
  url.searchParams.set('expand', 'changelog');
  url.searchParams.set('maxResults', '100');

  const res = await fetch(url, {
    headers: { Authorization: header, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Jira 조회 실패 ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
  const data = (await res.json()) as { issues?: JiraIssue[] };
  return data.issues ?? [];
}

export async function collectJira(): Promise<CollectorResult> {
  return safely('jira', async () => {
    const { base, header } = auth();
    const me = await myAccountId(base, header);

    const issues = await searchJql(
      base,
      header,
      `project = ${PROJECT} AND status = "${WATCH_STATUS}" ORDER BY updated DESC`,
      ['key', 'summary', 'status', 'updated', 'labels', 'reporter'],
    );

    const seen: string[] = [];
    let mine = 0;

    for (const it of issues) {
      const isMine = Boolean(me && it.fields.reporter?.accountId === me);
      if (isMine) mine++;
      seen.push(it.key);

      upsertTicket({
        jiraKey: it.key,
        summary: it.fields.summary,
        status: it.fields.status.name,
        isMine,
        labels: it.fields.labels ?? null,
        updatedAt: it.fields.updated,
        // 상태 전이 시각 — 없으면(이력 유실 등) updated로 폴백
        statusSince: statusSinceOf(it, it.fields.status.name) ?? it.fields.updated,
        url: `${base}/browse/${it.key}`,
      });
    }

    // 이 상태를 벗어난 티켓은 상태를 비운다 (완료 전이됨)
    clearMissingTickets(WATCH_STATUS, seen);

    /**
     * 브리핑용 요약 신호.
     * "내가 리포터인 것"만 센다 — 자동화가 발굴해서 내가 확인 책임을 진 버그이기 때문.
     * 남이 등록한 QA 중 티켓까지 오늘 할 일에 올리면 목록이 남의 일로 오염된다.
     */
    upsertSignal({
      source: 'jira',
      kind: 'ticket-status',
      ref: `${PROJECT}:${WATCH_STATUS}`,
      title: `QA 중 ${mine}건 — 수정 확인 대기`,
      detail: `${PROJECT} 보드 전체 ${issues.length}건 중 내가 리포터인 것 ${mine}건`,
      severity: mine > 0 ? 'warn' : 'ok',
      url: `${base}/issues/?jql=${encodeURIComponent(
        `project = ${PROJECT} AND status = "${WATCH_STATUS}" AND reporter = currentUser()`,
      )}`,
      observedAt: new Date().toISOString(),
      payload: { total: issues.length, mine },
    });

    return { detail: `QA 중 ${issues.length}건 (내 리포트 ${mine})`, count: issues.length };
  });
}
