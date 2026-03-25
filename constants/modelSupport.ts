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
