/**
 * 실행 트리거 (2026-08-20) — 테스트 자동화 탭 "▶ 실행".
 * ────────────────────────────────────────────────────────────────────────
 * 시안 확정(2026-08-06): **대시보드는 직접 실행하지 않는다 — 기존 인프라를 트리거만 한다.**
 * 이유: Jenkinsfile의 disableConcurrentBuilds()가 stage 데이터(QA 상시 드라이버) 충돌을
 * 막고 있는데, 대시보드가 pytest를 직접 띄우면 그 보호가 사라진다.
 *   · 웹  → Jenkins REST buildWithParameters?TIER=  (Jenkins가 큐잉·동시방지·JUnit·Slack 처리)
 *   · API → GitHub Actions workflow_dispatch (gh)   (원격 실행)
 *   · 앱  → 에뮬 전제라 대시보드에서 트리거하지 않음 (로컬 pytest 별도)
 *
 * 층: 🔵 트리거 메커니즘(코어) + 🟡 엔드포인트(env). 도메인 값은 env로 뺀다.
 * 외부 CI를 실제로 부르므로 호출부(API)는 반드시 사람 승인(confirm) 게이트를 둔다.
 */
import { execFile } from 'node:child_process';

type Runner = 'web' | 'api' | 'app';

const JENKINS_BASE = process.env.JENKINS_BASE_URL ?? null;
const JENKINS_USER = process.env.JENKINS_USER ?? null;
const JENKINS_TOKEN = process.env.JENKINS_API_TOKEN ?? null;
const JENKINS_JOB = process.env.JENKINS_WEB_JOB ?? 'roouty-e2e';
const API_REPO = process.env.API_AUTOMATION_REPO ?? 'WEMEETPLACE/api-automation';

/** API tier → GitHub Actions 워크플로 파일 (실물 기준) */
const API_WORKFLOWS: Record<string, string> = {
  stage: 'stage-regression.yml',
  prod: 'prod-smoke.yml',
};

export interface RunnerTrigger {
  runner: Runner;
  via: string;           // 화면 표시용 ("Jenkins REST" 등)
  tiers: string[];       // 선택 가능한 tier
  ready: boolean;        // 설정이 갖춰졌는가
  note: string;          // 준비/미준비 사유
}

/** 현재 트리거 가능 상태 — GET payload에 실어 UI가 선언적으로 그린다 */
export function getTriggerConfig(): RunnerTrigger[] {
  const jenkinsReady = Boolean(JENKINS_BASE && JENKINS_USER && JENKINS_TOKEN);
  return [
    {
      runner: 'web',
      via: 'Jenkins REST',
      tiers: ['smoke', 'sanity', 'regression', 'full'],
      ready: jenkinsReady,
      note: jenkinsReady
        ? `${JENKINS_JOB} · Jenkins가 큐잉·동시방지·JUnit·Slack 처리`
        : 'JENKINS_BASE_URL·JENKINS_USER·JENKINS_API_TOKEN 미설정 (.env.local)',
    },
    {
      runner: 'api',
      via: 'GitHub Actions',
      tiers: Object.keys(API_WORKFLOWS),
      ready: true, // gh 인증 전제 (수집기도 gh 사용)
      note: `${API_REPO} · workflow_dispatch (원격 실행)`,
    },
    {
      runner: 'app',
      via: '로컬 pytest',
      tiers: [],
      ready: false,
      note: '에뮬(Pixel_7) 전제 — 대시보드에서 트리거하지 않음. 로컬에서 전제 점검 후 실행',
    },
  ];
}

export interface TriggerResult {
  ok: boolean;
  message: string;
  url?: string | null;
}

/** 실제 트리거 — 반드시 API 라우트에서 confirm 게이트 통과 후에만 호출 */
export async function triggerRun(runner: Runner, tier: string): Promise<TriggerResult> {
  if (runner === 'web') return triggerJenkins(tier);
  if (runner === 'api') return triggerActions(tier);
  return { ok: false, message: '앱은 에뮬 전제라 대시보드에서 트리거하지 않습니다.' };
}

/** 웹 — Jenkins REST buildWithParameters (crumb + Basic auth). 동시방지는 Jenkins가 처리. */
async function triggerJenkins(tier: string): Promise<TriggerResult> {
  if (!JENKINS_BASE || !JENKINS_USER || !JENKINS_TOKEN) {
    return { ok: false, message: 'Jenkins 미설정 — .env.local에 JENKINS_BASE_URL·JENKINS_USER·JENKINS_API_TOKEN 추가 필요' };
  }
  const auth = 'Basic ' + Buffer.from(`${JENKINS_USER}:${JENKINS_TOKEN}`).toString('base64');
  // CSRF crumb 획득
  let crumbField = 'Jenkins-Crumb';
  let crumb = '';
  try {
    const cr = await fetch(`${JENKINS_BASE}/crumbIssuer/api/json`, { headers: { Authorization: auth } });
    if (cr.ok) {
      const j = (await cr.json()) as { crumbRequestField?: string; crumb?: string };
      crumbField = j.crumbRequestField ?? crumbField;
      crumb = j.crumb ?? '';
    }
  } catch {
    /* crumb 없이 시도 — 일부 설정은 crumb 불필요 */
  }
  const url = `${JENKINS_BASE}/job/${encodeURIComponent(JENKINS_JOB)}/buildWithParameters?TIER=${encodeURIComponent(tier)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: crumb ? { Authorization: auth, [crumbField]: crumb } : { Authorization: auth },
  });
  if (res.status === 201 || res.ok) {
    // 201 Created + Location = 큐 아이템 URL
    const queued = res.headers.get('location');
    return { ok: true, message: `Jenkins ${JENKINS_JOB} TIER=${tier} 트리거됨 (큐잉·동시방지는 Jenkins가 처리)`, url: queued };
  }
  return { ok: false, message: `Jenkins 트리거 실패 (${res.status}) — 토큰/권한 확인` };
}

/** API — GitHub Actions workflow_dispatch (gh CLI, 이미 인증됨) */
function triggerActions(tier: string): Promise<TriggerResult> {
  const wf = API_WORKFLOWS[tier];
  if (!wf) return Promise.resolve({ ok: false, message: `알 수 없는 tier: ${tier}` });
  return new Promise((resolve) => {
    execFile('gh', ['workflow', 'run', wf, '-R', API_REPO], { timeout: 20_000 }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, message: `gh workflow run 실패 — ${(stderr || err.message).slice(0, 200)}` });
        return;
      }
      resolve({
        ok: true,
        message: `GitHub Actions ${wf} 원격 실행 요청됨 (${API_REPO})`,
        url: `https://github.com/${API_REPO}/actions/workflows/${wf}`,
      });
    });
  });
}
