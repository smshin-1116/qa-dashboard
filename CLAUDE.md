# CLAUDE.md

이 파일은 Claude Code가 이 저장소에서 작업할 때 참고하는 규칙 문서다.

> ⚠️ **2026-08-07 전면 개정.** 이전 버전은 "Gemini 우선 → OpenAI fallback으로 Confluence를
> 분석한다"고 기술했으나 그 구조는 **이미 제거됐다**(`lib/gemini-analyzer.ts`·`app/api/confluence`
> 모두 없음, `jsdom`·`he`는 미사용 잔재). 실제 구조는 아래와 같다.

## 프로젝트 개요

**개인 QA 워크스페이스.** 흩어져 있던 QA 자산(API 자동화·웹 E2E·Datadog·Jira·명세)을
한 화면에서 보고 결정하는 도구다. Next.js 15 + React 19 + TypeScript(strict).

핵심 흐름 두 가지:
1. **오늘(Today)** — 신호원 4곳을 아침에 자동 수집해 오늘 할 일로 환산 (LLM 미사용)
2. **TC 자동화 / 기능 분석** — Claude Code CLI를 subprocess로 띄워 MCP로 Jira·Confluence를 다룸

## 개발 명령어

```bash
npm run dev            # 개발 서버 (Turbopack)
npm run dev:mock       # PIPELINE_MOCK=1 — 기록된 실행을 재생. CLI 미호출 = 토큰 0
npm run dev:record     # PIPELINE_RECORD=1 — 실행을 fixtures/pipeline/에 기록
npm run collect        # 워크스페이스 수집기 4종 실행 (LLM 0)
npm run build          # 프로덕션 빌드 + 타입 검증
npm run lint
```

## 아키텍처

### A. 워크스페이스 상태 저장소 (`lib/workspace/`)

수집·규칙·화면이 공유하는 **로컬 SQLite**(`data/workspace.db`). 진행 상태와 상세 구조는
**`docs/workspace/STATUS.md`가 SSOT**다 — 작업 전에 그 파일을 먼저 읽을 것.

- `node:sqlite` 내장 모듈 사용 (의존성 0 · 네이티브 빌드 없음)
- **서버 전용**이다. 클라이언트 컴포넌트에서 import하면 빌드가 깨진다
- 모든 저장은 UPSERT — 수집을 여러 번 해도 행이 늘지 않는다(멱등)

### B. Claude CLI 파이프라인 (`lib/claudeRunner.ts`, `app/api/pipeline/run/`)

Claude Code CLI를 subprocess로 실행하고 stream-json을 파싱해 SSE로 흘린다.
4단계(설계 → 작성 → 리뷰 → 수정)를 **2개 세션 그룹**으로 묶어 돌린다.

- `analysis`  : 설계 → 리뷰 (스펙 근거 필요, MCP 사용)
- `authoring` : 작성 → 수정 (외부 조회 불필요, **MCP 비활성**)

### C. 워크스페이스(화면) 확장 지점 (`constants/workspaces.ts`)

새 화면을 추가하려면:
1. `types/session.ts`의 `WorkspaceKind`에 키 추가
2. `WORKSPACES` 배열에 항목 추가
3. `app/dashboard/<path>/page.tsx` 에서 렌더

헤더 탭·사이드바 필터·패널 구성·에이전트 모드가 이 설정만 보고 따라간다.
레이아웃은 `chat` / `pipeline` / `tool` / `board` 4종.

## ⭐ 토큰 예산 — 이 프로젝트의 최우선 제약

CLI 호출 1회당 하네스 고정비가 **실측 약 30k 토큰**이다. 아래는 규칙이지 권고가 아니다.

1. **매일 자동으로 도는 층에는 LLM을 넣지 않는다.**
   수집기·todo 규칙·오늘 화면은 전부 fetch·parse·정규식이다. 여기에 LLM을 넣으면 매일 비용이 나간다.
2. **세션을 묶는다.** 호출 수를 줄이는 것이 1순위. 단, **리뷰 독립성은 절감보다 우선**이므로
   작성 세션과 리뷰 세션은 합치지 않는다 (자기가 쓴 TC를 자기가 리뷰하면 무르게 본다).
3. **외부 조회가 없는 단계는 MCP를 끈다** (`--strict-mcp-config`). 툴 스키마가 프롬프트 앞에 실린다.
   ⚠️ 같은 세션을 이어 쓰는 턴들 사이에서는 이 값을 바꾸지 말 것 — 캐시된 프리픽스가 전부 무효화된다.
4. **재첨부 금지.** 같은 세션이 직전 턴에 만든 산출물을 다시 붙이지 않는다.
5. **건별 호출 금지 · 배치 1회.** N건을 분석할 때 N번 부르지 않는다.
6. **fingerprint 캐시.** 같은 실패를 매일 재분석하지 않는다 (`lib/workspace/fingerprint.ts`, TTL 7일).
7. **UI 개발 중에는 `npm run dev:mock`.** 화면만 볼 때 CLI를 부르지 않는다.

## 다른 프로젝트와의 관계 — **읽기 전용**

수집기가 참조하는 외부 자산에는 **아무것도 쓰지 않는다.** 경로는 환경변수로 뺐다.

| 대상 | 방식 | 환경변수 |
|---|---|---|
| `WEMEETPLACE/api-automation` | `gh run list` / `gh run view --log` (read-only) | `API_AUTOMATION_REPO` |
| `~/Projects/datadog-qa` | `watch-state.json` · `triage-state.json` 읽기 | `DATADOG_QA_DIR` |
| `~/Projects/roouty-test-automation` | `reports/junit.xml` 읽기 | `WEB_E2E_DIR` |
| Jira | REST 조회 (Atlassian 토큰) | `CONFLUENCE_*` |

`wemeet-b2b-backend` · `roouty-admin-react` 두 서비스 레포는 **파일 추가·수정 금지**다.

## 환경변수 (`.env.local`)

```
CONFLUENCE_BASE_URL / CONFLUENCE_EMAIL / CONFLUENCE_API_TOKEN   # Jira·Confluence 공용
ROOUTY_BASE_URL / ROOUTY_EMAIL / ROOUTY_PASSWORD                # 인수증 툴
GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY               # Sheets 푸시
```

Next 밖에서 도는 스크립트(`scripts/*.mjs`)는 `loadEnvLocal()`로 직접 읽는다.

## 구현 원칙

- **TypeScript strict.** `any` 금지, `unknown` 사용. `npx tsc --noEmit`이 통과해야 한다
- **주석은 "왜"를 적는다.** 무엇을 하는지는 코드가 말한다. 되돌리면 안 되는 판단의 근거를 남길 것
- **한국어 UI.** 시맨틱 색은 기존 에이전트 모드 색을 의미로 승격해 쓴다
  (`#34D399` ok · `#60A5FA` info · `#FBBF24` warn · `#F87171` crit)
- **조용한 실패 금지.** 수집기가 죽어도 나머지는 돌지만, 실패는 화면에 반드시 드러낸다

## 문서 위치

| 문서 | 내용 |
|---|---|
| `docs/workspace/STATUS.md` | **진행 상태 SSOT** — 새 세션은 여기부터 |
| `docs/tc-rules.md` | TC 작성 규칙 |
| `~/Projects/qa-oracle/docs/HISTORY.md` | 설계 결정 이력 |
| `~/Projects/qa-oracle/docs/workspace-prototype.html` | 화면 시안 (확정 규칙의 시각적 원본) |
