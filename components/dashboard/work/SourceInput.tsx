'use client';

import { useMemo, useState } from 'react';

/**
 * QA 작업 — 시안 "입력 — 소스 여러 개" 카드 (workspace-prototype.html 1455~1499행).
 *
 * ── 위치가 곧 설계다 ──────────────────────────────────────────────────
 * 시안의 QA 작업 화면에는 **하단 채팅 입력이 없다.** 입력은 화면 상단의 이 카드
 * 하나로 들어오고, 아래로 진행 → 대화(분석) → TC → 작업 종료가 세로로 이어진다.
 * (2026-08-10 사용자 지적으로 하단 ChatInput을 제거하고 이 카드로 통합)
 *
 * ── 한 입력창으로 통합 (2026-08-13) ──────────────────────────────────
 * 예전엔 URLS 칸 + [텍스트 추가]로 여는 TEXT 칸이 따로 있었다. 사용자는
 * "입력이 두 군데라 헷갈린다"고 지적 → **한 칸**으로 합쳤다. 규칙은 단순하다:
 *   · `http(s)://`로 시작하는 줄  → 소스 URL (티켓·기획서·PR)
 *   · 그 밖의 모든 줄            → 자유 텍스트 (지시·질문·본문 붙여넣기)
 * 줄 단위로 자동 구분하고, 무엇이 감지됐는지 아래 칩으로 즉시 보여준다.
 * 텍스트 직입 경로가 구 `/create-tc` 커맨드를 대체한다 (2026-08-06 확정).
 *
 * ── 라우팅 규칙 ───────────────────────────────────────────────────────
 * Confluence 기획서 1건 · 텍스트 없음 → 4단계 파이프라인 자동 실행 (기존 흐름)
 * 그 외 (티켓 · 다중 URL · 텍스트)     → ⓪흡수·①교차분석 (Codex 세션 1개)
 *                                        → ② 확인 게이트 → ③~(Claude)
 * Codex가 실패하면 서버가 폴백을 알리고 채팅(Claude 단독)으로 이어진다.
 */

const URL_RE = /^https?:\/\//i;
const JIRA_RE = /\/browse\/[A-Z][A-Z0-9]+-\d+/;
const WIKI_RE = /\/wiki\//;
/** GitHub PR — 직접 붙여넣으면 ⓪-b에서 gh로 구현을 검토한다 */
const PR_RE = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

export default function SourceInput({
  onAbsorb,
  onRunPipeline,
  onAnalyze,
  busy,
  busyLabel,
}: {
  /** 다중 소스 — ⓪흡수·①교차분석(Codex)으로 보낸다 */
  onAbsorb: (urls: string[], text: string) => void;
  /** Confluence 기획서 1건 — 기존 4단계 파이프라인 */
  onRunPipeline: (url: string) => void;
  /** 기능 분석 모드 — codex·게이트·TC 설계 없이 Claude가 바로 분석만 (2026-08-19) */
  onAnalyze: (urls: string[], text: string) => void;
  /** 채팅 스트리밍·파이프라인·흡수 중 */
  busy: boolean;
  /** 버튼에 표시할 진행 문구 (예: "⓪① Codex 분석 중…") */
  busyLabel?: string;
}) {
  const [raw, setRaw] = useState('');
  /** 입력 모드 — 'design'(기존: TC 설계) · 'analyze'(신규: 기능 분석만). 기본 design → 기존과 동일 */
  const [mode, setMode] = useState<'design' | 'analyze'>('design');

  /** 줄 단위 분해 + URL/텍스트 자동 구분 — 감지 칩과 전송 페이로드에 함께 쓴다 */
  const parsed = useMemo(() => {
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const urlLines = lines.filter((l) => URL_RE.test(l));
    const textLines = lines.filter((l) => !URL_RE.test(l));
    return {
      urls: urlLines,
      freeText: textLines.join('\n'),
      textLineCount: textLines.length,
      tickets: urlLines.filter((l) => JIRA_RE.test(l)).length,
      docs: urlLines.filter((l) => WIKI_RE.test(l)).length,
      prs: urlLines.filter((l) => PR_RE.test(l)).length,
    };
  }, [raw]);

  const others = parsed.urls.length - parsed.tickets - parsed.docs - parsed.prs;
  const canSubmit = !busy && (parsed.urls.length > 0 || parsed.freeText.length > 0);

  /** 감지 칩 — 무엇이 잡혔는지 한눈에. 색으로 종류 구분(시맨틱 토큰) */
  const chips: Array<{ label: string; tone: string }> = [
    parsed.tickets > 0 && { label: `티켓 ${parsed.tickets}`, tone: 'var(--crit)' },
    parsed.docs > 0 && { label: `기획서 ${parsed.docs}`, tone: 'var(--info)' },
    parsed.prs > 0 && { label: `PR ${parsed.prs}`, tone: 'var(--accent)' },
    others > 0 && { label: `기타 URL ${others}`, tone: 'var(--tx-3)' },
    parsed.textLineCount > 0 && { label: `텍스트 ${parsed.textLineCount}줄`, tone: 'var(--warn)' },
  ].filter(Boolean) as Array<{ label: string; tone: string }>;

  function submit() {
    if (!canSubmit) return;

    if (mode === 'analyze') {
      // 기능 분석 — codex·게이트·TC 설계 없이 Claude가 바로 분석만. 기존 경로와 완전히 분리.
      onAnalyze(parsed.urls, parsed.freeText);
    } else if (parsed.urls.length === 1 && WIKI_RE.test(parsed.urls[0]) && !parsed.freeText) {
      // (기존) 기획서 1건 단독 → 4단계 파이프라인
      onRunPipeline(parsed.urls[0]);
    } else {
      // (기존) 그 외 → ⓪①(Codex) 흡수·교차분석 → ② 게이트
      onAbsorb(parsed.urls, parsed.freeText);
    }
    // #2: 제출 후 입력을 비우지 않는다 — 어떤 티켓·작업을 진행 중인지 계속 보이게 유지한다.
    // (다음 작업을 시작할 땐 입력 내용을 지우고 새 소스를 넣으면 된다)
  }

  return (
    <div className="rounded-[13px] border border-[var(--line)] bg-[var(--panel)] p-3.5">
      <div className="flex items-start justify-between gap-2.5 mb-2.5">
        <div>
          <div className="text-[13px] font-[640] tracking-[-0.01em] text-[var(--tx-1)]">
            입력 — 소스 여러 개
          </div>
          <div className="text-[11px] text-[var(--tx-3)] mt-0.5">
            URL은 <b className="text-[var(--tx-3)]">줄 단위로</b> 붙여넣고, 지시·질문·본문은 그냥
            쓰세요 — <b className="text-[var(--tx-3)]">자동으로 구분</b>합니다
          </div>
        </div>
        {parsed.urls.length > 0 && (
          <span
            className="inline-flex items-center px-[7px] py-[2px] rounded-full border font-mono
                       text-[9.5px] font-bold whitespace-nowrap
                       text-[var(--info)] border-[color-mix(in_srgb,var(--info)_40%,transparent)] bg-[color-mix(in_srgb,var(--info)_12%,transparent)]"
          >
            {parsed.urls.length}개 소스
          </span>
        )}
      </div>

      {/* 모드 토글 — TC 설계(기존) vs 기능 분석(Claude 직행). 기본 design이라 기존과 동일 동작 */}
      <div className="inline-flex p-[3px] gap-[3px] rounded-[9px] border border-[var(--line-2)] bg-[var(--inset)] mb-2">
        {(['design', 'analyze'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            disabled={busy}
            className={
              'px-3 py-1.5 rounded-[6px] text-[11.5px] font-[640] transition-colors disabled:opacity-50 ' +
              (mode === m
                ? 'bg-[var(--panel)] text-[var(--tx-1)] shadow-sm'
                : 'text-[var(--tx-3)] hover:text-[var(--tx-2)]')
            }
          >
            {m === 'design' ? '🧪 TC 분석·설계' : '🔍 기능 분석'}
          </button>
        ))}
      </div>
      {mode === 'analyze' && (
        <div
          className="flex gap-2 items-start text-[11px] px-2.5 py-2 mb-2.5 rounded-[8px]
                     border border-[color-mix(in_srgb,var(--ok)_28%,transparent)]
                     bg-[color-mix(in_srgb,var(--ok)_9%,transparent)] text-[var(--tx-2)]"
        >
          <span className="text-[var(--ok)] font-bold shrink-0">🔍</span>
          <span>
            <b>기능 분석 모드</b> — Claude가 <b>바로 분석만</b> 합니다. codex 교차분석·확인 게이트·TC
            설계 <b>없음</b>. TC가 필요하면 <b>TC 분석·설계</b>로 바꾸세요.
          </span>
        </div>
      )}

      {/*
        한 칸 통합 입력. focus-within으로 테두리를 강조해 "여기가 입력"임을 분명히 한다.
        모노가 아니라 일반 폰트 — URL도 텍스트도 같은 칸에 섞이므로 텍스트 가독성을 택했다.
      */}
      <div
        className="rounded-[10px] border border-[var(--line-2)] bg-[var(--inset)] px-3 py-2.5
                   transition-colors focus-within:border-[var(--accent)]
                   focus-within:bg-[color-mix(in_srgb,var(--accent)_5%,var(--inset))]"
      >
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => {
            // Enter는 줄바꿈(여러 URL·여러 줄이 본체다) — 전송은 Cmd/Ctrl+Enter
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={Math.min(10, Math.max(4, parsed.urls.length + parsed.textLineCount + 2))}
          disabled={busy}
          placeholder={
            'https://wemeet2025.atlassian.net/browse/RV-1284\n' +
            'https://wemeet2025.atlassian.net/wiki/…/배차취소-기획-v3\n' +
            '\n' +
            '취소 사유 노출 케이스도 TC에 포함해줘 (자유 텍스트는 이렇게)'
          }
          className="w-full min-w-0 bg-transparent border-none outline-none resize-none
                     text-[12.5px] leading-[1.8] text-[var(--tx-1)]
                     placeholder:text-[var(--tx-4)] disabled:opacity-50"
        />
      </div>

      {/* 감지 결과 칩 + 전송 */}
      <div className="flex gap-1.5 mt-2.5 justify-between items-center">
        <div className="flex flex-wrap items-center gap-1.5 min-h-[20px]">
          {chips.length > 0 ? (
            chips.map((c) => (
              <span
                key={c.label}
                className="inline-flex items-center px-[7px] py-[2px] rounded-full border
                           font-mono text-[9.5px] font-bold whitespace-nowrap"
                style={{
                  color: c.tone,
                  borderColor: `color-mix(in srgb, ${c.tone} 38%, transparent)`,
                  backgroundColor: `color-mix(in srgb, ${c.tone} 11%, transparent)`,
                }}
              >
                {c.label}
              </span>
            ))
          ) : (
            <span className="font-mono text-[10px] text-[var(--tx-4)]">
              텍스트 직입은 <span className="text-[var(--tx-3)]">/create-tc</span> 커맨드를 대체 ·{' '}
              <span className="text-[var(--tx-3)]">⌘↵</span> 전송
            </span>
          )}
        </div>
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="shrink-0 px-2.5 py-1 rounded-[6px] border border-[var(--accent-deep)] bg-[var(--accent-deep)] text-white
                     text-[10.5px] font-semibold hover:bg-[var(--accent)]
                     disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy
            ? (busyLabel ?? '진행 중…')
            : mode === 'analyze'
              ? '🔍 기능 분석'
              : '▶ 일괄 읽기 → TC 설계'}
        </button>
      </div>
    </div>
  );
}
