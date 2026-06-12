import type { AIModel } from '@/types/session';

export const MODEL_SUPPORT = {
  claude: {
    label: 'Claude',
    version: 'Sonnet 4.6',
    color: '#6366F1',
    mcpNative: true,
    enabled: true,
  },
  gemini: {
    label: 'Gemini',
    version: '2.0 Flash',
    color: '#22C55E',
    mcpNative: false,
    enabled: false,
  },
  codex: {
    label: 'Codex',
    version: 'o4-mini',
    color: '#A855F7',
    mcpNative: false,
    enabled: false,
  },
} as const satisfies Record<
  AIModel,
  { label: string; version: string; color: string; mcpNative: boolean; enabled: boolean }
>;

/** MCP 툴 사용 가능 여부 */
export function canUseMcp(model: AIModel): boolean {
  return MODEL_SUPPORT[model].enabled && MODEL_SUPPORT[model].mcpNative;
}

/** 해당 모델이 활성화되어 있는지 */
export function isEnabled(model: AIModel): boolean {
  return MODEL_SUPPORT[model].enabled;
}

/** localStorage에서 저장된 모델을 읽어오되, 비활성 모델이면 claude로 fallback */
export function initModel(): AIModel {
  if (typeof window === 'undefined') return 'claude';
  const saved = localStorage.getItem('selectedModel') as AIModel | null;
  if (saved && isEnabled(saved)) return saved;
  return 'claude';
}

/** 모델 선택을 localStorage에 저장 */
export function persistModel(model: AIModel): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem('selectedModel', model);
}

/**
 * claude CLI가 보고한 실제 모델 ID를 사람이 읽는 버전 라벨로 변환.
 * 예) "claude-sonnet-4-6" → "Sonnet 4.6", "claude-opus-4-8[1m]" → "Opus 4.8"
 * CLI 기본 모델이 업데이트되면 이 변환 결과도 자동으로 따라간다.
 */
export function formatClaudeModel(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  // 컨텍스트 마커([1m] 등)와 날짜 suffix(-20251001) 제거
  const cleaned = modelId.replace(/\[[^\]]*\]/g, '').replace(/-\d{8}$/, '');
  // 최신 형식: claude-<tier>-<major>-<minor>
  const m = cleaned.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) {
    const tier = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return `${tier} ${m[2]}.${m[3]}`;
  }
  // 알 수 없는 형식은 claude- 접두만 떼고 그대로 노출
  const fallback = cleaned.replace(/^claude-/, '').trim();
  return fallback || null;
}

const DETECTED_MODEL_KEY = 'detectedClaudeModel';

/** 마지막으로 감지한 claude 실제 모델 ID를 localStorage에서 읽기 */
export function readDetectedClaudeModel(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(DETECTED_MODEL_KEY);
}

/** 감지한 claude 실제 모델 ID를 localStorage에 저장 */
export function persistDetectedClaudeModel(modelId: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(DETECTED_MODEL_KEY, modelId);
}
