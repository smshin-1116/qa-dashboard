# qa-dashboard

**개인용 QA 오퍼레이션 워크벤치.** 아침 신호 수집 → 티켓 QA 작업 → TC 설계·작성·리뷰·수행 → 자동화 자산 관리 → 리스크 패턴 축적을 한 화면에 모았다. Claude Code CLI를 서브프로세스 에이전트 런타임으로 래핑한 Next.js 15 풀스택 앱.

> **범위를 정확히**: 1인 로컬 도구다. 팀에 배포된 시스템이 아니다.
> 배포 설정(Dockerfile·CI) 없이 `npm run dev` + macOS launchd로 운영한다.
> 팀 이식은 `si-adaptation` 브랜치에서 코어/프로파일 분리 1단계까지 진행됨.

## 두 개의 흐름

**① 오늘 (Today)** — 신호원 5곳을 아침에 자동 수집해 "오늘 할 일"로 환산한다. **LLM 미사용.**

**② QA 작업 (Work)** — Claude Code CLI를 서브프로세스로 띄워 MCP로 Jira·Confluence를 다루는 4단계 에이전트 파이프라인(흡수 → 설계 → 작성 → 리뷰·수정). 사람 승인 게이트가 단계마다 있다.

## 현재 상태

| 항목 | 값 |
|---|---|
| 코드 | **20,834 LOC** (app 3,566 · components 8,844 · lib 7,558 · 기타) |
| 화면 / API 라우트 / SQLite 테이블 | 9 / 15 / 13 (schema v8) |
| 타입 | `strict` · **`any` 0건** / `unknown` 44건 + 좁히기 |
| 커밋 | 90 (실질 시작 2026-03) |
| 운영 | launchd로 매일 아침 자동 수집 · 실데이터 축적 중 |

## 설계 원칙

### 1. 토큰 예산이 아키텍처를 정한다

CLI 호출 1회당 하네스 고정비가 **실측 약 30k 토큰**이다. 이 제약에서 나온 규칙:

| 규칙 | 근거 |
|---|---|
| **매일 자동으로 도는 층에는 LLM을 넣지 않는다** | 수집기·todo 규칙·오늘 화면은 전부 fetch/parse/정규식 |
| 세션 그룹화 — 4단계를 2세션(`analysis`/`authoring`)으로 | 고정비 120k → 60k |
| 단, **작성과 리뷰는 절대 합치지 않는다** | 자기가 쓴 TC를 자기가 리뷰하면 무르다. **리뷰 독립성은 절감보다 우선** |
| 재첨부 금지 | 같은 세션이 직전 턴에 쓴 내용을 다시 붙이지 않는다 |
| 캐시 프리픽스 보호 | 같은 세션을 이어 쓰는 턴 사이에 MCP on/off를 바꾸지 않고, 시스템 프롬프트를 바이트 동일하게 유지 |
| mock/record 하네스 | 실행 1회를 `fixtures/pipeline/`에 기록해 12배속 재생 → **UI 개발 중 토큰 0** |
| fingerprint 캐시 (TTL 7일) | 같은 실패를 매일 재분석하지 않는다 |

### 2. 조용한 실패 금지

- `safely()` — 수집기 하나가 죽어도 나머지는 돌지만 실패는 화면·로그에 **반드시** 노출
- 낙관적 UI 갱신에는 **실패 롤백을 반드시 짝짓는다**
- LLM 대조 시 입력이 상한을 넘으면 자르되 **결과에 명시**한다 (조용한 절단 금지)
- CLI 오류는 원인별(401 / invalid_grant / 429 / econnreset) 한국어 메시지로 분류

### 3. 파괴적 행동은 사람 승인 뒤에

- 서비스 레포 2곳은 **읽기 전용** (프롬프트 금지 + 작업 디렉터리 격리 이중 방어)
- 인수증 전송은 기본 드라이런 — `send=true` **AND** `ROOUTY_ALLOW_SEND=true` 둘 다여야 실전송
- Jira 실등록 · 실행 트리거 · 결함 티켓은 confirm 게이트
- TC 수행은 **stage 한정 · GET only · prod 금지**를 시스템 프롬프트에 명문화

### 4. 상태는 3층으로 분리

| 층 | 저장소 | 내용 |
|---|---|---|
| 서버 영구 | SQLite (`data/workspace.db`) | 신호·todo·TC·리스크 패턴·일일 스냅샷 |
| 클라이언트 세션 | Zustand + IndexedDB | 사이드바 핀·이름변경·검색·시간 그룹화 |
| UI 취향 | localStorage | 에이전트 모드·테마 |

모든 저장은 **UPSERT**(수집 멱등). 그 부작용인 이력 증발은 `metric_snapshot`(하루 1행)으로 해결한다.

## 신호원 5종 — 전부 LLM 0

| 수집기 | 소스 | 방식 |
|---|---|---|
| `apiTest` | GitHub Actions (API 자동화 레포) | `gh run` → 요약 출력 정규식 파싱 → 6종 분류 |
| `jira` | Jira Cloud REST v3 | JQL + **`expand=changelog`** — 최종 수정 시각이 아니라 **상태 전이 시각**으로 정체일 계산 |
| `datadog` | 로컬 트리아지 상태 파일 | 파일 읽기 |
| `webE2e` | Jenkins 산출 `junit.xml` | XML 파싱 |
| `stagePr` | GitHub PR (stage 머지) | 변경 파일 → **영향 영역 10종 규칙 매핑** + 티켓 키 추출 |

> `jira` 수집기의 `expand=changelog`는 이 화면의 존재 이유다. 처음엔 티켓 정체일이 전부
> 같은 값(D+7)으로 나왔는데, 최종 수정 시각을 상태 전이 시각으로 착각한 것이었다.
> **정체 감지는 경과일이 전부이므로 이 값이 틀리면 화면 자체가 무의미했다.**

**LLM은 사람이 버튼을 누를 때만** 동작한다 — 실패 일괄분석(규칙 → 지문 캐시 → 잔여만 배치 1회), 심층분석(원인 파일:라인까지), PR×리스크패턴 대조, 패턴 추출, 다중 소스 흡수.

## 빠른 시작

```bash
npm install
cp .env.example .env.local    # 없으면 아래 키 목록 참고해 생성

npm run dev                   # Turbopack 개발 서버
npm run dev:mock              # 파이프라인 재생 모드 — 토큰 0으로 UI 개발
npm run dev:record            # 실행 1회를 픽스처로 기록
npm run collect               # 신호 수집 1회 (Next 밖에서 lib/workspace 재사용)
npm run build && npm run lint
```

자동 수집 등록: `scripts/setup-auto-collect.sh` (launchd, 매일 아침)

필요한 환경변수 키: `CONFLUENCE_BASE_URL`·`CONFLUENCE_EMAIL`·`CONFLUENCE_API_TOKEN`, `JIRA_PROJECT`, `API_AUTOMATION_REPO`, `GITHUB_REPO_BACKEND`·`GITHUB_REPO_FRONTEND`, `DATADOG_QA_DIR`, `WEB_E2E_DIR`, `JENKINS_BASE_URL`·`JENKINS_USER`·`JENKINS_API_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`·`GOOGLE_PRIVATE_KEY`, `ROOUTY_*`, `WORKSPACE_DB_PATH`. 값은 `.env.local`(git 제외).

## 구조

```
app/
  dashboard/{today,work,auto,risk,receipt,notice}/   화면 6
  api/workspace/{today,collect,todo,notice,tc,absorb,automation,risk,...}/
  api/pipeline/run/         4단계 파이프라인 (SSE) + mock/record
  api/dashboard/chat/       채팅 SSE + 에이전트 모드 5종 시스템 프롬프트
components/dashboard/       전부 'use client' — 화면별 View + 패널
lib/
  claudeRunner.ts           CLI 서브프로세스 + stream-json 청크 경계 복원
  tcQuality.ts              TC 품질 결정론적 채점 (6체크 가중치 → 0~100 · A~F)
  workspace/
    schema.ts db.ts repo.ts types.ts todo.ts     데이터 계층
    collectors/             신호원 5종 + 일일 스냅샷 (LLM 0)
    analyzeFailures.ts deepAnalyzeFinding.ts checkPrRisk.ts
    extractRiskPatterns.ts codexAbsorb.ts        온디맨드 LLM
    fingerprint.ts contract.ts                   캐시 키 · 계약 무결성 검증
constants/workspaces.ts     ← 배열 하나가 헤더 탭·사이드바·우측 패널·에이전트 모드를 구동
data/                       workspace.db + 수집 로그 (git 제외)
docs/workspace/STATUS.md    ← 실질 SSOT
```

**워크스페이스 확장은 3스텝**: `constants/workspaces.ts`에 항목 추가 → 레이아웃 유형 지정(`chat`/`pipeline`/`tool`/`board`) → View 컴포넌트 작성. 상세는 `CLAUDE.md`.

## 지표는 어떻게 정의했나

- **우선순위 = 실무 > 자동화** — P0 티켓·신규 프로덕션 에러·환경 고장 → P1 계약 드리프트·PR 회귀 → P2 리스크 패턴 → P3 야간 실패 분류
- **발견 수는 지표가 아니다. 수용률이 지표다** — 리스크 PR 대조는 거짓 양성을 3중으로 억제한다(프롬프트: 근거 못 대면 빈 배열이 정답 / 서버: 근거 없는 항목 폐기 / 사람: 수용·기각)
- **판정이 아니라 검색** — 중복 자동화 확인은 유사도 정렬 후 **자르지 않는다**("자르면 '없다'는 잘못된 확신을 준다"). 결정은 사람이 한다
- **AI 산출물을 AI에게 다시 묻지 않는다** — TC 품질은 6체크 가중치로 결정론적으로 채점

## 문서 지도

| 파일 | 상태 |
|---|---|
| `docs/workspace/STATUS.md` | ✅ **SSOT** — 일자별 작업일지 + 설계 근거 + 실측치. 새 세션은 여기부터 |
| `CLAUDE.md` | ✅ 최신 — 토큰 규칙·확장 절차·구현 원칙·외부 자산 관계표 |
| `docs/tc-rules.md` · `docs/auto-collect.md` · `docs/templatization-roadmap.md` | ✅ |
| `docs/portfolio/PORTFOLIO.md` | ⚠️ **낡음** (2026-06) — 수치와 서사가 현재 실체와 다름. 갱신 또는 폐기 필요. 화면은 `/portfolio` |
| `AGENTS.md` | ✅ `CLAUDE.md`를 가리키는 포인터 (Codex용, gitignore) |

## 알려진 공백

- **자동화 테스트 0** — 규칙 엔진·유사도·파서 같은 순수 함수가 단위 테스트 없이 타입 검사(`tsc --noEmit`)·`scripts/verify-todo.mjs`·골든 픽스처·수동 브라우저 검증에 의존한다.
- **거대 컴포넌트** — `TcPanel.tsx` 1,671줄 / `WorkspaceView.tsx` 1,266줄 / `lib/workspace/repo.ts` 1,134줄. 인라인 스타일 토큰과 Tailwind가 혼재.
- **미사용 의존성** — `jsdom`·`he`·AI SDK 3종이 코드에서 쓰이지 않는다(CLI 서브프로세스 방식으로 전환 후 잔재). 정리 필요.
- **미완 지표** — "배포 전 차단"은 정의 확정 대기 상태로 컬럼만 예약(NULL). 정의 없이 화면을 만들면 숫자가 거짓말을 한다.
- **앱 E2E 사각** — `test_run` 행이 없는 자산은 방치 감지에 걸리지 않는다.
- **인증 구조의 상한** — CLI 서브프로세스 + 개인 구독 방식은 개인·팀 템플릿까지가 상한이다. 불특정 다수 SaaS로 가려면 Agent SDK + API 키(과금) 전환이 필요하다.
