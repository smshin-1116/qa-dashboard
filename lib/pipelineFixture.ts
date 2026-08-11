import { promises as fs } from 'fs';
import path from 'path';
import type { PipelineEvent, PipelineFixture, RecordedPipelineEvent } from '@/types/pipeline';

/**
 * 파이프라인 실행 결과를 fixture로 기록하고 재생합니다.
 *
 * 왜: `claude` CLI 호출 1회당 하네스 고정 오버헤드가 실측 약 30k 토큰이고,
 * 파이프라인은 4단계이므로 실작업 전에 이미 120k를 씁니다. 화면·스트리밍·
 * 엑셀 내보내기를 확인하려고 반복 실행하는 것만으로 구독 한도가 깎이므로,
 * 개발 중에는 실제 호출 없이 기록된 이벤트를 재생합니다.
 *
 * 환경변수:
 *   PIPELINE_RECORD=1  실제 실행 결과를 fixture로 저장
 *   PIPELINE_MOCK=1    실제 호출 없이 fixture 재생
 *   PIPELINE_MOCK_SPEED=12  재생 속도 배수 (기본 12배속)
 */

const FIXTURE_DIR = path.join(process.cwd(), 'fixtures', 'pipeline');

/** 이벤트 간 최대 대기 (긴 도구 호출 공백을 그대로 재현하지 않음) */
const MAX_GAP_MS = 400;
/** 이보다 짧은 간격은 대기를 생략하고 연속 전송 (chunk가 수천 개일 수 있음) */
const MIN_SLEEP_MS = 8;

export function isMockEnabled(): boolean {
  return process.env.PIPELINE_MOCK === '1';
}

export function isRecordEnabled(): boolean {
  return process.env.PIPELINE_RECORD === '1';
}

function replaySpeed(): number {
  const raw = Number(process.env.PIPELINE_MOCK_SPEED);
  return Number.isFinite(raw) && raw > 0 ? raw : 12;
}

/**
 * Confluence URL → fixture 파일명.
 * 페이지 ID가 있으면 그것을 쓰고, 없으면 URL 전체를 슬러그화합니다.
 */
export function fixtureNameFor(confluenceUrl: string): string {
  const pageId = confluenceUrl.match(/\/pages\/(\d+)/)?.[1];
  if (pageId) return `page-${pageId}`;
  const slug = confluenceUrl
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return slug || 'unnamed';
}

// ─── 기록 ─────────────────────────────────────────────────────────────────────

/**
 * 이벤트를 시간축과 함께 모으는 레코더.
 * `wrap()`으로 감싼 send를 사용하면 전송과 동시에 기록됩니다.
 */
export function createRecorder(confluenceUrl: string) {
  const started = Date.now();
  const events: RecordedPipelineEvent[] = [];

  return {
    wrap(send: (event: PipelineEvent) => void) {
      return (event: PipelineEvent) => {
        events.push({ t: Date.now() - started, event });
        send(event);
      };
    },

    /** 저장된 파일 경로 반환. 실패해도 파이프라인을 깨지 않고 null 반환. */
    async save(): Promise<string | null> {
      if (events.length === 0) return null;
      const fixture: PipelineFixture = {
        version: 1,
        recordedAt: new Date(started).toISOString(),
        confluenceUrl,
        durationMs: Date.now() - started,
        events,
      };
      const filePath = path.join(FIXTURE_DIR, `${fixtureNameFor(confluenceUrl)}.json`);
      try {
        await fs.mkdir(FIXTURE_DIR, { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(fixture, null, 2), 'utf8');
        return filePath;
      } catch (err) {
        console.error('[pipelineFixture] fixture 저장 실패:', err);
        return null;
      }
    },
  };
}

// ─── 재생 ─────────────────────────────────────────────────────────────────────

/**
 * URL에 정확히 대응하는 fixture를 찾고, 없으면 가장 최근에 기록된 것을 씁니다.
 * (아직 한 번도 돌려보지 않은 URL로도 화면 확인이 가능해야 하므로)
 */
export async function loadFixture(confluenceUrl: string): Promise<PipelineFixture | null> {
  let names: string[];
  try {
    names = (await fs.readdir(FIXTURE_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return null; // 디렉터리 자체가 없음 = 아직 기록된 실행 없음
  }
  if (names.length === 0) return null;

  const exact = `${fixtureNameFor(confluenceUrl)}.json`;
  const candidates = names.includes(exact) ? [exact] : names;

  const loaded: PipelineFixture[] = [];
  for (const name of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, name), 'utf8'));
      if (parsed?.version === 1 && Array.isArray(parsed.events)) loaded.push(parsed);
    } catch (err) {
      console.error(`[pipelineFixture] ${name} 읽기 실패:`, err);
    }
  }
  if (loaded.length === 0) return null;

  // 최신 기록 우선
  loaded.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
  return loaded[0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fixture를 원래 타이밍 비율대로 재생합니다.
 * `start` 이벤트에는 mock 표시를 덧붙여 UI가 재생 중임을 알 수 있게 합니다.
 */
export async function replayFixture(
  fixture: PipelineFixture,
  send: (event: PipelineEvent) => void,
  isAborted: () => boolean = () => false
): Promise<void> {
  const speed = replaySpeed();
  let prevT = 0;
  let pending = 0; // 생략된 짧은 간격 누적 — 전체 리듬이 무너지지 않게 합산해서 소비

  for (const { t, event } of fixture.events) {
    if (isAborted()) return;

    pending += Math.max(0, t - prevT) / speed;
    prevT = t;
    if (pending >= MIN_SLEEP_MS) {
      await sleep(Math.min(pending, MAX_GAP_MS));
      pending = 0;
    }

    send(
      event.type === 'start'
        ? { ...event, mock: true, recordedAt: fixture.recordedAt }
        : event
    );
  }
}
