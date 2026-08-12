import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTRACT_JSON_SCHEMA, normalizeContract, validateContract, type Contract } from './contract';
import { loadCatalog, titleCoverage } from './catalog';

const execFileAsync = promisify(execFile);

/**
 * ⓪ 개별 흡수 · ① 교차 분석 — **Codex 세션 1개**가 담당한다.
 *
 * ── 왜 Codex인가 (시안 2026-08-07 확정) ───────────────────────────────
 * 목적 A: Claude 사용량 분산 — 읽기·분석은 Codex(ChatGPT 플랜) 토큰으로.
 * 부수효과 B: "같은 뇌 문제" 해소 — 읽고 분석한 뇌(Codex)와 TC를 쓰는 뇌(Claude)가
 * 달라서, Claude가 ③에서 Codex의 전제를 남의 것으로 보고 의심할 수 있다.
 *
 * ── 왜 exec 1회인가 ───────────────────────────────────────────────────
 * MCP 도구 스키마(Atlassian 27개)가 프롬프트 앞에 매번 실린다.
 * 세션 하나로 묶으면 스키마가 1번만 로드된다 — 소스가 20개여도 그대로.
 *
 * ── 3단 폴백 (시안 인계 계약 카드) ────────────────────────────────────
 * 1차: 스키마·참조 무결성 검증 통과 → 진행
 * 2차: 실패 → 위반 지점을 지적해 Codex에 **1회 재시도** (형식 교정만)
 * 폴백: 또 실패하거나 codex 미설치 → **Claude 단독** — 작업은 멈추지 않는다
 */

export interface AbsorbInput {
  urls: string[];
  text: string;
}

export interface AbsorbResult {
  engine: 'codex' | 'fallback';
  contract: Contract | null;
  /** 폴백 사유 — 화면에 "분산 실패 · Claude 단독" 배지와 함께 노출 */
  fallbackReason?: string;
  /** 실측 기록용 */
  tokensUsed?: number;
}

function buildPrompt(input: AbsorbInput, retryViolations?: string[]): string {
  const sourceList = [
    ...input.urls.map((u, i) => `S${i + 1}: ${u}`),
    ...(input.text ? [`S${input.urls.length + 1}: (아래 직접 입력 텍스트)\n---\n${input.text}\n---`] : []),
  ].join('\n');

  const base = `당신은 QA 분석가다. 아래 소스들을 읽고 교차 분석해 JSON 하나로 정리하라.

[소스 목록]
${sourceList}

[⓪ 개별 흡수 — 소스마다 따로]
- atlassian.net URL은 atlassian MCP 도구로 읽는다 (Jira 이슈 / Confluence 페이지)
- 소스별로 요약(summary)과 "이 소스만으로는 알 수 없는 것"(unclear)을 뽑는다
- 요약에는 요구·AC·화면·API·정책을 담는다. 원문 전체 복사 금지

[⓪-b 연결된 구현(PR·코드) 검토 — 티켓마다]
- Jira 티켓을 읽을 때 본문·코멘트·리모트 링크에서 GitHub PR 참조를 찾는다
  (github.com/.../pull/N URL, "org/repo#N" 표기 둘 다)
- 소스 목록에 github.com PR URL이 직접 있으면 그것도 동일하게 처리한다
- 티켓 본문·코멘트에 PR 참조가 안 보이면 (Jira 개발 패널은 MCP로 조회 불가) 검색으로 찾는다:
  gh search prs "<티켓키>" --owner WEMEETPLACE --state merged --json repository,number,title
  결과 중 **제목에 해당 티켓 키가 들어간 것만** 채택한다 (검색은 본문 매치도 섞여 나온다)
- 찾은 PR은 shell로 읽는다 (읽기 전용 — gh 조회 명령만 사용, clone·push·수정 금지):
  gh pr view <N> --repo <owner/repo> --json title,state,mergedAt,body,files
  필요하면 gh pr diff <N> --repo <owner/repo> 로 구현 세부(검증 로직·엣지 케이스)를 확인
- PR마다 sources에 항목을 추가한다: id="PR#<N>", type="PR",
  summary에는 **구현 사실**을 담는다 — 신규/변경 API 경로와 메서드, 요청·응답 형태,
  검증 규칙(거부되는 입력), 처리되는/안 되는 엣지 케이스, 변경 파일 범위
- 티켓의 주장과 PR의 실제 구현이 다르면 그것은 conflicts에 넣는다
  (예: 티켓 "전체 필드 지원" ↔ PR 코드는 일부 필드 제외 → 모순)
- PR을 찾지 못한 티켓은 그냥 넘어간다 (unclear에 "연결된 PR 없음" 기록)

[① 교차 분석 — 요약본끼리 대조]
- conflicts: 소스끼리 다른 말을 하는 지점. 각 side의 claim을 원문 근거로,
  가능하면 어느 쪽이 더 최신인지 updated_at을 남긴다. 심각하면 severity=crit
- duplicates: 같은 요구가 여러 소스에 중복된 것 (requirement_ids로 묶기)
- gaps: **requirements로 채택되지 않은** 언급만 (covered_by=null).
  이미 requirements에 있는 내용을 gaps에 다시 넣지 마라 — gaps는 "범위 누락 의심"이지 요구 목록의 복사본이 아니다.
  (예: 기획서가 화면 3개를 말하는데 티켓이 2개만 다루면, 남은 1개가 gap이다)
- requirements: 최종 요구 목록. from[]에 출처 source id 필수

[규칙]
- source id는 티켓 키(RV-1284)가 있으면 그것을, 없으면 S1·S2를 쓴다
- impacts는 빈 배열들로 둔다 (로컬 자산 대조는 서버가 한다)
- decisions는 빈 배열로 둔다 (사람이 ② 확인 게이트에서 채운다)
- 접근 실패한 소스는 summary에 "읽기 실패: <사유>"로 남기고 진행한다
- 추측으로 채우지 마라. 모르면 unclear에 남겨라`;

  if (retryViolations?.length) {
    return `${base}

[⚠️ 재시도 — 직전 출력의 계약 위반을 교정하라. 내용 재분석이 아니라 형식 교정만]
${retryViolations.map((v) => `- ${v}`).join('\n')}`;
  }
  return base;
}

async function runCodexOnce(
  prompt: string,
  workDir: string,
): Promise<{ raw: unknown; tokensUsed?: number }> {
  const schemaPath = path.join(workDir, 'contract-schema.json');
  const outPath = path.join(workDir, 'contract-out.json');
  fs.writeFileSync(schemaPath, JSON.stringify(CONTRACT_JSON_SCHEMA));

  // ⚠️ 실측 함정 (2026-08-10~11):
  // ① `-s read-only`를 명시하면 행 — 대신 workspace-write를 쓰되 cwd를 임시 폴더로
  //    두어 모델의 쓰기가 거기 갇히게 한다. 회사 레포 read-only 원칙은 프롬프트의
  //    "gh 조회만, clone·push 금지"와 cwd 격리 둘이 같이 지킨다.
  // ② 기본 샌드박스는 자식 셸의 네트워크를 막는다 — gh(PR 검토)가 api.github.com에
  //    못 붙어서 network_access=true를 켠다.
  // ③ TTY 없이 spawn되면 codex가 stdin을 추가 프롬프트로 **기다린다**
  //    ("Reading additional input from stdin...") — stdin을 즉시 닫아야 진행된다.
  const pending = execFileAsync(
    'codex',
    [
      'exec',
      '--skip-git-repo-check',
      '-s', 'workspace-write',
      '-c', 'sandbox_workspace_write.network_access=true',
      '--output-schema', schemaPath,
      '-o', outPath,
      prompt,
    ],
    { timeout: 420_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', cwd: workDir },
  );
  pending.child.stdin?.end();
  const { stdout, stderr } = await pending;

  // 진행 로그("tokens used")는 stderr로 나온다 (실측 — stdout은 최종 메시지뿐)
  const tokensMatch = `${stdout}\n${stderr}`.match(/tokens used[\s:]*([\d,]+)/i);
  const tokensUsed = tokensMatch ? Number(tokensMatch[1].replace(/,/g, '')) : undefined;

  const rawText = fs.readFileSync(outPath, 'utf8');
  return { raw: JSON.parse(rawText) as unknown, tokensUsed };
}

/**
 * 로컬 자산 대조 — impacts는 Codex가 아니라 **서버가** 채운다.
 * Codex는 우리 자동화 카탈로그를 모른다. 요구 텍스트를 카탈로그 제목과
 * 대조해(문자 바이그램) 겹치는 기존 TC를 impacts.tc_ids에 넣는다.
 */
function fillImpacts(contract: Contract): void {
  const catalog = loadCatalog();
  if (!catalog) return; // 독립성 — 카탈로그가 없어도 계약은 유효하다

  const hit = new Set<string>();
  for (const r of contract.requirements) {
    for (const e of catalog.entries) {
      if (titleCoverage(e.title, r.text) >= 0.6) hit.add(e.id);
    }
  }
  contract.impacts.tc_ids = [...hit];
}

export async function absorbWithCodex(input: AbsorbInput): Promise<AbsorbResult> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-absorb-'));
  let totalTokens = 0;

  try {
    // 1차
    let violations: string[];
    try {
      const first = await runCodexOnce(buildPrompt(input), workDir);
      totalTokens += first.tokensUsed ?? 0;
      const v1 = validateContract(normalizeContract(first.raw));
      if (v1.contract) {
        fillImpacts(v1.contract);
        return { engine: 'codex', contract: v1.contract, tokensUsed: totalTokens };
      }
      violations = v1.violations;
    } catch (e) {
      // spawn 실패(미설치)·타임아웃·JSON 파싱 실패 — 재시도 없이 바로 폴백
      // (형식 위반은 교정 가능하지만, 실행 자체가 안 되는 건 다시 돌려도 같다)
      return {
        engine: 'fallback',
        contract: null,
        fallbackReason: `codex 실행 실패: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
      };
    }

    // 2차 — 위반 지점을 지적해 1회만 재시도
    try {
      const second = await runCodexOnce(buildPrompt(input, violations), workDir);
      totalTokens += second.tokensUsed ?? 0;
      const v2 = validateContract(normalizeContract(second.raw));
      if (v2.contract) {
        fillImpacts(v2.contract);
        return { engine: 'codex', contract: v2.contract, tokensUsed: totalTokens };
      }
      return {
        engine: 'fallback',
        contract: null,
        fallbackReason: `재시도 후에도 계약 위반: ${v2.violations.slice(0, 3).join(' / ')}`,
        tokensUsed: totalTokens,
      };
    } catch (e) {
      return {
        engine: 'fallback',
        contract: null,
        fallbackReason: `재시도 실행 실패: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
        tokensUsed: totalTokens,
      };
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
