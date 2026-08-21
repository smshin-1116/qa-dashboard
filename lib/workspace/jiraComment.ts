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

import { bugDescriptionAdf, type BugSections } from '@/lib/workspace/bugTemplate';

/** 버그 컴포넌트 — 컨벤션상 ROOUTY. env로 바꾸고, 빈 값이면 생략(잘못된 컴포넌트로 생성 실패 방지). */
const BUG_COMPONENT = process.env.JIRA_BUG_COMPONENT ?? 'ROOUTY';

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

// ─── Fail TC → 버그 티켓 신규 생성 ──────────────────────────────────────
// 코멘트와 같은 Atlassian 토큰·REST를 쓰되, 대상은 create-issue 엔드포인트다.
// **사람이 [버그 등록]을 눌렀을 때만** 호출된다(외부 쓰기 — 자동 트리거 없음).

export interface BugDraft {
  /** TC 행 id — 성공 시 이 TC에 bug_ticket을 되박는다 */
  tcId: number;
  localId: string;
  summary: string;
  /** 평문 설명(구버전 호환). sections가 있으면 sections를 우선 렌더한다 */
  description: string;
  /** 구조화 섹션(DV-647 형식) — 있으면 이걸로 ADF를 만든다 */
  sections?: BugSections;
  /** 레이블(QA·신뢰도 등급 포함). 미지정 시 ['QA'] */
  labels?: string[];
}
export interface BugResult {
  tcId: number;
  localId: string;
  ok: boolean;
  key?: string;
  url?: string;
  error?: string;
}

/**
 * Fail TC 초안들을 각각 Jira 버그로 등록한다 (TC당 1건).
 * postComments와 같은 원칙 — **한 건 실패해도 나머지는 진행**하고 건별 결과를 돌려준다.
 */
export async function createBugs(projectKey: string, drafts: BugDraft[]): Promise<BugResult[]> {
  const base = process.env.CONFLUENCE_BASE_URL?.replace(/\/$/, '');
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;

  if (!base || !email || !token) {
    return drafts.map((d) => ({
      tcId: d.tcId,
      localId: d.localId,
      ok: false,
      error: 'Atlassian 인증 정보가 없습니다 (CONFLUENCE_BASE_URL·EMAIL·API_TOKEN)',
    }));
  }

  const header = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const out: BugResult[] = [];

  for (const d of drafts) {
    try {
      const res = await fetch(`${base}/rest/api/3/issue`, {
        method: 'POST',
        headers: {
          Authorization: header,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            issuetype: { name: '버그' },
            summary: d.summary,
            // 구조화 섹션이 있으면 DV-647 형식 ADF, 없으면 평문 폴백
            description: d.sections ? bugDescriptionAdf(d.sections) : toAdf(d.description),
            labels: d.labels?.length ? d.labels : ['QA'],
            // 컴포넌트 — 컨벤션상 항상 ROOUTY (env로 override, 미설정 시 생략해 생성 실패 방지)
            ...(BUG_COMPONENT ? { components: [{ name: BUG_COMPONENT }] } : {}),
          },
        }),
      });

      if (!res.ok) {
        out.push({
          tcId: d.tcId,
          localId: d.localId,
          ok: false,
          error: `${res.status} ${(await res.text()).slice(0, 300)}`,
        });
        continue;
      }
      const json = (await res.json()) as { key?: string };
      out.push({
        tcId: d.tcId,
        localId: d.localId,
        ok: true,
        key: json.key,
        url: json.key ? `${base}/browse/${json.key}` : undefined,
      });
    } catch (e) {
      out.push({ tcId: d.tcId, localId: d.localId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
