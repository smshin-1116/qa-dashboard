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
 * ── 무엇을 받나 ───────────────────────────────────────────────────────
 * 티켓·기획서 URL을 줄 단위로 전부 + [텍스트 추가]로 지시·질문 직입.
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
  busy,
  busyLabel,
}: {
  /** 다중 소스 — ⓪흡수·①교차분석(Codex)으로 보낸다 */
  onAbsorb: (urls: string[], text: string) => void;
  /** Confluence 기획서 1건 — 기존 4단계 파이프라인 */
  onRunPipeline: (url: string) => void;
  /** 채팅 스트리밍·파이프라인·흡수 중 */
  busy: boolean;
  /** 버튼에 표시할 진행 문구 (예: "⓪① Codex 분석 중…") */
  busyLabel?: string;
}) {
  const [urls, setUrls] = useState('');
  const [showText, setShowText] = useState(false);
  const [text, setText] = useState('');

  /** 줄 단위 분해 + 분류 — 버튼 옆 집계(`티켓 3 · 기획서 2 · …`)에 쓴다 */
  const parsed = useMemo(() => {
    const lines = urls
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const urlLines = lines.filter((l) => URL_RE.test(l));
    return {
      urls: urlLines,
      /** URL 칸에 섞인 비-URL 줄 — 버리지 않고 텍스트로 취급한다 */
      strayText: lines.filter((l) => !URL_RE.test(l)),
      tickets: urlLines.filter((l) => JIRA_RE.test(l)).length,
      docs: urlLines.filter((l) => WIKI_RE.test(l)).length,
      prs: urlLines.filter((l) => PR_RE.test(l)).length,
    };
  }, [urls]);

  const others = parsed.urls.length - parsed.tickets - parsed.docs - parsed.prs;
  const freeText = [parsed.strayText.join('\n'), showText ? text.trim() : '']
    .filter(Boolean)
    .join('\n');
  const canSubmit = !busy && (parsed.urls.length > 0 || freeText.length > 0);

  function submit() {
    if (!canSubmit) return;

    // 기획서 1건 단독이면 기존 파이프라인, 그 외는 ⓪①(Codex) → ② 게이트
    if (parsed.urls.length === 1 && WIKI_RE.test(parsed.urls[0]) && !freeText) {
      onRunPipeline(parsed.urls[0]);
    } else {
      onAbsorb(parsed.urls, freeText);
    }
    setUrls('');
    setText('');
    setShowText(false);
  }

  return (
    <div className="rounded-[13px] border border-[#1E2535] bg-[#161B27] p-3.5">
      <div className="flex items-start justify-between gap-2.5 mb-2.5">
        <div>
          <div className="text-[13px] font-[640] tracking-[-0.01em] text-slate-100">
            입력 — 소스 여러 개
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            티켓·기획서 URL을 <b className="text-slate-400">줄 단위로 전부</b> 붙여넣는다 · 텍스트
            직입도 가능
          </div>
        </div>
        {parsed.urls.length > 0 && (
          <span
            className="inline-flex items-center px-[7px] py-[2px] rounded-full border font-mono
                       text-[9.5px] font-bold whitespace-nowrap
                       text-[#60A5FA] border-[#60A5FA66] bg-[#60A5FA1c]"
          >
            {parsed.urls.length}개 소스
          </span>
        )}
      </div>

      {/* URLS 필드 — 시안의 .field 그대로 (좌측 라벨 + 모노 본문) */}
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-[9px] border border-[#2A3347] bg-[#0F1520]">
        <span className="font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase text-[#818CF8] pt-1">
          URLS
        </span>
        <textarea
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          onKeyDown={(e) => {
            // Enter는 줄바꿈(여러 URL이 본체다) — 전송은 Cmd/Ctrl+Enter
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={Math.min(8, Math.max(3, parsed.urls.length + parsed.strayText.length + 1))}
          disabled={busy}
          placeholder={
            'https://wemeet2025.atlassian.net/browse/RV-1284\nhttps://wemeet2025.atlassian.net/wiki/…/배차취소-기획-v3'
          }
          className="flex-1 min-w-0 bg-transparent border-none outline-none resize-none
                     font-mono text-[11.5px] leading-[1.85] text-slate-300
                     placeholder:text-slate-600 disabled:opacity-50"
        />
      </div>

      {/* 텍스트 직입 — /create-tc 커맨드 대체 경로 */}
      {showText && (
        <div className="flex items-start gap-2 px-3 py-2.5 mt-2 rounded-[9px] border border-[#2A3347] bg-[#0F1520]">
          <span className="font-mono text-[9.5px] font-semibold tracking-[0.1em] uppercase text-slate-500 pt-1">
            TEXT
          </span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            disabled={busy}
            autoFocus
            placeholder="티켓 본문 붙여넣기 · 분석 지시 · 후속 질문 — 자유 텍스트"
            className="flex-1 min-w-0 bg-transparent border-none outline-none resize-y
                       text-[12px] leading-[1.7] text-slate-300 placeholder:text-slate-600 disabled:opacity-50"
          />
        </div>
      )}

      <div className="flex gap-1.5 mt-2.5 justify-between items-center">
        <div className="font-mono text-[10px] text-slate-600">
          {parsed.urls.length > 0 || freeText ? (
            <>
              {[
                parsed.tickets > 0 && `티켓 ${parsed.tickets}`,
                parsed.docs > 0 && `기획서 ${parsed.docs}`,
                parsed.prs > 0 && `PR ${parsed.prs}`,
                others > 0 && `기타 ${others}`,
                freeText && '텍스트',
              ]
                .filter(Boolean)
                .join(' · ')}
            </>
          ) : (
            <>
              텍스트 직입은 <span className="text-slate-500">/create-tc</span> 커맨드를 대체
            </>
          )}
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => setShowText((v) => !v)}
            disabled={busy}
            className="px-2.5 py-1 rounded-[6px] border border-[#2A3347] bg-[#0F1520] text-slate-300
                       text-[10.5px] font-semibold hover:text-white disabled:opacity-40"
          >
            {showText ? '텍스트 닫기' : '텍스트 추가'}
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="px-2.5 py-1 rounded-[6px] border border-[#4F46E5] bg-[#4F46E5] text-white
                       text-[10.5px] font-semibold hover:bg-[#6366F1]
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? (busyLabel ?? '진행 중…') : '▶ 일괄 읽기'}
          </button>
        </div>
      </div>
    </div>
  );
}
