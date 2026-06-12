'use client';

import { useState, useMemo } from 'react';
import type { Session } from '@/types/session';
import { extractTcRows, type TcRow } from '@/lib/tcExport';
import { analyzeTcQuality, type TcQualityResult, type CheckStatus } from '@/lib/tcQuality';
import { useSessionStore } from '@/stores/useSessionStore';

/**
 * TC 품질 리포트. session(또는 스토어의 활성 세션)의 어시스턴트 메시지에서
 * TC를 추출해 품질 점수·검증단계 분포·EVAL 체크·이슈를 표시한다.
 * 우측 패널 탭(기능 분석)과 TC 자동화 화면 우측 고정 패널 양쪽에서 재사용.
 */
export default function QualityReport({ session }: { session: Session | null }) {
  // 파이프라인 탭이 store에 직접 addMessage하므로, 실시간 반영 위해 store도 구독
  const storeSession = useSessionStore((state) => state.activeSession);

  const { result, tcRows } = useMemo(() => {
    const src = storeSession ?? session;
    if (!src) return { result: null as TcQualityResult | null, tcRows: [] as TcRow[] };
    const allRows = src.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => extractTcRows(m.content));
    return { result: analyzeTcQuality(allRows), tcRows: allRows };
  }, [storeSession, session]);

  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
        <div className="w-10 h-10 rounded-xl bg-[#1E2535] flex items-center justify-center text-xl">📋</div>
        <p className="text-[12px] text-slate-500">TC 데이터 없음</p>
        <p className="text-[11px] text-slate-600">TC를 생성하면 자동으로 품질 분석이 실행됩니다</p>
      </div>
    );
  }

  const gradeColor: Record<string, string> = {
    A: '#34D399', B: '#60A5FA', C: '#FBBF24', D: '#F87171', F: '#EF4444',
  };
  const color = gradeColor[result.grade] ?? '#94A3B8';

  return (
    <div className="space-y-3">
      <div className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">품질 점수</span>
          <span className="text-[10px] text-slate-500">{result.tcCount}개 TC 분석</span>
        </div>
        <div className="flex items-end gap-3 mb-2.5">
          <span className="text-[36px] font-bold leading-none" style={{ color }}>
            {result.score}
          </span>
          <div className="mb-1">
            <span className="text-[11px] text-slate-500">/ 100</span>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-[13px] font-bold px-1.5 py-0.5 rounded" style={{ color, backgroundColor: `${color}18` }}>
                {result.grade}등급
              </span>
            </div>
          </div>
        </div>
        <div className="h-1.5 bg-[#1E2535] rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${result.score}%`, backgroundColor: color }} />
        </div>
      </div>

      <div className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2.5">검증단계 분포</p>
        <PhaseBar label="정상" count={result.phaseDistribution.정상} total={result.phaseDistribution.total} color="#34D399" />
        <PhaseBar label="부정" count={result.phaseDistribution.부정} total={result.phaseDistribution.total} color="#F87171" />
        <PhaseBar label="예외" count={result.phaseDistribution.예외} total={result.phaseDistribution.total} color="#FBBF24" />
        {result.phaseDistribution.기타 > 0 && (
          <PhaseBar label="기타" count={result.phaseDistribution.기타} total={result.phaseDistribution.total} color="#6B7280" />
        )}
        <div className="mt-2 pt-2 border-t border-[#1E2535] flex items-center justify-between">
          <span className="text-[11px] text-slate-500">부정+예외</span>
          <span
            className="text-[11px] font-semibold"
            style={{ color: result.phaseDistribution.negativeRatio >= 49 && result.phaseDistribution.negativeRatio <= 65 ? '#34D399' : '#FBBF24' }}
          >
            {result.phaseDistribution.negativeRatio}%
            <span className="text-slate-600 font-normal ml-1">(목표 49~65%)</span>
          </span>
        </div>
      </div>

      <div className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">EVAL 체크</p>
        <div className="space-y-1.5">
          {result.checks.map((check) => (
            <div key={check.id} className="flex items-start gap-2">
              <StatusIcon status={check.status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] text-slate-400 truncate">{check.label}</span>
                  <StatusBadge status={check.status} />
                </div>
                <p className="text-[10px] text-slate-600 mt-0.5 leading-snug">{check.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {result.issues.length > 0 ? (
        <div className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">
            발견 이슈 ({result.issues.length})
          </p>
          <div className="space-y-2">
            {result.issues.map((issue, i) => (
              <div key={i} className="border-l-2 pl-2" style={{ borderColor: severityColor(issue.severity) }}>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[9px] font-bold px-1 py-0.5 rounded" style={{ color: severityColor(issue.severity), backgroundColor: `${severityColor(issue.severity)}18` }}>
                    {issue.severity}
                  </span>
                  <span className="text-[11px] text-slate-300 font-medium">{issue.label}</span>
                </div>
                <p className="text-[10px] text-slate-500 leading-snug">{issue.detail}</p>
                {issue.tcIds && issue.tcIds.length > 0 && (
                  <p className="text-[10px] text-slate-600 mt-0.5 truncate">
                    {issue.tcIds.slice(0, 5).join(', ')}{issue.tcIds.length > 5 ? ` 외 ${issue.tcIds.length - 5}건` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-900/20 border border-emerald-800/40">
          <span className="text-base">✓</span>
          <span className="text-[12px] text-emerald-400 font-medium">이슈 없음 — 품질 기준 통과</span>
        </div>
      )}

      <SheetsExportSection rows={tcRows} />
    </div>
  );
}

// ─── Sheets 내보내기 섹션 ──────────────────────────────────────────────────────

function SheetsExportSection({ rows }: { rows: TcRow[] }) {
  const [sheetsUrl, setSheetsUrl] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [resultSheetName, setResultSheetName] = useState('');
  const [spreadsheetId, setSpreadsheetId] = useState('');

  const handleExport = async () => {
    if (!sheetsUrl.trim() || !rows.length) return;
    setStatus('loading');
    setMessage('');
    try {
      const res = await fetch('/api/sheets/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetsUrl: sheetsUrl.trim(), rows }),
      });
      const data = await res.json() as { error?: string; sheetName?: string; rowCount?: number; spreadsheetId?: string };
      if (!res.ok) {
        setStatus('error');
        setMessage(data.error ?? '오류가 발생했습니다.');
      } else {
        setStatus('success');
        setResultSheetName(data.sheetName ?? '');
        setSpreadsheetId(data.spreadsheetId ?? '');
        setMessage(`${data.rowCount}개 TC 업로드 완료`);
      }
    } catch {
      setStatus('error');
      setMessage('네트워크 오류가 발생했습니다.');
    }
  };

  const sheetsLink = spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}` : '';

  return (
    <div className="bg-[#0F1520] border border-[#1E2535] rounded-lg p-3">
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Sheets 내보내기</p>
      <input
        type="text"
        value={sheetsUrl}
        onChange={(e) => setSheetsUrl(e.target.value)}
        placeholder="Sheets URL 또는 ID 붙여넣기..."
        disabled={status === 'loading'}
        className="w-full bg-[#161B27] border border-[#2A3347] rounded-md px-2.5 py-1.5 text-[11px] text-slate-300 placeholder:text-slate-600 outline-none focus:border-indigo-600 disabled:opacity-50 mb-2"
      />
      <button
        onClick={handleExport}
        disabled={!sheetsUrl.trim() || !rows.length || status === 'loading'}
        className="w-full py-1.5 rounded-md bg-emerald-700 text-[11px] font-semibold text-white hover:bg-emerald-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        {status === 'loading' ? '업로드 중...' : '↑ Sheets에 내보내기'}
      </button>
      {status === 'success' && (
        <div className="mt-2 space-y-0.5">
          <p className="text-[10px] text-emerald-400">✓ {message} — {resultSheetName}</p>
          {sheetsLink && (
            <a href={sheetsLink} target="_blank" rel="noopener noreferrer" className="text-[10px] text-indigo-400 hover:underline block">
              Sheets에서 열기 →
            </a>
          )}
        </div>
      )}
      {status === 'error' && (
        <p className="text-[10px] text-red-400 mt-2 leading-snug">{message}</p>
      )}
    </div>
  );
}

function PhaseBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <span className="text-[11px] text-slate-500 w-8 flex-shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-[#1E2535] rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-[10px] text-slate-500 w-8 text-right flex-shrink-0">{pct}%</span>
    </div>
  );
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === 'pass') return <span className="text-emerald-400 text-[12px] flex-shrink-0 mt-0.5">✓</span>;
  if (status === 'warn') return <span className="text-amber-400 text-[12px] flex-shrink-0 mt-0.5">!</span>;
  return <span className="text-red-400 text-[12px] flex-shrink-0 mt-0.5">✗</span>;
}

function StatusBadge({ status }: { status: CheckStatus }) {
  const map = { pass: 'text-emerald-400 bg-emerald-900/30', warn: 'text-amber-400 bg-amber-900/30', fail: 'text-red-400 bg-red-900/30' } as const;
  const label = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;
  return <span className={`text-[9px] font-bold px-1 py-0.5 rounded flex-shrink-0 ${map[status]}`}>{label[status]}</span>;
}

function severityColor(s: string): string {
  if (s === 'CRITICAL') return '#EF4444';
  if (s === 'HIGH') return '#F87171';
  if (s === 'MEDIUM') return '#FBBF24';
  return '#94A3B8';
}
