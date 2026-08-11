import { upsertSignal } from '../repo';
import { run, safely, type CollectorResult } from './shared';

/**
 * stage PR 수집기 — "변경" 신호원.
 *
 * ── 왜 qa-stage-report 로그를 파싱하지 않는가 ─────────────────────────
 * 그 워크플로도 같은 데이터를 GitHub에서 읽는다. 로그를 거쳐 받으면
 *   ① 그 워크플로가 실패하면 우리도 눈이 먼다
 *   ② 출력이 사람용 Slack 메시지라 상위 N건 잘림·형식 변경에 취약하다
 *      (api-test에서 이미 "실패 상위 10건만 출력" 문제를 겪었다)
 * → **GitHub을 직접 읽는다.** 구조화된 데이터를 그대로 얻고 의존도 없앤다.
 *   qa-stage-report의 Slack 리포트는 그대로 두고 병행한다(이중 안전망 원칙).
 *
 * ── 읽기 전용 ─────────────────────────────────────────────────────────
 * 두 서비스 레포는 **파일 추가·수정 금지** 대상이다.
 * 여기서는 `gh api`로 조회만 한다 (PR 목록·파일 목록).
 *
 * ── 토큰 ──────────────────────────────────────────────────────────────
 * **LLM 호출 0.** 영향 영역 판정은 파일 경로 규칙으로 한다.
 */

interface RepoConf {
  slug: string;
  label: string;
}

const REPOS: RepoConf[] = [
  { slug: 'WEMEETPLACE/wemeet-b2b-backend', label: 'backend' },
  { slug: 'WEMEETPLACE/roouty-admin-react', label: 'admin' },
];

const STAGE_BRANCH = 'stage';

/** 최근 며칠치를 볼지 — 아침 브리핑은 "어제 이후 stage에 뭐가 올라갔나"가 관심사 */
const LOOKBACK_HOURS = Number(process.env.STAGE_PR_LOOKBACK_HOURS ?? 30);

/** PR 제목·본문에서 티켓 키를 뽑는다 (qa-stage-report와 같은 규약) */
const JIRA_KEY_RE = /\b(RV|QI|DV|TECH|EPIC|ST|PROJ|BUG)-\d+\b/g;

/**
 * 변경 파일 경로 → 영향 영역.
 *
 * 규칙 기반이라 완벽하지 않지만, 아침에 필요한 것은 "어느 쪽을 봐야 하나"이지
 * 정밀 분류가 아니다. 애매하면 분류하지 않고 파일 수만 알린다 —
 * 틀린 분류를 자신 있게 말하는 것보다 낫다.
 */
const AREA_RULES: Array<{ area: string; re: RegExp }> = [
  { area: '배차·최적화', re: /(route|optimize|dispatch|engine)/i },
  { area: '주문', re: /(order|shipment)/i },
  { area: '관제·모니터링', re: /(monitor|control|driving|tracking)/i },
  { area: '기사·차량', re: /(driver|vehicle|member)/i },
  { area: '납품처·설정', re: /(masterOrder|consignee|setting|skill|pallet)/i },
  { area: '메시지·알림', re: /(message|notify|alimtalk|sms|webhook)/i },
  { area: '리포트·정산', re: /(report|statistic|settlement)/i },
  { area: 'ePOD·인수증', re: /(epod|pod|signature|receipt)/i },
  { area: '인증·권한', re: /(auth|permission|role|token)/i },
  { area: '인프라·배포', re: /(deploy|docker|\.github|terraform|aws|helm)/i },
];

export function areasOf(files: string[]): string[] {
  const hit = new Set<string>();
  for (const f of files) {
    for (const r of AREA_RULES) {
      if (r.re.test(f)) hit.add(r.area);
    }
  }
  return [...hit];
}

/** 회귀 확인이 필요할 만한 영역인가 — 인프라만 바뀐 PR은 QA 관심사가 아니다 */
const QA_RELEVANT = new Set([
  '배차·최적화',
  '주문',
  '관제·모니터링',
  '기사·차량',
  '납품처·설정',
  '메시지·알림',
  '리포트·정산',
  'ePOD·인수증',
  '인증·권한',
]);

interface GhPr {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  merged_at: string | null;
  updated_at: string;
  html_url: string;
}

async function ghJson<T>(path: string): Promise<T> {
  const out = await run('gh', ['api', path, '--paginate'], { timeoutMs: 60_000 });
  // --paginate는 페이지별 JSON 배열을 이어 붙이므로 `][` 를 `,` 로 합친다
  return JSON.parse(out.replace(/\]\s*\[/g, ',')) as T;
}

export async function collectStagePr(): Promise<CollectorResult> {
  return safely('stage-pr', async () => {
    const cutoff = Date.now() - LOOKBACK_HOURS * 3_600_000;
    let merged = 0;
    let relevant = 0;
    const areaTally = new Map<string, number>();

    for (const repo of REPOS) {
      // 닫힌 PR 중 stage로 병합된 것 (최근 갱신 순)
      const prs = await ghJson<GhPr[]>(
        `repos/${repo.slug}/pulls?state=closed&base=${STAGE_BRANCH}&sort=updated&direction=desc&per_page=30`,
      );

      const recent = prs.filter(
        (p) => p.merged_at && new Date(p.merged_at).getTime() > cutoff,
      );

      for (const pr of recent) {
        merged++;

        // 파일 목록 — 영향 영역 판정용
        let files: string[] = [];
        try {
          const fl = await ghJson<Array<{ filename: string }>>(
            `repos/${repo.slug}/pulls/${pr.number}/files?per_page=100`,
          );
          files = fl.map((f) => f.filename);
        } catch {
          // 파일 조회 실패는 치명적이지 않다 — 제목만으로도 신호는 된다
        }

        const areas = areasOf(files);
        const qaAreas = areas.filter((a) => QA_RELEVANT.has(a));
        if (qaAreas.length) relevant++;
        for (const a of qaAreas) areaTally.set(a, (areaTally.get(a) ?? 0) + 1);

        const tickets = [
          ...new Set(`${pr.title} ${pr.body ?? ''}`.match(JIRA_KEY_RE) ?? []),
        ];

        upsertSignal({
          source: 'stage-pr',
          kind: 'pr-merged',
          ref: `${repo.label}#${pr.number}`,
          title: `[${repo.label}] #${pr.number} ${pr.title}`,
          detail:
            (qaAreas.length ? `영향 ${qaAreas.join(' · ')}` : '영향 영역 미분류') +
            ` · 파일 ${files.length}` +
            (tickets.length ? ` · ${tickets.join(' ')}` : ''),
          // QA 관심 영역이면 확인 대상, 인프라뿐이면 참고용
          severity: qaAreas.length ? 'warn' : 'idle',
          url: pr.html_url,
          observedAt: pr.merged_at!,
          payload: { areas: qaAreas, files: files.length, tickets, author: pr.user?.login },
        });
      }
    }

    /**
     * 요약 신호 — todo 규칙이 이것을 보고 P1 항목을 만든다.
     * 회귀 확인이 필요한 PR이 없으면 신호를 남기지 않는다(빈 항목이 뜨지 않도록).
     */
    const topAreas = [...areaTally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([a, c]) => `${a} ${c}`)
      .join(' · ');

    if (relevant > 0) {
      upsertSignal({
        source: 'stage-pr',
        kind: 'summary',
        ref: 'stage-merged-summary',
        title: `stage 병합 PR ${relevant}건 — 회귀 범위 확인 필요`,
        detail: `최근 ${LOOKBACK_HOURS}시간 · 전체 ${merged}건 중 QA 관심 영역 ${relevant}건` +
          (topAreas ? ` · ${topAreas}` : ''),
        severity: 'warn',
        observedAt: new Date().toISOString(),
        payload: { merged, relevant, areas: Object.fromEntries(areaTally) },
      });
    } else {
      // 해소되면 요약 신호를 지운다 (한 번 뜬 경고가 영원히 남지 않도록)
      const { removeSignal } = await import('../repo');
      removeSignal('stage-pr', 'stage-merged-summary');
    }

    return {
      detail:
        merged === 0
          ? `최근 ${LOOKBACK_HOURS}시간 병합 없음`
          : `병합 ${merged}건 · QA 관심 ${relevant}건${topAreas ? ` (${topAreas})` : ''}`,
      count: merged,
    };
  });
}
