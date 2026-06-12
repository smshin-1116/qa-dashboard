'use client';

/**
 * 기능 분석 화면 중앙 상단의 MCP 연동 상태 칩바 (시안의 "🟠Figma 🔵Jira 🟢GitHub" 영역).
 * 헤더에서 빠진 MCP 상태 배지를 여기로 옮겨 헤더를 시안처럼 깔끔하게 유지한다.
 */
interface McpStatusBarProps {
  mcpStatus: { figma: boolean; jira: boolean; git: boolean };
}

const CHIPS: { key: 'figma' | 'jira' | 'git'; label: string; emoji: string; color: string }[] = [
  { key: 'figma', label: 'Figma', emoji: '🎨', color: '#F97316' },
  { key: 'jira', label: 'Jira', emoji: '📋', color: '#60A5FA' },
  { key: 'git', label: 'GitHub', emoji: '🐙', color: '#22C55E' },
];

export default function McpStatusBar({ mcpStatus }: McpStatusBarProps) {
  return (
    <div className="flex items-center gap-2 px-5 py-2.5 border-b border-[#1E2535] bg-[#111520] flex-shrink-0">
      {CHIPS.map((chip) => {
        const connected = mcpStatus[chip.key];
        return (
          <span
            key={chip.key}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium"
            style={{
              color: connected ? chip.color : '#64748B',
              borderColor: connected ? chip.color : '#2A3347',
              backgroundColor: connected ? `${chip.color}1F` : 'transparent',
            }}
          >
            <span
              className="w-[7px] h-[7px] rounded-full"
              style={{ backgroundColor: connected ? chip.color : '#475569' }}
            />
            {chip.emoji} {chip.label} {connected ? '연결' : '미연결'}
          </span>
        );
      })}
    </div>
  );
}
