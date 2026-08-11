import { NextResponse } from 'next/server';
import { getDb, nowIso, todayKst } from '@/lib/workspace/db';
import {
  activeNotices,
  dismissNotice,
  getNotice,
  removeNotice,
  snoozeNotice,
  upsertTodo,
} from '@/lib/workspace/repo';
import { promote } from '@/lib/workspace/todo';
import type { NoticeKind, Priority } from '@/lib/workspace/types';

/**
 * 🔔 알림 — 오늘 할 일과 **분리된** 느린 신호.
 *
 * 오늘 할 일 = 오늘 처리할 것 (완료하면 체크)
 * 알림       = 며칠~몇 주째 정체된 것 (경과일이 핵심, 미루거나 끌 수 있다)
 * 섞으면 오늘 할 일이 잔소리로 오염되므로 화면과 API를 나눈다.
 *
 * ── 토큰 ──────────────────────────────────────────────────────────────
 * LLM 호출 0. 상태 저장소 조회·갱신만 한다.
 */
export const dynamic = 'force-dynamic';

/** 화면 그룹 정의 — 순서가 곧 표시 순서 */
const GROUPS: Array<{ kind: NoticeKind; title: string; hint: string }> = [
  {
    kind: 'carry-over',
    title: '이월 상한 초과 — 오늘 할 일에서 이동됨',
    hint: 'D+7을 넘긴 항목. 매일 밀리는 것을 오늘 할 일에 남겨두면 목록이 무의미해진다',
  },
  {
    kind: 'stale-asset',
    title: '방치 자산 — 7일 이상 실행 신호 없음',
    hint: '스케줄이 멈췄거나 실행 환경이 막혀 있을 수 있다',
  },
  {
    kind: 'stalled-ticket',
    title: '정체 티켓 — 같은 상태로 오래 머묾',
    hint: '경과일은 Jira changelog의 실제 상태 전이 시각 기준',
  },
  { kind: 'metric-stall', title: '지표 정체', hint: '정체가 항상 문제는 아니다 — 의도된 것이면 끄면 된다' },
  { kind: 'skip-limit', title: '미구현 스켈레톤 상한', hint: '껍데기만 쌓이면 "테스트가 있다"는 착시가 생긴다' },
];

export async function GET() {
  const rows = activeNotices();

  const groups = GROUPS.map((g) => ({
    ...g,
    items: rows
      .filter((r) => r.kind === g.kind)
      .map((r) => ({
        kind: r.kind,
        key: r.key,
        title: r.title,
        detail: r.detail,
        source: r.source,
        since: r.since,
        days: r.days,
        originalPriority: r.original_priority,
        /** 복귀 시 올라갈 우선순위 (규칙 ⑤) */
        promotedTo: r.original_priority ? promote(r.original_priority as Priority) : null,
      })),
  })).filter((g) => g.items.length > 0);

  // 미룬 것도 개수는 알려준다 — "숨겼다"는 사실 자체가 정보다
  const snoozed = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM notice WHERE dismissed = 0 AND snoozed_until >= ?`,
      )
      .get(nowIso()) as { c: number }
  ).c;

  return NextResponse.json({ total: rows.length, snoozed, groups });
}

interface ActionBody {
  kind: NoticeKind;
  key: string;
  action: 'return' | 'backlog' | 'snooze' | 'dismiss';
  /** snooze 전용 — 며칠 뒤에 다시 뜰지 (기본 7) */
  days?: number;
}

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<ActionBody>;
  if (!body.kind || !body.key || !body.action) {
    return NextResponse.json({ error: 'kind·key·action이 필요합니다' }, { status: 400 });
  }

  const notice = getNotice(body.kind, body.key);
  if (!notice) return NextResponse.json({ error: '알림을 찾을 수 없습니다' }, { status: 404 });

  switch (body.action) {
    /**
     * 오늘로 복귀 — 규칙 ⑤
     *   경과일 유지 + 우선순위 1단계 승격 + 📌 고정
     *
     * 고정이 없으면 다음 산출에서 D+7 규칙에 다시 걸려 즉시 알림으로 튕겨나간다.
     * 나머지 필드(제목·상세·행동 버튼)는 다음 buildToday가 후보에서 다시 채운다.
     */
    case 'return': {
      const day = todayKst();
      upsertTodo({
        day,
        key: notice.origin_todo_key ?? notice.key,
        priority: promote((notice.original_priority ?? 'P3') as Priority),
        title: notice.title,
        detail: notice.detail,
        source: notice.source,
        mode: 'manual',
        firstDay: notice.since?.slice(0, 10) ?? day,
        pinned: true,
        promoted: true,
      });
      removeNotice(body.kind, body.key);
      return NextResponse.json({ ok: true, movedTo: 'today' });
    }

    /** 백로그로 — 오늘 할 일에서 완전히 내린다 (알림에서도 사라짐) */
    case 'backlog':
      dismissNotice(body.kind, body.key);
      return NextResponse.json({ ok: true, movedTo: 'backlog' });

    /** 미룸 — 지정 일수 뒤 재등장 */
    case 'snooze':
      snoozeNotice(body.kind, body.key, body.days ?? 7);
      return NextResponse.json({ ok: true, snoozedDays: body.days ?? 7 });

    /** 끄기 — 영구 숨김. 조건이 해소되면 행 자체가 정리된다 */
    case 'dismiss':
      dismissNotice(body.kind, body.key);
      return NextResponse.json({ ok: true });

    default:
      return NextResponse.json({ error: '알 수 없는 action' }, { status: 400 });
  }
}
