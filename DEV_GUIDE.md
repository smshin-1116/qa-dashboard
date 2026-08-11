# QA Dashboard 개발 가이드

> 최종 업데이트: 2026-04-12

---

## 1. 브랜치 전략

| 브랜치 | 목적 | 서버 포트 |
|--------|------|-----------|
| `main` | 안정 버전 (실사용) | 3000 |
| `feat/enhancement` | 고도화 작업 | 3001 |

---

## 2. 개발 서버 실행

```bash
# 프로젝트 경로로 이동
cd /Users/smshin/Projects/qa-dashboard

# main 브랜치 (안정 버전)
git checkout main
npm run dev:main        # http://localhost:3000/dashboard

# feat/enhancement 브랜치 (고도화 버전)
git checkout feat/enhancement
npm run dev:enhancement # http://localhost:3001/dashboard
```

두 브랜치를 동시에 실행하려면 터미널 탭을 두 개 열어서 각각 실행합니다.

### 파이프라인 재생 모드 (토큰 절약)

파이프라인은 4단계 모두 `claude` CLI를 새 세션으로 띄웁니다. CLI 호출 1회당 하네스
고정 오버헤드가 **실측 약 30k 토큰**이라, 실작업 전에 이미 120k를 씁니다. 화면·스트리밍·
엑셀 다운로드를 확인하려고 반복 실행하면 그것만으로 구독 한도가 깎입니다.

그래서 **한 번만 실제로 실행해 기록해두고, 그 뒤로는 기록본을 재생**합니다.

**서버는 하나입니다.** 두 개를 동시에 띄우는 게 아니라, 같은 서버를 그때 필요한 모드로
켜는 것입니다. 최초 1회만 기록 모드로 실제 실행하고, 그 뒤로는 재생 모드로 씁니다.

```bash
# ① 최초 1회 — 기록 모드. 여기서만 실제 토큰을 씁니다.
npm run dev:record
#   → 브라우저에서 파이프라인을 한 번 실제로 실행
#   → 완료되면 터미널에 "[pipeline] fixture 저장: .../page-123456.json"

# ② Ctrl+C로 끄고, 재생 모드로 다시 띄우기 (이후 계속 이 모드)
npm run dev:mock
#   → 실행 버튼을 몇 번 눌러도 토큰 0

# 평소 개발 (파이프라인을 안 건드릴 때) — 기존과 동일
npm run dev
```

두 모드를 동시에 켜지 않습니다. 둘 다 지정하면 재생 분기가 먼저 걸려 기록은 되지 않습니다.

기획서가 바뀌어 새 기록본이 필요할 때만 `npm run dev:record`로 다시 한 번 돌리면 됩니다.

```bash
# 재생 속도 조절 (기본 12배속)
PIPELINE_MOCK=1 PIPELINE_MOCK_SPEED=30 npm run dev

# 매번 지정하기 번거로우면 .env.local 에 넣어두고, 실제 실행이 필요할 때만
# 커맨드라인으로 덮어쓸 수 있습니다 (셸 환경변수가 .env.local 보다 우선).
#   .env.local:  PIPELINE_MOCK=1
#   실제 실행:   PIPELINE_MOCK=0 PIPELINE_RECORD=1 npm run dev
```

- 재생 중에는 파이프라인 패널에 **`재생 모드 · 실제 호출 없음`** 배지가 뜹니다.
  저장본을 실제 결과로 착각하지 않도록 항상 표시됩니다.
- URL이 정확히 일치하는 기록본이 없으면 **가장 최근 기록본**으로 재생합니다.
  아직 안 돌려본 URL로도 화면 확인이 되도록 한 의도적 동작입니다.
- 실패한 실행은 기록하지 않습니다 (에러만 재생하는 기록본이 기본값이 되는 것을 방지).
- `fixtures/pipeline/` 은 Confluence 기획 내용을 담으므로 **gitignore 처리**되어 있습니다.
  팀원은 각자 `PIPELINE_RECORD=1` 로 한 번 기록해서 쓰면 됩니다.

관련 파일: `lib/pipelineFixture.ts`, `types/pipeline.ts`, `app/api/pipeline/run/route.ts`

---

## 3. 지금까지 구현한 내용 (feat/enhancement 기준)

### ✅ A. 시스템 프롬프트 강화
- **파일**: `app/api/dashboard/chat/route.ts`
- 단일 프롬프트 → `BASE_CONTEXT` + `TC_TABLE_FORMAT` + `MODE_PROMPTS` 구조로 분리
- TC 11컬럼 형식 예시 및 Roouty 서비스 도메인 컨텍스트 포함
- 모드별 시스템 프롬프트 자동 선택 (`buildSystemPrompt(mode)`)

### ✅ B. 에이전트 모드 선택기
- **파일**: `constants/agentModes.ts`, `components/dashboard/header/DashboardHeader.tsx`
- 헤더에 모드 드롭다운 추가 (클릭 외부 닫힘 처리 포함)
- 5가지 모드: 일반 QA / TC 설계 / TC 작성 / QA 리뷰 / TC 수정
- 선택 모드 `localStorage` 저장 (새로고침 유지)
- 모드별 컬러 닷 + 현재 모드 "현재" 뱃지 표시

### ✅ C. TC 컬럼 11개 표준화
- **파일**: `lib/tcExport.ts`
- 기존 7컬럼 → 11컬럼으로 확장 (하위 호환 유지)

| 컬럼 | 기본값 |
|------|--------|
| TC-ID | 자동 생성 (TC-001 형식) |
| 대분류 | - |
| 중분류 | - |
| 소분류 | - |
| 검증단계 | - |
| 전제조건 | - |
| 테스트 스텝 | - |
| 기대결과 | - |
| 플랫폼 | `PC(Web)` |
| 결과 | `Not Test` |
| 비고 | - |

- `aoa_to_sheet`로 컬럼 순서 보장
- 헤더 행 고정 (`ws['!freeze']`)
- 구버전 헤더 자동 매핑 (`normalizeHeader()`)

### ✅ E. Confluence 원클릭 워크플로우
- **파일**: `components/dashboard/input/ChatInput.tsx`
- 입력창에 `*.atlassian.net/wiki/...` URL 입력 시 배너 자동 감지
- 3가지 액션 버튼:
  - **TC 설계 분석** → `designer` 모드 전환 + 분석 프롬프트 자동 전송
  - **TC 바로 생성** → `writer` 모드 전환 + 생성 프롬프트 자동 전송
  - **그냥 보내기** → 모드 유지, 입력 그대로 전송

### ✅ Jira 원클릭 워크플로우
- **파일**: `components/dashboard/input/ChatInput.tsx`
- 입력창에 `*.atlassian.net/browse/PROJ-123` URL 입력 시 배너 자동 감지
- 티켓 ID 뱃지 표시 (예: `ROOUTY-456`)
- 3가지 액션 버튼:
  - **TC 생성** → `writer` 모드 전환 + TC 생성 프롬프트
  - **버그 분석** → `reviewer` 모드 전환 + 재현스텝·누락정보·심각도 분석 프롬프트
  - **그냥 보내기** → 모드 유지, 입력 그대로 전송

### ✅ 듀얼 서버 설정
- **파일**: `package.json`
- `npm run dev:main` (포트 3000) / `npm run dev:enhancement` (포트 3001)

---

## 4. 남은 고도화 로드맵

### D. TC 품질 스코어카드
EVAL 13개 기준으로 TC 자동 채점, ChatArea에 품질 리포트 카드 표시

### F. 파이프라인 진행 UI
RightPanel 개편 → 설계 → 작성 → 리뷰 → 수정 단계 시각화

### G. 백엔드 자동화 파이프라인
`POST /api/pipeline/run` — Confluence URL 입력 → 단계별 자동 실행 → SSE 진행 상황 전송

### H. Google Sheets 직접 연동
MCP google-sheets 서버 추가, TC 생성 즉시 Sheets 푸시

---

## 5. 터미널 재시작 후 이어서 작업하기

### Claude Code로 이어서 작업하는 방법

터미널을 새로 열고 아래 순서대로 실행합니다.

```bash
# 1. 프로젝트 경로로 이동
cd /Users/smshin/Projects/qa-dashboard

# 2. 고도화 브랜치로 전환
git checkout feat/enhancement

# 3. 개발 서버 실행 (백그라운드 또는 별도 탭)
npm run dev:enhancement

# 4. Claude Code 실행
claude
```

### Claude Code에서 작업 재개 요청 예시

```
고도화 작업 이어서 진행하자. 
지금까지 A/B/C/E/Jira 워크플로우 완료됐고,
다음은 D. TC 품질 스코어카드 구현해줘.
```

Claude Code는 이 프로젝트의 메모리(MEMORY.md)와 코드를 읽어서 이전 작업 맥락을 자동으로 파악합니다.

### 작업 중 자주 쓰는 명령어

```bash
# 타입 체크
npx tsc --noEmit

# 현재 브랜치 확인
git status
git branch

# feat/enhancement → main 머지 (안정화 후)
git checkout main
git merge feat/enhancement
```

---

## 6. 주요 파일 위치

```
qa-dashboard/
├── app/
│   ├── api/dashboard/chat/route.ts   # AI 채팅 API, 시스템 프롬프트
│   └── dashboard/page.tsx            # 메인 페이지, 상태 관리
├── components/dashboard/
│   ├── header/DashboardHeader.tsx    # 에이전트 모드 선택기
│   ├── input/ChatInput.tsx           # 입력창 + URL 원클릭 워크플로우
│   ├── chat/ChatArea.tsx             # 채팅 영역
│   └── panel/RightPanel.tsx         # 우측 패널 (MCP 도구 목록)
├── constants/
│   ├── agentModes.ts                 # 에이전트 모드 정의 및 localStorage
│   └── modelSupport.ts              # AI 모델 설정
├── lib/tcExport.ts                   # TC 추출 및 XLSX 내보내기
├── stores/useSessionStore.ts         # Zustand 세션 상태
├── types/session.ts                  # 타입 정의 (AIModel, AgentMode 등)
└── DEV_GUIDE.md                      # 이 파일
```
