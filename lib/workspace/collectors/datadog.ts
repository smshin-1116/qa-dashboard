import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { upsertSignal } from '../repo';
import { safely, type CollectorResult } from './shared';

/**
 * Datadog RUM 수집기.
 *
 * ── 왜 로컬 파일인가 ──────────────────────────────────────────────────
 * datadog-qa가 이미 매일 돌면서 상태 파일을 갱신하고 있다.
 * 대시보드가 Datadog API를 다시 부르면 같은 일을 두 번 하는 것이고,
 * 노이즈 제외 규칙(noise-ignore.json)도 다시 구현해야 한다.
 * → **이미 판정이 끝난 결과를 읽기만 한다.**
 *
 * ── 읽는 파일 ─────────────────────────────────────────────────────────
 *   watch-state.json  : 알림이 나간 시점 기록. 키가 곧 클러스터 식별자
 *                       "novel|<appId>|<정규화 메시지>"  (신규 클러스터)
 *                       "4xxrepeat|<METHOD>|<path>"      (4xx 반복)
 *   triage-state.json : 클러스터별 트리아지 상태 · 기준선(baseline_7d)
 *
 * ⚠️ watch-state의 키 형식이 우리 fingerprint 개념과 같다 —
 *    "정규화된 메시지로 같은 것을 묶는다"는 방식을 여기서 가져왔다.
 */

const DD_DIR =
  process.env.DATADOG_QA_DIR ?? path.join(os.homedir(), 'Projects', 'datadog-qa');

interface TriageCluster {
  app?: string;
  message?: string;
  first_seen?: string;
  last_reviewed?: string;
  status?: string;
  jira?: string;
  baseline_7d?: number;
  note?: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** watch-state 키 파싱 — 종류·앱·메시지로 분해 */
function parseWatchKey(key: string): { kind: string; app: string; message: string } {
  const parts = key.split('|');
  if (parts[0] === 'novel') {
    return { kind: 'novel', app: parts[1] ?? '', message: parts.slice(2).join('|') };
  }
  if (parts[0] === '4xxrepeat') {
    return { kind: '4xxrepeat', app: '', message: parts.slice(1).join(' ') };
  }
  return { kind: parts[0] ?? 'unknown', app: '', message: parts.slice(1).join('|') };
}

/** 최근 N시간 이내에 알림이 나간 것만 "오늘 볼 것"으로 본다 */
const RECENT_HOURS = 36;

export async function collectDatadog(): Promise<CollectorResult> {
  return safely('datadog', async () => {
    const watchPath = path.join(DD_DIR, 'watch-state.json');
    const triagePath = path.join(DD_DIR, 'triage-state.json');

    const watch = readJson<{ alerted?: Record<string, string>; _last_run?: string }>(watchPath);
    const triage = readJson<{ clusters?: Record<string, TriageCluster> }>(triagePath);

    if (!watch) {
      throw new Error(`watch-state.json 을 읽을 수 없습니다: ${watchPath}`);
    }

    const alerted = watch.alerted ?? {};
    const cutoff = Date.now() - RECENT_HOURS * 3_600_000;

    let novel = 0;
    let repeat = 0;

    for (const [key, isoAt] of Object.entries(alerted)) {
      const at = Date.parse(isoAt);
      if (Number.isNaN(at) || at < cutoff) continue; // 오래된 알림은 오늘의 신호가 아니다

      const { kind, app, message } = parseWatchKey(key);
      if (kind === 'novel') novel++;
      else if (kind === '4xxrepeat') repeat++;

      upsertSignal({
        source: 'datadog',
        kind: kind === 'novel' ? 'error-cluster' : 'error-4xx',
        ref: key,
        // watch-state 키 자체가 정규화된 형태라 그대로 fingerprint로 쓴다
        fingerprint: key,
        title:
          kind === 'novel'
            ? `신규 에러 클러스터 — ${message.slice(0, 70)}`
            : `4xx 반복 — ${message}`,
        detail: app ? `app ${app}` : null,
        severity: kind === 'novel' ? 'warn' : 'info',
        observedAt: new Date(at).toISOString(),
      });
    }

    /**
     * 트리아지 상태 요약 — 아직 티켓화되지 않은 클러스터가 몇 개인가.
     * 티켓은 자동 생성하지 않는다(dd-triage 원칙). 후보만 센다.
     */
    const clusters = Object.values(triage?.clusters ?? {});
    const untriaged = clusters.filter(
      (c) => c.status && !['known-noise', 'ticketed', 'fixed'].includes(c.status),
    ).length;

    upsertSignal({
      source: 'datadog',
      kind: 'summary',
      ref: 'rum-summary',
      title: `RUM — 신규 ${novel} · 4xx 반복 ${repeat}`,
      detail: `트리아지 미완료 클러스터 ${untriaged}건 · 마지막 감시 ${watch._last_run ?? '?'}`,
      severity: novel > 0 ? 'warn' : 'ok',
      observedAt: watch._last_run ?? new Date().toISOString(),
      payload: { novel, repeat, untriaged, clusters: clusters.length },
    });

    return {
      detail: `신규 ${novel} · 4xx 반복 ${repeat} · 미트리아지 ${untriaged}`,
      count: novel + repeat,
    };
  });
}
