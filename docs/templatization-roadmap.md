# 템플릿화 로드맵

이 툴을 Roouty 외 프로젝트(SI 등, 각자 Claude 구독 보유)에서 재사용하기 위한 3층 분리
설계와 이행 순서. **신규 기능은 처음부터 이 3층 중 어디인지 분류해서 개발한다.**

## 3층 모델

| 층 | 정의 | 규칙 |
|----|------|------|
| 🔵 **코어** | 제품·도메인과 무관한 엔진·프레임워크·UI 셸 | 도메인 리터럴 절대 금지 |
| 🟡 **프로파일** | 프로젝트별 값(설정 1묶음) | `config/projectProfile.ts` + `.env.local` |
| 🟢 **플러그인** | 프로젝트 전용 구현(갈아끼움) | 인터페이스 뒤로 숨김 |

## 현재 파일 배치 (as-is)

### 🔵 코어 — 이미 제네릭 (그대로 재사용)
- `stores/useSessionStore.ts` — 세션·IndexedDB
- `lib/workspace/{db,schema,repo}.ts` — SQLite 저장소
- `lib/claudeRunner.ts`, `app/api/pipeline/run` — CLI 파이프라인 엔진 (프롬프트 도메인부만 프로파일로)
- `app/api/dashboard/chat` — CLI 실행·SSE (프롬프트 조각은 프로파일로)
- `lib/tcExport.ts`, `lib/tcXlsx.ts`, `lib/tcQuality.ts`, `lib/tcId.ts` — TC 구조·엑셀·품질
- `lib/workspace/todo.ts` — 오늘 규칙 (임계값은 상단 상수)
- `components/dashboard/**` — WorkspaceView·TcPanel·AutomationView·패널 등 UI 셸
- `constants/workspaces.ts` — 탭 레지스트리(기구는 코어, 항목은 프로파일화 가능)
- `lib/workspace/collectors/{shared,index}.ts` — 수집 프레임워크

### 🟡 프로파일 — 프로젝트별 값
- `config/projectProfile.ts` *(SI에서 시작)* — 제품명·명세 스킬·stage URL·역할 모델·TC 예시행·작성 규칙 예시·수집 대상 레포·영역 분류·카탈로그 접두사
- `lib/prompts/tcPrompts.ts` *(SI에서 시작)* — 프로파일을 읽어 프롬프트 도메인 조각 생성
- `.env.local` — `CONFLUENCE_*`, `GITHUB_REPO_*`, `WEB_E2E_DIR`, stage 자격증명, QA 계정, (예정) Jenkins/Actions 엔드포인트, Slack

### 🟢 플러그인 — 프로젝트 전용 (인터페이스화 필요)
- `lib/workspace/collectors/{jira,datadog,stagePr,apiTest,webE2e}.ts` — 트래커·CI 종속 → Collector 계약 뒤로
- `lib/receipt/**` + 인수증 탭 — Roouty 전용 bespoke 툴 → 선택 모듈
- (예정) 실행 트리거 — Jenkins REST · GitHub Actions workflow_dispatch 등 프로젝트 CI

## 이행 순서 (phases)

1. **프로파일 골격 + 프롬프트 중립화** — ✅ SI 브랜치에서 완료 (`projectProfile.ts`·`tcPrompts.ts`·골든 스냅샷)
2. **수집기 플러그인 인터페이스** — `Collector` 계약 정의(`collect(profile) → 표준 신호[]`), Jira/DD/stagePr/apiTest/webE2e를 그 뒤로, 프로파일이 사용할 수집기 목록을 지정
3. **bespoke 툴 분리** — 인수증 등 프로젝트 전용 탭/툴을 옵션 모듈로 (프로파일이 켜고 끔)
4. **탭 레지스트리 프로파일화** — `constants/workspaces.ts` 항목을 프로파일에서 구성(탭 on/off)
5. **셋업 위저드** — `scripts/setup-profile` : 프로파일 + `.env.local` 생성 가이드

## 신규 기능 개발 체크리스트

- [ ] 이 기능은 코어/프로파일/플러그인 중 무엇인가?
- [ ] 도메인 리터럴(배차·주문·roouty-spec·tms-stage·Jenkins job명 등)을 코드에 박지 않았는가? → 프로파일 경유
- [ ] Roouty 전용 결합이 생기면 명시했는가?
- [ ] 코어/프로파일을 건드렸다면 "roouty 동작 무변경"을 골든/테스트로 보장했는가?

## 인증 제약 (범용성의 상한)

- **개인·팀 도구 템플릿**(각자 Claude 구독) → 현 구조(CLI 서브프로세스 + 구독 인증)가 최적. 토큰 과금 0.
- **불특정 다수 SaaS 제품** → Claude Agent SDK + **API 키(토큰 과금)** 필요. Anthropic 정책상
  서드파티 앱이 구독 로그인을 프로그램적으로 못 씀. 제품화 시에만 SDK 전환 검토.
