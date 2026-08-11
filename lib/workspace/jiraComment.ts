/**
 * Jira 코멘트 등록 — **대시보드가 Jira에 쓰는 유일한 지점**.
 *
 * ── 무엇을 하고 무엇을 안 하나 ────────────────────────────────────────
 * 하는 것 : 티켓에 QA 검증 결과 코멘트 1건 등록
 * 안 하는 것 : **상태 전이**. 티켓을 "완료"로 옮기는 것은 Jira에서 사람이 직접 한다
 *              (오늘 탭의 "완료 전이는 사람 승인" 원칙과 동일 · 2026-08-07 확정)
 *
 * ── 사람 승인 없이는 호출되지 않는다 ──────────────────────────────────
 * 이 모듈은 수집기가 아니다. 아침 스케줄러에 걸리지 않고,
 * 사람이 [작업 종료] 버튼을 눌렀을 때만 실행된다. 외부에 글을 쓰는 행동이라
 * 자동 트리거를 두지 않는다.
 *
 * ── 인증 ──────────────────────────────────────────────────────────────
 * jira 수집기와 같은 Atlassian 토큰(`CONFLUENCE_*`)을 Basic으로 쓴다.
 */

/**
 * Jira 코멘트 본문은 ADF(Atlassian Document Format)다.
 * 평문 줄바꿈을 그대로 보내면 한 줄로 붙어버리므로 줄 단위 문단으로 감싼다.
 * 빈 줄은 빈 문단으로 — 시안 미리보기의 문단 간격이 그대로 재현된다.
 */
function toAdf(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

export interface CommentResult {
  key: string;
  ok: boolean;
  /** 등록된 코멘트 id (성공 시) */
  id?: string;
  /** 티켓으로 바로 가는 링크 */
  url?: string;
  error?: string;
}

/**
 * 티켓 여러 건에 같은 코멘트를 등록한다.
 *
 * **한 건이 실패해도 나머지는 진행한다.** 티켓 3건 중 1건이 권한 문제로 막혔다고
 * 나머지 2건까지 되돌리면, 이미 성공한 등록을 지울 방법도 없어 상태만 애매해진다.
 * 대신 건별 성공/실패를 그대로 돌려주고 화면이 드러낸다(조용한 실패 금지).
 */
export async function postComments(keys: string[], body: string): Promise<CommentResult[]> {
  const base = process.env.CONFLUENCE_BASE_URL?.replace(/\/$/, '');
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;

  if (!base || !email || !token) {
    return keys.map((key) => ({
      key,
      ok: false,
      error: 'Atlassian 인증 정보가 없습니다 (CONFLUENCE_BASE_URL·EMAIL·API_TOKEN)',
    }));
  }

  const header = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const adf = toAdf(body);
  const out: CommentResult[] = [];

  for (const key of keys) {
    try {
      const res = await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
        method: 'POST',
        headers: {
          Authorization: header,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: adf }),
      });

      if (!res.ok) {
        out.push({
          key,
          ok: false,
          error: `${res.status} ${(await res.text()).slice(0, 200)}`,
        });
        continue;
      }
      const json = (await res.json()) as { id?: string };
      out.push({ key, ok: true, id: json.id, url: `${base}/browse/${key}` });
    } catch (e) {
      out.push({ key, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
