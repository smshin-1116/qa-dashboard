/**
 * Codex → Claude 인계 계약 — 시안 "인계 계약" 카드의 스키마 그대로.
 *
 * ── 왜 계약이 필요한가 ────────────────────────────────────────────────
 * ⓪흡수·①교차분석(Codex)과 ③설계 이후(Claude)는 **모델이 바뀌는 지점**이다.
 * 시안: "스키마가 흔들리면 여기서 전부 깨진다" — 그래서 형태를 못 박고,
 * 이 형태를 벗어나면 진행하지 않는다 (1차 검증 → 2차 재시도 → 폴백).
 *
 * ── 검증이 두 겹인 이유 ───────────────────────────────────────────────
 * codex의 `--output-schema`가 형태(타입·필수 필드)는 강제하지만,
 * **참조 무결성**(requirements.from[]이 실재하는 source id를 가리키는지)은
 * JSON Schema로 표현이 안 된다. 그 검사가 validateContract()다.
 */

export interface ContractSource {
  /** S1, S2 … 또는 RV-1284 · PR#4239 같은 식별자 */
  id: string;
  /** PR·코드: 티켓에 연결된 구현을 gh로 읽은 것 (2026-08-11 추가) — TC의 기대결과를 구현 사실에 붙들어 맨다 */
  type: '티켓' | '버그' | '기획서' | '명세' | '텍스트' | 'PR' | '코드' | '기타';
  url: string | null;
  /** 추출 요약 — 다음 단계로 넘어가는 것은 원문이 아니라 이것뿐 */
  summary: string;
  /** 이 소스만 봐서는 알 수 없는 것 */
  unclear: string[];
}

export interface ContractRequirement {
  id: string;
  text: string;
  /** 출처 source id — TC마다 근거를 되짚는 핵심 */
  from: string[];
  screens: string[];
  apis: string[];
}

export interface ContractConflict {
  topic: string;
  sides: Array<{ source: string; claim: string; updated_at?: string | null }>;
  severity: 'crit' | 'warn';
}

export interface ContractGap {
  text: string;
  mentioned_in: string;
  covered_by: string | null;
}

export interface ContractDecision {
  question: string;
  answer: string;
  decided_by: 'human';
}

export interface Contract {
  sources: ContractSource[];
  requirements: ContractRequirement[];
  conflicts: ContractConflict[];
  duplicates: Array<{ requirement_ids: string[] }>;
  gaps: ContractGap[];
  impacts: { tc_ids: string[]; contract_keys: string[]; open_bugs: string[] };
  /** ② 확인 게이트에서 사람이 채운다 — Codex는 빈 배열로 낸다 */
  decisions: ContractDecision[];
}

/**
 * codex `--output-schema`에 넘길 JSON Schema.
 * 형태 강제용 — 참조 무결성은 아래 validateContract()가 맡는다.
 */
export const CONTRACT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sources', 'requirements', 'conflicts', 'duplicates', 'gaps', 'impacts', 'decisions'],
  properties: {
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type', 'url', 'summary', 'unclear'],
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['티켓', '버그', '기획서', '명세', '텍스트', 'PR', '코드', '기타'] },
          url: { type: ['string', 'null'] },
          summary: { type: 'string' },
          unclear: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'from', 'screens', 'apis'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          from: { type: 'array', items: { type: 'string' } },
          screens: { type: 'array', items: { type: 'string' } },
          apis: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'sides', 'severity'],
        properties: {
          topic: { type: 'string' },
          sides: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              // ⚠️ OpenAI 구조화 출력은 모든 프로퍼티가 required여야 한다 (실측 400).
              // 선택 필드는 required에 넣고 null 허용으로 표현한다.
              required: ['source', 'claim', 'updated_at'],
              properties: {
                source: { type: 'string' },
                claim: { type: 'string' },
                updated_at: { type: ['string', 'null'] },
              },
            },
          },
          severity: { type: 'string', enum: ['crit', 'warn'] },
        },
      },
    },
    duplicates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement_ids'],
        properties: { requirement_ids: { type: 'array', items: { type: 'string' } } },
      },
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'mentioned_in', 'covered_by'],
        properties: {
          text: { type: 'string' },
          mentioned_in: { type: 'string' },
          covered_by: { type: ['string', 'null'] },
        },
      },
    },
    impacts: {
      type: 'object',
      additionalProperties: false,
      required: ['tc_ids', 'contract_keys', 'open_bugs'],
      properties: {
        tc_ids: { type: 'array', items: { type: 'string' } },
        contract_keys: { type: 'array', items: { type: 'string' } },
        open_bugs: { type: 'array', items: { type: 'string' } },
      },
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'answer', 'decided_by'],
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          decided_by: { type: 'string', enum: ['human'] },
        },
      },
    },
  },
} as const;

/**
 * 참조 무결성 검증 — 시안 1차 게이트.
 * 위반 목록을 돌려주고, 비어 있으면 통과다. 위반은 그대로 Codex 재시도
 * 프롬프트에 들어가므로 **무엇이 어디서 틀렸는지** 특정해서 적는다.
 */
/**
 * 계약 정규화 — 검증 **전에** 치명적이지 않은 흠을 조용히 고친다.
 *
 * codex가 같은 PR을 두 번 넣는 일이 있다(실측 2026-08-12: `PR#2820` 중복).
 * 중복 id는 화면 key 충돌을 일으키지만 분석 자체를 못 쓰게 만들 정도는 아니다.
 * 이를 검증 실패로 처리하면 재시도·폴백으로 흡수 전체가 무너지므로,
 * **첫 항목만 남기고 중복을 제거**해 통과시킨다(등장 순서 유지).
 */
export function normalizeContract(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const c = raw as Contract;
  if (Array.isArray(c.sources)) {
    const seen = new Set<string>();
    c.sources = c.sources.filter((s) => s && !seen.has(s.id) && seen.add(s.id) != null);
  }
  if (Array.isArray(c.requirements)) {
    const seen = new Set<string>();
    c.requirements = c.requirements.filter((r) => r && !seen.has(r.id) && seen.add(r.id) != null);
  }
  return c;
}

export function validateContract(raw: unknown): { contract: Contract | null; violations: string[] } {
  const v: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { contract: null, violations: ['최상위가 객체가 아님'] };
  }
  const c = raw as Contract;

  for (const key of ['sources', 'requirements', 'conflicts', 'duplicates', 'gaps', 'decisions'] as const) {
    if (!Array.isArray(c[key])) v.push(`${key}가 배열이 아님`);
  }
  if (typeof c.impacts !== 'object' || c.impacts === null) v.push('impacts가 객체가 아님');
  if (v.length) return { contract: null, violations: v };

  if (c.sources.length === 0) v.push('sources가 비어 있음 — 읽은 소스가 하나는 있어야 한다');

  const srcIds = new Set(c.sources.map((s) => s.id));
  const dupSrc = c.sources.length !== srcIds.size;
  if (dupSrc) v.push('sources.id에 중복이 있음');

  const reqIds = new Set<string>();
  for (const r of c.requirements) {
    if (reqIds.has(r.id)) v.push(`requirements.id 중복: ${r.id}`);
    reqIds.add(r.id);
    if (r.from.length === 0) v.push(`요구 ${r.id}의 from[]이 비어 있음 — 출처 없는 요구는 받지 않는다`);
    for (const f of r.from) {
      if (!srcIds.has(f)) v.push(`요구 ${r.id}의 from "${f}"가 실재하는 source가 아님`);
    }
  }

  for (const [i, cf] of c.conflicts.entries()) {
    if (cf.sides.length < 2) v.push(`모순 #${i + 1} "${cf.topic}"의 sides가 2개 미만 — 한쪽뿐이면 모순이 아니다`);
    for (const s of cf.sides) {
      if (!srcIds.has(s.source)) v.push(`모순 "${cf.topic}"의 source "${s.source}"가 실재하지 않음`);
    }
  }

  for (const d of c.duplicates) {
    for (const rid of d.requirement_ids) {
      if (!reqIds.has(rid)) v.push(`duplicates의 요구 "${rid}"가 실재하지 않음`);
    }
  }

  return { contract: v.length ? null : c, violations: v };
}
