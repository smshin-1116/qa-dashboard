# QA Dashboard — AI 에이전트 기반 QA 자동화 플랫폼

> Confluence 기획서 한 줄로 **TC 설계 → 작성 → 리뷰 → 수정**까지 자동 수행하는,
> Claude Code CLI를 에이전트 백엔드로 래핑한 풀스택 QA 자동화 도구.
>
> 10년차 QA 엔지니어가 **직접 설계·구현**한 사내 실사용 프로젝트입니다.

---

## TL;DR (30초 요약)

- **무엇을** — 기획서(Confluence/Jira) URL을 넣으면 AI 에이전트 4명이 릴레이로 테스트 케이스를 만들고, 스스로 리뷰하고, 고쳐서 11컬럼 표준 TC와 Excel/Google Sheets까지 뽑아주는 웹 플랫폼.
- **왜** — 수작업 TC 작성·리뷰에 들어가던 시간을 줄이고, QA 품질 기준(EVAL)을 **사람이 아니라 시스템이 강제**하도록 만들기 위해.
- **어떻게** — Next.js 15 풀스택. `claude` CLI를 subprocess로 띄워 stream-json을 실시간 파싱하고, 단계별 독립 세션으로 묶은 **다단계 에이전트 파이프라인**을 SSE로 스트리밍. MCP로 Jira·Confluence·Figma·GitHub·Slack 연동.
- **규모** — TypeScript ~5,000 LOC, 33 커밋(2025.08 ~ 2026.06), 브랜치 전략(main/feat) 기반 단독 개발.

---

## 1. 문제 정의

QA 실무에서 테스트 케이스 작성은 반복적이지만 품질 편차가 큰 작업이다.

| 기존 방식의 문제 | 영향 |
|------------------|------|
| 기획서 → TC 수기 변환 | 케이스당 수십 분, 기획 변경 시 재작업 |
| 작성자별 품질 편차 | 추상적 표현("정상 동작 확인"), 검증단계 편향(정상 케이스만) |
| 리뷰가 사람 손에 의존 | 커버리지 누락·중복을 놓침, 리뷰어 컨디션에 좌우 |
| 산출물 포맷 불일치 | 팀마다 다른 컬럼, Excel 수작업 정리 |

> **핵심 인사이트:** TC의 품질 기준은 이미 머릿속에 있다. 그렇다면 그 기준을 **코드로 명문화해서 AI에게 시키고, AI 결과를 다시 그 기준으로 채점**하면 사람은 판단에만 집중할 수 있다.

---

## 2. 솔루션 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (Next.js / React 19 / Zustand + IndexedDB)              │
│  ┌───────────┐  ┌──────────────┐  ┌────────────────────────┐   │
│  │ Chat UI    │  │ Pipeline UI  │  │ Quality Scorecard      │   │
│  │ (스트리밍)  │  │ (4단계 진행)  │  │ (EVAL 채점 · A~F 등급)  │   │
│  └─────┬─────┘  └──────┬───────┘  └───────────┬────────────┘   │
└────────┼───────────────┼──────────────────────┼─────────────────┘
         │ fetch(stream)  │ SSE                  │ (client-side)
┌────────▼───────────────▼──────────────────────▼─────────────────┐
│  Next.js Route Handlers (Edge of Node)                           │
│   /api/dashboard/chat   /api/pipeline/run   /api/sheets/push     │
│        │                      │                                   │
│        ▼ spawn('claude', --output-format stream-json --resume)   │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  Claude Code CLI (subprocess, 에이전트 런타임)          │       │
│  │   designer → writer → reviewer → fixer                 │       │
│  └───────────────────────┬──────────────────────────────┘       │
└──────────────────────────┼──────────────────────────────────────┘
                           ▼ MCP
        Jira · Confluence · Figma · GitHub · Slack
```

**설계 원칙**
- **CLI를 런타임으로** — 자체 LLM 호출 코드를 짜는 대신, 이미 도구·MCP·세션 관리를 갖춘 `claude` CLI를 프로세스로 감싸 비즈니스 로직(QA 워크플로우)에만 집중.
- **단계별 독립 세션** — 파이프라인 각 단계를 별도 세션으로 실행해 컨텍스트 누적을 끊고 토큰을 절감.
- **품질은 클라이언트에서 결정론적으로 채점** — AI 출력의 품질 판정을 LLM에 또 맡기지 않고, 파싱 가능한 룰 엔진으로 재현 가능하게 측정.

---

## 3. 강조 포인트 ① — AI / 자동화 설계

### 3-1. 다단계 에이전트 파이프라인 (designer → writer → reviewer → fixer)

Confluence URL 하나를 받아 **4개의 전문 에이전트가 릴레이**로 동작한다. 각 단계는 직전 단계의 산출물을 입력으로 받지만, **세션은 독립**시켜 컨텍스트 오염과 토큰 폭증을 막았다.

| 단계 | 에이전트 | 입력 | 산출물 |
|------|----------|------|--------|
| 📐 설계 | `designer` | 기획서 URL | 대/중/소분류 구조, 리스크 레벨, 커버리지 매핑표, 검증단계 권장 배분 |
| ✏️ 작성 | `writer` | 설계 구조 | 11컬럼 TC 테이블 (검증단계 분포 목표 강제) |
| 🔍 리뷰 | `reviewer` | TC 목록 | EVAL 13기준 검토 보고서, CRITICAL~LOW 이슈 |
| 🔧 수정 | `fixer` | TC + 리뷰 | 이슈 반영한 최종 TC (재채번·분포 재집계) |

```ts
// app/api/pipeline/run/route.ts — 단계별 독립 세션으로 컨텍스트 누적 차단
for (let i = 0; i < STAGE_CONFIGS.length; i++) {
  const stage = STAGE_CONFIGS[i];
  const userMessage = stage.buildMessage(confluenceUrl, stageOutputs);
  const result = await runClaude({
    message: userMessage,
    systemPrompt: SYSTEM_PROMPTS[stage.mode],
    claudeSessionId: null,             // ← 각 단계 독립 세션 (토큰 절감의 핵심)
    onChunk: (c) => send({ type: 'chunk', content: c }),
    onTool:  (l) => send({ type: 'tool', label: l }),
  });
  stageOutputs.push(result.content);   // 다음 단계 입력으로만 명시적 전달
  send({ type: 'stage_done', stageIndex: i, /* ... */ });
}
```

> **설계 의도:** "컨텍스트를 계속 이어 붙이면 편하지만 토큰이 폭증한다. 단계 간 의존성은 *산출물 전달*만으로 충분하다"는 판단으로 세션을 끊고, 필요한 직전 결과만 프롬프트에 주입. → 커밋 `perf: 파이프라인 단계별 독립 세션으로 컨텍스트 토큰 절감`

### 3-2. 프롬프트를 "QA 방법론"으로 엔지니어링

5개 에이전트 모드마다 시스템 프롬프트를 분리하고, QA 도메인 규칙을 **프롬프트에 코드처럼 명문화**했다. 예: writer 모드의 품질 규칙 표.

| 규칙 | 위반 예시 | 강제 결과 |
|------|----------|-----------|
| 1 TC = 1 검증 포인트 | "A되고 B되는지 확인" | TC 자동 분리 |
| 추상 표현 금지 | "정상 동작 확인" | "배차 실행 시 결과 화면으로 이동하는지 확인"으로 구체화 |
| 테스트 스텝 3요소 | "배차하면 확인" | "[사전상태]→[행동]→[결과]" 구조 강제 |
| 검증단계 분포 | 정상 케이스 편중 | 부정+예외 49~60% 목표, 미달 시 보강 후 재출력 |

### 3-3. MCP 멀티 도구 오케스트레이션

`claude` CLI가 MCP로 연결한 외부 도구(Jira/Confluence/Figma/GitHub/Slack)를 그대로 활용하되, 사용자에게는 **원시 도구명 대신 한국어 라벨**로 진행 상황을 노출.

```ts
const TOOL_LABELS = {
  mcp__atlassian__getConfluencePage:      'Confluence 페이지 읽기',
  mcp__atlassian__createJiraIssue:        'Jira 티켓 생성',
  mcp__claude_ai_Figma__get_design_context:'Figma 디자인 분석',
  mcp__github__create_pull_request:       'GitHub PR 생성',
  // 매핑 없으면 'mcp__a__b' → 'b'로 graceful fallback
};
```

또한 입력창에 `*.atlassian.net/wiki/...` 또는 `/browse/PROJ-123` URL을 붙여넣으면 **배너로 자동 감지**해 "TC 설계 분석 / TC 바로 생성 / 버그 분석" 원클릭 액션으로 연결하는 워크플로우를 구현.

---

## 4. 강조 포인트 ② — 엔지니어링 역량

자체 LLM SDK 코드가 아니라 **CLI subprocess를 다루는 까다로운 영역**에서 실제 버그를 직접 진단하고 해결했다.

### 4-1. subprocess stream-json 실시간 파싱

`claude --output-format stream-json`의 출력은 줄 단위 JSON이지만 네트워크 청크 경계가 줄을 가른다. **버퍼 캐리오버**로 잘린 줄을 안전하게 복원한다.

```ts
proc.stdout.on('data', (chunk: Buffer) => {
  stdoutBuffer += chunk.toString();
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop() ?? '';   // ← 마지막 불완전 줄은 버퍼에 남겨 다음 청크와 결합
  for (const line of lines) { /* JSON.parse(line) ... */ }
});
```

### 4-2. 다중 텍스트 블록 커서 — 중복/누락 동시 해결

stream-json은 텍스트 블록의 **누적 전체**를 매번 보낸다. 단순히 매번 출력하면 중복되고, 단일 커서만 쓰면 도구 호출 후 새 메시지에서 텍스트가 누락된다. **블록 인덱스별 독립 커서 + 메시지 ID 변경 감지**로 둘 다 잡았다.

```ts
if (msg.id !== currentMsgId) {        // 도구 사용 후 새 assistant 메시지 → 커서 리셋
  currentMsgId = msg.id;
  lastTextLengths.clear();
}
msg.content.forEach((block, blockIdx) => {
  if (block.type === 'text') {
    const prev = lastTextLengths.get(blockIdx) ?? 0;
    const effectivePrev = block.text.length < prev ? 0 : prev;  // 짧아지면 새 턴 (fallback)
    const newText = block.text.slice(effectivePrev);            // 증분만 전송
    if (newText) { controller.enqueue(enc.encode(newText)); lastTextLengths.set(blockIdx, block.text.length); }
  }
});
```
→ 커밋 `fix: 다중 텍스트 블록 처리 시 중복/누락 방지를 위한 블록별 독립 커서 적용`, `fix: tool 사용 후 assistant 응답 텍스트 누락 버그 수정`

### 4-3. 세션 충돌·인증 오류를 사용자 언어로 분류

동시 사용 시 OAuth refresh token 회전으로 인증이 깨지는 등, CLI exit code + stderr를 보고 **원인별 한국어 메시지**로 변환해 사용자 경험을 지켰다.

```ts
function classifyClaudeError(code, stderr) {
  if (/401|unauthorized|invalid_grant|refresh token/.test(lower))
    return '인증이 만료되었거나 다른 Claude Code 세션과 토큰이 충돌했습니다...';
  if (/429|rate limit|quota/.test(lower)) return '요청 한도에 도달했습니다...';
  if (/econnreset|etimedout|network/.test(lower)) return '네트워크 오류로 연결하지 못했습니다...';
  // ...
}
```
→ 커밋 `fix: Claude CLI 오류를 한국어로 분류해 스트림에 노출`

### 4-4. 결정론적 품질 채점 엔진 (`lib/tcQuality.ts`)

AI 출력의 품질을 **다시 LLM에 묻지 않고** 가중치 룰 엔진으로 재현 가능하게 채점한다. 마크다운 TC를 파싱해 점수·등급·이슈를 산출.

| 체크 (EVAL) | 가중치 | 탐지 방식 |
|-------------|--------|-----------|
| 검증단계 분포 | 30 | 부정+예외 비율 49~65% 구간 판정 |
| 필수 필드 완전성 | 25 | 테스트 스텝·기대결과 공란 비율 |
| 추상 표현 탐지 | 20 | 키워드 사전("정상적으로" 등) 매칭 |
| 1TC=1검증포인트 | 10 | 복합 패턴 정규식("~하고 ~되는지") |
| TC ID 유효성 | 10 | 형식·중복 검사 |
| 플랫폼 값 적정성 | 5 | 허용값 화이트리스트 |

```ts
const score = Math.round((earned / totalWeight) * 100);   // pass=만점, warn=절반, fail=0
const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : ...; // A~F
```

### 4-5. 그 외 엔지니어링 디테일
- **세션 영속성** — Zustand 상태 + IndexedDB(`idb`) 저장, 사이드바 핀·이름변경·검색·시간 그룹화.
- **워크스페이스 분리** — TC 자동화 / 기능 분석 화면을 `kind`로 분리, 레거시 세션 자동 마이그레이션.
- **TypeScript strict** — `any` 전면 금지, 환경변수 null 체크, `unknown` 기반 안전 파싱.
- **마크다운/코드 렌더링** — `marked` + `shiki` 신택스 하이라이트, TC 테이블 전용 스타일.
- **산출물 내보내기** — `xlsx`/`exceljs` Excel, `googleapis` 서비스 계정으로 Google Sheets 직접 푸시(시트 자동 생성·서식).

---

## 5. 기술 스택

| 영역 | 기술 |
|------|------|
| 프레임워크 | Next.js 15 (App Router, Turbopack), React 19, TypeScript 5 (strict) |
| 상태/저장 | Zustand 5, IndexedDB (`idb`) |
| AI/에이전트 | Claude Code CLI (subprocess), MCP, `@anthropic-ai/sdk`, `@google/generative-ai`, `openai` |
| 스트리밍 | SSE (`ReadableStream`), stream-json 파싱 |
| 연동 | Atlassian(Jira·Confluence) · Figma · GitHub · Slack (MCP), Google Sheets (`googleapis`) |
| 산출물 | `xlsx`, `exceljs`, `marked`, `shiki` |
| 스타일 | Tailwind CSS v4 |

---

## 6. 임팩트

- 기획서 → 리뷰 완료 TC까지 **한 번의 입력**으로 자동화 (기존 다단계 수작업 → 파이프라인 1회 실행)
- TC 품질을 **사람이 아닌 시스템이 채점·강제** → 작성자별 편차 제거, 검증단계 분포·추상표현을 정량 관리
- Confluence·Jira·Figma·GitHub를 한 화면에서 다루는 **QA 통합 워크벤치**로 도구 전환 비용 절감
- QA 엔지니어가 **요구사항 정의부터 풀스택 구현·운영까지** 직접 수행 — 도메인 이해와 엔지니어링의 결합

---

## 7. 한눈에 보기

```
qa-dashboard/
├── app/
│   ├── api/
│   │   ├── dashboard/chat/route.ts    # 채팅 API · 시스템 프롬프트 · 스트림 파싱
│   │   ├── pipeline/run/route.ts      # 4단계 에이전트 파이프라인 (SSE)
│   │   ├── dashboard/mcp-status/      # MCP 연결 상태
│   │   └── sheets/push/route.ts       # Google Sheets 직접 푸시
│   └── dashboard/                     # TC 자동화 · 기능 분석 워크스페이스
├── lib/
│   ├── claudeRunner.ts                # claude CLI subprocess 래퍼
│   ├── tcQuality.ts                   # EVAL 품질 채점 엔진
│   ├── tcExport.ts                    # 11컬럼 TC · Excel 내보내기
│   └── indexeddb/sessionStore.ts      # 세션 영속화
├── components/dashboard/              # Chat · Pipeline · Quality · Sidebar UI
├── constants/                        # 에이전트 모드 · 모델 · 워크스페이스 정의
└── stores/useSessionStore.ts          # Zustand 세션 상태
```

---

<sub>본 문서는 면접용 포트폴리오로 작성되었습니다. 코드·아키텍처에 대한 상세 설명이나 라이브 데모가 필요하시면 말씀해 주세요.</sub>
