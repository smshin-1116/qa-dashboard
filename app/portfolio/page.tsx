import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Portfolio · QA Dashboard',
  description: 'AI 에이전트 기반 QA 자동화 플랫폼 — 포트폴리오',
};

// ─── 데이터 ────────────────────────────────────────────────────────────────────

const STATS = [
  { value: '~5,000', label: 'TypeScript LOC' },
  { value: '33', label: 'Commits' },
  { value: '4', label: '단계 에이전트 파이프라인' },
  { value: '5', label: 'MCP 연동 (Jira·Confluence·Figma·GitHub·Slack)' },
];

const PIPELINE = [
  { emoji: '📐', mode: 'designer', label: 'TC 설계', out: '대/중/소분류 · 리스크 레벨 · 커버리지 매핑 · 검증단계 배분' },
  { emoji: '✏️', mode: 'writer', label: 'TC 작성', out: '11컬럼 TC 테이블 (검증단계 분포 목표 강제)' },
  { emoji: '🔍', mode: 'reviewer', label: 'QA 리뷰', out: 'EVAL 13기준 검토 · CRITICAL~LOW 이슈 도출' },
  { emoji: '🔧', mode: 'fixer', label: 'TC 수정', out: '이슈 반영 · 재채번 · 분포 재집계한 최종 TC' },
];

const QUALITY_CHECKS = [
  { eval: '검증단계 분포', weight: 30, how: '부정+예외 비율 49~65% 구간 판정' },
  { eval: '필수 필드 완전성', weight: 25, how: '테스트 스텝·기대결과 공란 비율' },
  { eval: '추상 표현 탐지', weight: 20, how: '키워드 사전("정상적으로" 등) 매칭' },
  { eval: '1TC=1검증포인트', weight: 10, how: '복합 패턴 정규식("~하고 ~되는지")' },
  { eval: 'TC ID 유효성', weight: 10, how: '형식·중복 검사' },
  { eval: '플랫폼 값 적정성', weight: 5, how: '허용값 화이트리스트' },
];

const ENGINEERING = [
  {
    title: 'subprocess stream-json 실시간 파싱',
    body: '네트워크 청크 경계가 줄 단위 JSON을 가르는 문제를, 버퍼 캐리오버로 잘린 줄을 다음 청크와 결합해 안전하게 복원.',
    commit: 'stdoutBuffer = lines.pop()',
  },
  {
    title: '다중 텍스트 블록 커서 (중복/누락 동시 해결)',
    body: 'stream-json이 누적 전체를 매번 보내는 특성에서, 블록 인덱스별 독립 커서 + 메시지 ID 변경 감지로 중복 출력과 도구 호출 후 텍스트 누락을 모두 해결.',
    commit: 'fix: 블록별 독립 커서 적용',
  },
  {
    title: '단계별 독립 세션으로 토큰 절감',
    body: '파이프라인 단계 간 의존성을 산출물 전달만으로 해결하고 세션은 끊어, 컨텍스트 누적으로 인한 토큰 폭증을 차단.',
    commit: 'perf: 컨텍스트 토큰 절감',
  },
  {
    title: '오류의 한국어 분류',
    body: 'OAuth 토큰 충돌·rate limit·네트워크 오류 등 CLI exit code와 stderr를 원인별 한국어 메시지로 변환해 UX 보호.',
    commit: 'fix: Claude CLI 오류 한국어 분류',
  },
  {
    title: '결정론적 품질 채점 엔진',
    body: 'AI 출력 품질을 다시 LLM에 묻지 않고 가중치 룰 엔진으로 재현 가능하게 채점 (A~F 등급).',
    commit: 'lib/tcQuality.ts',
  },
  {
    title: '세션 영속성 · 워크스페이스 분리',
    body: 'Zustand + IndexedDB로 세션 저장(핀·검색·시간 그룹화), TC 자동화/기능 분석 화면을 kind로 분리하고 레거시 세션 자동 마이그레이션.',
    commit: 'Zustand + idb',
  },
];

const STACK = [
  { area: '프레임워크', items: 'Next.js 15 (App Router) · React 19 · TypeScript 5 (strict)' },
  { area: 'AI / 에이전트', items: 'Claude Code CLI (subprocess) · MCP · Anthropic/Gemini/OpenAI SDK' },
  { area: '스트리밍', items: 'SSE (ReadableStream) · stream-json 파싱' },
  { area: '상태 / 저장', items: 'Zustand 5 · IndexedDB (idb)' },
  { area: '연동', items: 'Atlassian · Figma · GitHub · Slack (MCP) · Google Sheets (googleapis)' },
  { area: '산출물 / 스타일', items: 'xlsx · exceljs · marked · shiki · Tailwind CSS v4' },
];

// ─── 공통 컴포넌트 ──────────────────────────────────────────────────────────────

function Section({ id, kicker, title, children }: { id: string; kicker: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mx-auto max-w-5xl px-6 py-14 border-t border-[#1e2535]">
      <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">{kicker}</p>
      <h2 className="mt-2 text-2xl font-bold text-slate-100">{title}</h2>
      <div className="mt-7">{children}</div>
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#1e2535] bg-[#0e1320] p-5 transition-colors hover:border-indigo-500/40">
      {children}
    </div>
  );
}

// ─── 페이지 ─────────────────────────────────────────────────────────────────────

export default function PortfolioPage() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] text-slate-300 antialiased">
      {/* Hero */}
      <header className="relative overflow-hidden border-b border-[#1e2535]">
        <div className="absolute inset-0 bg-[radial-gradient(60%_120%_at_50%_0%,rgba(99,102,241,0.18),transparent)]" />
        <div className="relative mx-auto max-w-5xl px-6 py-20">
          <span className="inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-300">
            ● 사내 실사용 · 단독 풀스택 개발
          </span>
          <h1 className="mt-6 text-4xl font-bold leading-tight text-slate-50 sm:text-5xl">
            QA Dashboard
            <span className="block bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">
              AI 에이전트 기반 QA 자동화 플랫폼
            </span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-400">
            기획서 URL 한 줄로 <strong className="text-slate-200">TC 설계 → 작성 → 리뷰 → 수정</strong>까지
            자동 수행하는, Claude Code CLI를 에이전트 백엔드로 래핑한 풀스택 도구.
            <br />
            10년차 QA 엔지니어가 요구사항 정의부터 구현·운영까지 직접 수행했습니다.
          </p>

          <dl className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.label} className="rounded-xl border border-[#1e2535] bg-[#0e1320] p-4">
                <dt className="text-2xl font-bold text-indigo-300">{s.value}</dt>
                <dd className="mt-1 text-xs leading-snug text-slate-500">{s.label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      {/* 문제 정의 */}
      <Section id="problem" kicker="Problem" title="왜 만들었나">
        <p className="leading-relaxed text-slate-400">
          테스트 케이스 작성은 반복적이지만 작성자별 품질 편차가 크고, 리뷰는 사람 손에 의존해 커버리지 누락·중복을 놓치기 쉽다.
        </p>
        <blockquote className="mt-5 rounded-r-lg border-l-4 border-indigo-500 bg-indigo-500/5 px-5 py-4 text-slate-300">
          핵심 인사이트 — TC 품질 기준은 이미 머릿속에 있다. 그 기준을 <strong className="text-indigo-200">코드로 명문화해 AI에게 시키고,
          AI 결과를 다시 그 기준으로 채점</strong>하면, 사람은 판단에만 집중할 수 있다.
        </blockquote>
      </Section>

      {/* 강조 ① AI/자동화 설계 */}
      <Section id="pipeline" kicker="Focus ① — AI / Automation Design" title="다단계 에이전트 파이프라인">
        <p className="mb-6 leading-relaxed text-slate-400">
          Confluence URL 하나로 4개의 전문 에이전트가 릴레이로 동작한다. 각 단계는 직전 산출물을 입력받되
          <strong className="text-slate-200"> 세션은 독립</strong>시켜 컨텍스트 오염과 토큰 폭증을 막았다.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PIPELINE.map((p, i) => (
            <div key={p.mode} className="relative rounded-xl border border-[#1e2535] bg-[#0e1320] p-5">
              <div className="absolute right-4 top-4 text-xs font-mono text-slate-600">0{i + 1}</div>
              <div className="text-2xl">{p.emoji}</div>
              <div className="mt-3 font-semibold text-slate-100">{p.label}</div>
              <div className="mt-0.5 font-mono text-[11px] text-indigo-400/70">{p.mode}</div>
              <p className="mt-3 text-xs leading-relaxed text-slate-500">{p.out}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          <Card>
            <div className="text-sm font-semibold text-slate-200">프롬프트 = QA 방법론</div>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              5개 모드별 시스템 프롬프트에 "1TC=1검증", "추상표현 금지", "검증단계 49~60%" 등 QA 규칙을 코드처럼 명문화.
            </p>
          </Card>
          <Card>
            <div className="text-sm font-semibold text-slate-200">MCP 오케스트레이션</div>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              Jira·Confluence·Figma·GitHub·Slack 도구를 활용하되 원시 도구명을 한국어 라벨로 변환해 진행 상황 노출.
            </p>
          </Card>
          <Card>
            <div className="text-sm font-semibold text-slate-200">URL 원클릭 워크플로우</div>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              입력창에 Confluence/Jira URL을 붙여넣으면 배너로 자동 감지해 "TC 설계 / 생성 / 버그 분석" 액션으로 연결.
            </p>
          </Card>
        </div>
      </Section>

      {/* 강조 ② 엔지니어링 */}
      <Section id="engineering" kicker="Focus ② — Engineering" title="까다로운 영역의 직접 해결">
        <p className="mb-6 leading-relaxed text-slate-400">
          자체 SDK 호출 코드가 아니라 <strong className="text-slate-200">CLI subprocess 스트림 파싱</strong>이라는 까다로운 영역에서
          실제 버그를 진단하고 해결했다.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {ENGINEERING.map((e) => (
            <Card key={e.title}>
              <div className="text-sm font-semibold text-slate-100">{e.title}</div>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">{e.body}</p>
              <code className="mt-3 inline-block rounded bg-[#1e2535] px-2 py-0.5 font-mono text-[11px] text-violet-300">
                {e.commit}
              </code>
            </Card>
          ))}
        </div>
      </Section>

      {/* 품질 채점 엔진 */}
      <Section id="quality" kicker="Quality Engine" title="결정론적 TC 품질 채점">
        <p className="mb-6 leading-relaxed text-slate-400">
          AI 출력 품질을 다시 LLM에 묻지 않고, 마크다운 TC를 파싱해 가중치 룰 엔진으로 점수·등급·이슈를 산출한다.
        </p>
        <div className="overflow-hidden rounded-xl border border-[#1e2535]">
          <table className="w-full text-sm">
            <thead className="bg-[#1a2035] text-slate-400">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">EVAL 체크</th>
                <th className="px-4 py-2.5 text-left font-semibold">가중치</th>
                <th className="px-4 py-2.5 text-left font-semibold">탐지 방식</th>
              </tr>
            </thead>
            <tbody>
              {QUALITY_CHECKS.map((c) => (
                <tr key={c.eval} className="border-t border-[#111827] hover:bg-[#111827]">
                  <td className="px-4 py-2.5 font-medium text-slate-200">{c.eval}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex h-6 min-w-[2rem] items-center justify-center rounded bg-indigo-500/15 px-2 font-mono text-xs text-indigo-300">
                      {c.weight}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">{c.how}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 font-mono text-xs text-slate-500">
          score = round(earned / totalWeight × 100) · pass=만점, warn=절반, fail=0 → A~F 등급
        </p>
      </Section>

      {/* 기술 스택 */}
      <Section id="stack" kicker="Tech Stack" title="기술 스택">
        <div className="grid gap-3 sm:grid-cols-2">
          {STACK.map((s) => (
            <div key={s.area} className="rounded-xl border border-[#1e2535] bg-[#0e1320] p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-indigo-400">{s.area}</div>
              <div className="mt-1.5 text-sm text-slate-300">{s.items}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* 임팩트 */}
      <Section id="impact" kicker="Impact" title="임팩트">
        <ul className="space-y-3">
          {[
            '기획서 → 리뷰 완료 TC까지 한 번의 입력으로 자동화 (다단계 수작업 → 파이프라인 1회 실행)',
            'TC 품질을 사람이 아닌 시스템이 채점·강제 → 작성자별 편차 제거, 검증단계 분포 정량 관리',
            'Confluence·Jira·Figma·GitHub를 한 화면에서 다루는 QA 통합 워크벤치로 도구 전환 비용 절감',
            'QA 엔지니어가 도메인 이해와 풀스택 엔지니어링을 결합해 요구사항부터 운영까지 직접 수행',
          ].map((t) => (
            <li key={t} className="flex gap-3 text-sm leading-relaxed text-slate-300">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
              {t}
            </li>
          ))}
        </ul>
      </Section>

      <footer className="border-t border-[#1e2535] py-10 text-center text-xs text-slate-600">
        QA Dashboard — 면접용 포트폴리오 · Next.js 15 · React 19 · TypeScript
      </footer>
    </main>
  );
}
