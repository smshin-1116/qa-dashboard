import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeFingerprint } from '../fingerprint';
import { markResolvedExcept, upsertFinding, upsertSignal, upsertTestRun } from '../repo';
import type { FindingKind } from '../types';
import { safely, stripAnsi, type CollectorResult } from './shared';

/**
 * 웹 E2E 수집기 (roouty-test-automation).
 *
 * ── 왜 JUnit XML 인가 ─────────────────────────────────────────────────
 * Jenkins가 로컬에서 돌지만 잡 히스토리가 비어 있고, 실제로는 로컬 pytest
 * 실행 결과가 `reports/junit.xml`에 남는다. Allure는 사람이 보는 용도라
 * 기계 판독에는 JUnit XML이 맞다.
 *
 * ── 분류 신호 (`/daily-qa` 런북과 동일) ───────────────────────────────
 *   TimeoutError / locator not found  → 셀렉터 드리프트
 *   4xx·5xx · KeyError                → 계약 드리프트
 *   xfail → XPASS                     → 버그 수정됨
 *   automation-backlog 등재            → 알려진 flaky (조치 대상 아님)
 */

const WEB_DIR =
  process.env.WEB_E2E_DIR ?? path.join(os.homedir(), 'Projects', 'roouty-test-automation');

/** 알려진 flaky — 조치 대상이 아니므로 버그로 올리지 않는다 */
const KNOWN_FLAKY = new Set(['SET-014', 'SET-015']);

interface Case {
  nodeId: string;
  name: string;
  classname: string;
  status: 'passed' | 'failure' | 'error' | 'skipped' | 'xpass';
  type: string | null;
  message: string | null;
}

/**
 * 아주 작은 XML 파서.
 * junit.xml은 구조가 단순(testsuite > testcase > failure|skipped)해서
 * 정규식으로 충분하다 — 의존성을 추가하지 않기 위한 선택.
 */
function parseJUnit(xml: string): { attrs: Record<string, string>; cases: Case[] } {
  const suite = xml.match(/<testsuite\b([^>]*)>/);
  const attrs = parseAttrs(suite?.[1] ?? '');

  const cases: Case[] = [];
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;

  while ((m = caseRe.exec(xml)) !== null) {
    const a = parseAttrs(m[1]);
    const body = m[3] ?? '';

    let status: Case['status'] = 'passed';
    let type: string | null = null;
    let message: string | null = null;

    const fail = body.match(/<(failure|error)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/);
    if (fail) {
      status = fail[1] === 'error' ? 'error' : 'failure';
      const fa = parseAttrs(fail[2]);
      type = fa.type ?? null;
      message = decode(fa.message ?? fail[3] ?? '');
    } else if (/<skipped\b/.test(body)) {
      status = 'skipped';
      const sk = body.match(/<skipped\b([^>]*)/);
      message = decode(parseAttrs(sk?.[1] ?? '').message ?? '');
      // pytest는 xfail이 통과하면 skipped가 아니라 별도 표기하지만,
      // 메시지에 XPASS가 남는 경우를 잡아준다 (= 버그 수정 신호)
      if (/xpass/i.test(message ?? '')) status = 'xpass';
    }

    cases.push({
      nodeId: `${a.classname ?? ''}::${a.name ?? ''}`,
      name: a.name ?? '',
      classname: a.classname ?? '',
      status,
      type,
      message: message ? stripAnsi(message).slice(0, 800) : null,
    });
  }

  return { attrs, cases };
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w[\w:-]*)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out[m[1]] = decode(m[2]);
  return out;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&')
    .trim();
}

/** TC ID 추출 — 웹 테스트명에 ORD-007 같은 카탈로그 ID가 들어있다 */
function tcIdOf(c: Case): string | null {
  return (
    `${c.classname} ${c.name} ${c.message ?? ''}`.match(
      /\b(PUB|ORD|ROUTE|CTRL|RPT|MSG|SET|MY|INFO|PERM)-\d{3}\b/,
    )?.[1 - 1] ?? null
  );
}

/** 6종 분류 — 규칙만 사용 (LLM 0) */
export function classifyWebCase(c: Case): FindingKind {
  const text = `${c.type ?? ''} ${c.message ?? ''}`;

  if (c.status === 'xpass') return 'fix-confirmed';

  const tc = tcIdOf(c);
  if (tc && KNOWN_FLAKY.has(tc)) return 'unstable';

  if (/TimeoutError|waiting for (locator|selector)|not found|no such element/i.test(text)) {
    return 'selector-drift';
  }
  if (/KeyError|\b(4\d{2}|5\d{2})\b|JSONDecodeError|ConnectionError/.test(text)) {
    return 'contract-drift';
  }
  if (/flaky|StaleElement|intermittent/i.test(text)) return 'unstable';

  return 'bug-candidate';
}

export async function collectWebE2e(): Promise<CollectorResult> {
  return safely('web-e2e', async () => {
    const junitPath = path.join(WEB_DIR, 'reports', 'junit.xml');
    if (!fs.existsSync(junitPath)) {
      throw new Error(`junit.xml 없음: ${junitPath} (아직 실행 결과가 없습니다)`);
    }

    const stat = fs.statSync(junitPath);
    const xml = fs.readFileSync(junitPath, 'utf8');
    const { attrs, cases } = parseJUnit(xml);

    const total = Number(attrs.tests ?? cases.length);
    const failures = Number(attrs.failures ?? 0) + Number(attrs.errors ?? 0);
    const skipped = Number(attrs.skipped ?? 0);
    const passed = total - failures - skipped;
    const startedAt = attrs.timestamp ?? stat.mtime.toISOString();

    const runId = upsertTestRun({
      runner: 'web',
      suite: 'local-pytest',
      externalId: startedAt, // 빌드 번호가 없으므로 실행 시각을 식별자로
      status: failures > 0 ? 'failure' : 'success',
      total,
      passed,
      failed: failures,
      skipped,
      startedAt,
      durationSec: Math.round(Number(attrs.time ?? 0)),
      url: null,
    });

    const seen: string[] = [];
    let fixConfirmed = 0;

    for (const c of cases) {
      if (c.status === 'passed' || c.status === 'skipped') continue;

      const kind = classifyWebCase(c);
      if (kind === 'fix-confirmed') fixConfirmed++;

      const fp = makeFingerprint({
        runner: 'web',
        nodeId: c.nodeId,
        errorType: c.type ?? c.status,
        message: c.message,
      });
      seen.push(fp.fingerprint);

      upsertFinding({
        fingerprint: fp.fingerprint,
        runId,
        runner: 'web',
        nodeId: fp.nodeId,
        kind,
        verdictBy: 'rule',
        errorType: fp.errorType,
        messageNorm: fp.messageNorm,
        contractKey: tcIdOf(c),
        detail: c.message?.slice(0, 500) ?? null,
        observedAt: startedAt,
      });
    }

    markResolvedExcept('web', seen);

    // 결과가 오래됐으면 그것 자체가 신호다 (야간 회귀가 안 돌고 있다는 뜻)
    const ageDays = Math.floor((Date.now() - stat.mtimeMs) / 86_400_000);

    upsertSignal({
      source: 'web-e2e',
      kind: 'run',
      ref: `local-pytest:${startedAt}`,
      title:
        failures > 0
          ? `웹 E2E — ${failures}건 실패`
          : `웹 E2E — ${passed}/${total} 통과`,
      detail:
        ageDays >= 1
          ? `결과가 ${ageDays}일 전 것입니다 — 최근 실행 없음`
          : `스킵 ${skipped} · ${attrs.time ?? '?'}s`,
      severity: failures > 0 ? 'warn' : ageDays >= 3 ? 'idle' : 'ok',
      observedAt: startedAt,
      payload: { total, passed, failures, skipped, ageDays, fixConfirmed },
    });

    return {
      detail: `${passed}/${total} 통과 · 실패 ${failures}${ageDays >= 1 ? ` (${ageDays}일 전 결과)` : ''}`,
      count: total,
    };
  });
}
