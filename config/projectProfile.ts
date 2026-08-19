/**
 * 프로젝트 프로파일 (2026-08-20, si-adaptation 브랜치)
 * ────────────────────────────────────────────────────────────────────────
 * 이 대시보드는 원래 Roouty 전용으로 만들어졌고, 도메인 지식(용어·예시·명세 스킬·
 * 역할·수집 대상)이 프롬프트와 수집기에 흩어져 박혀 있었다. 다른 프로젝트(SI 등)에서
 * 쓰려면 그 값들을 한곳에 모아 갈아끼울 수 있어야 한다.
 *
 * ⚠️ 안전 원칙 — 이 파일은 "값을 옮기는" 곳이지 "값을 바꾸는" 곳이 아니다.
 *   `roouty` 프로파일의 값은 기존 코드 리터럴과 **바이트 단위로 동일**해야 하며,
 *   프롬프트를 조립한 결과가 리팩터 전과 같은지는 골든 스냅샷 테스트로 못 박는다.
 *   (그래야 이 프로파일을 도입해도 Roouty 동작이 한 글자도 안 바뀐다.)
 *
 * 선택: 환경변수 `PROJECT_PROFILE` (미설정 시 'roouty' — 즉 기존 동작이 기본값).
 */

export interface RoleDef {
  /** 내부 키 — QA 계정 env 접두사와 매칭 (예: 'SALES' → QA_SALES_EMAIL) */
  role: string;
  /** 화면·프롬프트 표시 라벨 */
  label: string;
}

export interface AreaRule {
  /** 분류 이름 (예: '배차·최적화') */
  area: string;
  /** 파일·PR·TC 텍스트를 이 영역으로 분류하는 정규식 */
  re: RegExp;
}

export interface CatalogPrefixRule {
  /** 카탈로그 ID 접두사 (예: 'ROUTE') */
  prefix: string;
  /** 이 접두사를 붙일 TC를 고르는 정규식 */
  re: RegExp;
}

export interface ProjectProfile {
  /** 프로파일 식별자 */
  id: string;
  /** 제품/서비스 이름 — 프롬프트에서 "○○ 제품 기능" 식으로 쓰인다 */
  productName: string;

  /**
   * 명세(ground truth) 스킬 이름. 설계·분석 단계에서 로드한다.
   * 해당 스킬이 없는 프로젝트는 null → 프롬프트에서 로드 지시를 통째로 뺀다
   * (없는 스킬을 부르라고 시키면 에이전트가 헛돈다).
   */
  specSkill: string | null;

  /**
   * 시스템 프롬프트(BASE_CONTEXT) 맨 앞 "명세 우선 참고" 섹션 전문.
   * 도메인 색이 가장 짙게 배는 곳 — 제품 이름·명세 스킬·"실제 서비스" 표현이 들어간다.
   * ⚠️ roouty 값은 기존 리터럴(2026-08-13 버전 BASE_CONTEXT 107~110행)과 바이트 동일해야 함.
   */
  specGuidanceBlock: string;

  /**
   * 파이프라인(기획서 1건 → 4단계) 전용 "명세 우선 참고" 지시문.
   * chat용 specGuidanceBlock과 문구가 조금 다르다(파이프라인은 Confluence·Jira AC 대조 강조).
   * ⚠️ roouty 값은 기존 pipeline/run/route.ts의 ROOUTY_SPEC_DIRECTIVE와 바이트 동일해야 함.
   */
  pipelineSpecDirective: string;

  /** stage(비운영) 환경 — TC 수행이 접속하는 곳. read-only 원칙은 코드가 강제한다. */
  stage: {
    /** 화면 base (예: https://tms-stage.roouty.io) */
    webBaseUrl: string;
    /** API base (예: https://tms-api-stage.roouty.io) */
    apiBaseUrl: string;
  } | null;

  /** QA 검증 계정 역할 모델 — 조직마다 다르다 */
  roles: RoleDef[];

  /**
   * 프롬프트에 넣는 TC 예시 표 한 줄. 에이전트는 이 견본을 흉내 내 TC를 만든다.
   * ⚠️ 파서가 읽는 컬럼 구조와 어긋나면 안 됨 — 형식은 유지, 도메인만 프로젝트에 맞춘다.
   */
  tcExampleRow: string;

  /** "추상 표현 금지" 규칙의 좋음/나쁨 예시 (프롬프트 표) — [규칙, 나쁜예, 좋은예] */
  writingExamples: Array<{ rule: string; bad: string; good: string }>;

  /** 수집기(collectors) — 오늘 탭 신호원. 프로젝트마다 레포·분류가 다르다. */
  collectors: {
    /** stage PR 대조 대상 레포들 (예: WEMEETPLACE/roouty-admin-react) */
    adminRepos: Array<{ slug: string; label: string }>;
    /** PR·파일을 기능 영역으로 분류하는 규칙 */
    areaRules: AreaRule[];
    /** 자동화 카탈로그 ID 접두사 규칙 */
    catalogPrefixRules: CatalogPrefixRule[];
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Roouty 프로파일 — 기존 동작을 그대로 담는다 (값은 현 코드 리터럴과 동일해야 함).
   ⚠️ 아래 문자열들은 프롬프트 배선 시 골든 스냅샷으로 원본과 대조해 확정한다.
   ══════════════════════════════════════════════════════════════════════════ */
export const rooutyProfile: ProjectProfile = {
  id: 'roouty',
  productName: 'Roouty',
  specSkill: 'roouty-spec',
  specGuidanceBlock: `## Roouty 명세 우선 참고 (중요)
- Roouty 제품 기능(자동배차, 배차계획, 모니터링, 납품처관리, 인수증, 설정 등)에 대한 작업이면, 답을 만들기 전에 **반드시 \`roouty-spec\` 스킬을 먼저 실행**하여 관련 화면 명세를 ground truth로 로드하세요.
- 명세의 권한·검색 필드·목록 컬럼·실패/예외 규칙을 근거로 삼고, 거기에 Jira(티켓/AC)·Confluence(기획)·Figma(화면)를 MCP로 대조해 실제 루티 서비스에 밀착된 산출물을 만드세요.
- 산출물에는 참고한 근거(명세 문서명 + 티켓 키 등)를 명시하고, 명세에 없거나 모순되는 부분은 "명세 미정의"로 표시하세요.`,
  pipelineSpecDirective: `## Roouty 명세 우선 참고 (중요)
- 이 작업은 Roouty 제품 기능에 대한 것입니다. 답을 만들기 전에 **반드시 \`roouty-spec\` 스킬을 먼저 실행**하여 관련 화면 명세를 ground truth로 로드하세요.
- 명세의 권한·검색 필드·목록 컬럼·실패/예외 규칙을 근거로 삼고, 거기에 Confluence 기획·Jira AC를 대조해 실제 루티 서비스에 밀착된 산출물을 만드세요.
- 산출물에는 참고한 근거(명세 문서명 + 티켓 키 등)를 명시하고, 명세에 없거나 모순되는 부분은 "명세 미정의"로 표시하세요.`,
  stage: {
    webBaseUrl: 'https://tms-stage.roouty.io',
    apiBaseUrl: 'https://tms-api-stage.roouty.io',
  },
  roles: [
    { role: 'SALES', label: 'SALES(영업매니저)' },
    { role: 'ADMIN', label: 'ADMIN(관리자)' },
    { role: 'DISPATCH', label: 'DISPATCH(배차담당)' },
  ],
  tcExampleRow:
    '| TC-001 | 배차 관리 | 자동 최적화 배차 | 배차 실행 | 정상 | 로그인 상태, 주문 3건 등록 | 1. 배차 실행 버튼 클릭 2. 배차 결과 화면 확인 | 주문 3건이 배차 완료 상태로 표시됨 | PC(Web) | Not Test | |',
  writingExamples: [
    { rule: '추상 표현 금지', bad: '"정상 동작하는지 확인"', good: '"배차 실행 버튼 클릭 시 배차 결과 화면으로 이동하는지 확인"' },
    { rule: '테스트 스텝 3요소 필수', bad: '"배차하면 확인"', good: '"[로그인 상태, 주문 3건]에서 [배차 실행]하면 [주문 3건 배차 완료 표시]되는지 확인"' },
    { rule: '경계값 수치 필수', bad: '"주문이 없을 때"', good: '"주문 0건인 상태에서 배차 실행 시 \'배차할 주문이 없습니다\' 메시지가 표시되는지 확인"' },
  ],
  collectors: {
    adminRepos: [{ slug: 'WEMEETPLACE/roouty-admin-react', label: 'admin' }],
    areaRules: [{ area: '배차·최적화', re: /(route|optimize|dispatch|engine)/i }],
    catalogPrefixRules: [{ prefix: 'ROUTE', re: /배차|경로|최적화|route/i }],
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   Generic 프로파일 — 도메인 중립. SI 등 임의 프로젝트의 출발점.
   기획서를 붙여넣으면 그 내용만으로 TC를 만들도록, 특정 도메인 용어를 넣지 않는다.
   프로젝트가 정해지면 이 값을 그 서비스에 맞게 채운다.
   ══════════════════════════════════════════════════════════════════════════ */
export const genericProfile: ProjectProfile = {
  id: 'generic',
  productName: '대상 서비스',
  specSkill: null, // 명세 스킬 없음 — 붙여넣은 기획서·소스만 ground truth
  specGuidanceBlock: `## 명세·기획 우선 참고 (중요)
- 붙여넣은 기획서·티켓·문서를 ground truth로 삼아 분석하세요. 별도 명세 스킬은 사용하지 않습니다.
- Jira(티켓/AC)·Confluence(기획)·Figma(화면)를 MCP로 대조해 대상 서비스에 밀착된 산출물을 만드세요.
- 산출물에는 참고한 근거(문서명 + 티켓 키 등)를 명시하고, 근거에 없거나 모순되는 부분은 "명세 미정의"로 표시하세요.`,
  pipelineSpecDirective: `## 명세·기획 우선 참고 (중요)
- 붙여넣은 기획서·티켓을 ground truth로 삼아 분석하세요. 별도 명세 스킬은 사용하지 않습니다.
- 요구·권한·예외 규칙을 근거로 삼고, Confluence 기획·Jira AC를 대조해 대상 서비스에 밀착된 산출물을 만드세요.
- 산출물에는 참고한 근거(문서명 + 티켓 키 등)를 명시하고, 근거에 없거나 모순되는 부분은 "명세 미정의"로 표시하세요.`,
  stage: null, // 수행 환경은 프로젝트별로 .env + 프로파일에서 지정
  roles: [{ role: 'USER', label: 'USER(일반 사용자)' }],
  tcExampleRow:
    '| TC-001 | 회원 | 로그인 | 이메일 로그인 | 정상 | 가입된 계정 보유 | 1. 이메일·비밀번호 입력 2. 로그인 버튼 클릭 | 홈 화면으로 이동하고 사용자 이름이 표시됨 | PC(Web) | Not Test | |',
  writingExamples: [
    { rule: '추상 표현 금지', bad: '"정상 동작하는지 확인"', good: '"로그인 버튼 클릭 시 홈 화면으로 이동하는지 확인"' },
    { rule: '테스트 스텝 3요소 필수', bad: '"로그인하면 확인"', good: '"[가입된 계정]으로 [로그인]하면 [홈 화면 이동 + 사용자 이름 표시]되는지 확인"' },
    { rule: '경계값 수치 필수', bad: '"입력이 없을 때"', good: '"이메일 0글자로 로그인 시 \'이메일을 입력하세요\' 메시지가 표시되는지 확인"' },
  ],
  collectors: {
    adminRepos: [],
    areaRules: [],
    catalogPrefixRules: [{ prefix: 'TC', re: /.*/ }],
  },
};

const PROFILES: Record<string, ProjectProfile> = {
  roouty: rooutyProfile,
  generic: genericProfile,
};

/**
 * 활성 프로파일. 미설정이면 'roouty' — 즉 기존 동작이 기본값이라, 이 파일을
 * 도입하는 것만으로는 아무것도 바뀌지 않는다. SI 폴더에서는 .env.local에
 * `PROJECT_PROFILE=generic`을 넣어 중립 프로파일로 전환한다.
 */
export const activeProfile: ProjectProfile =
  PROFILES[process.env.PROJECT_PROFILE ?? 'roouty'] ?? rooutyProfile;
