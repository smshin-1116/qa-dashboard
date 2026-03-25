'use client';

import { useState, useEffect } from 'react';

export interface McpServerStatus {
  name: string;
  connected: boolean;
  tools: string[];
}

interface McpStatusResponse {
  servers: McpServerStatus[];
}

// 폴링 간격 (ms)
const POLL_INTERVAL = 30_000;

// 알려진 MCP 서버 기본값 (API 응답 전까지 표시)
const DEFAULT_SERVERS: McpServerStatus[] = [
  { name: 'Figma', connected: false, tools: ['get_design_context', 'get_screenshot', 'generate_diagram'] },
  { name: 'Jira',  connected: false, tools: ['searchJiraIssues', 'createJiraIssue', 'editJiraIssue'] },
  { name: 'GitHub', connected: false, tools: ['search_code', 'list_issues', 'create_pull_request'] },
];

export function useMcpStatus() {
  const [servers, setServers] = useState<McpServerStatus[]>(DEFAULT_SERVERS);

  useEffect(() => {
    let cancelled = false;

    async function fetchStatus() {
      try {
        const res = await fetch('/api/dashboard/mcp-status');
        if (!res.ok) return;
        const data: McpStatusResponse = await res.json();
        if (!cancelled) setServers(data.servers);
      } catch {
        // 네트워크 오류 시 현재 상태 유지
      }
    }

    fetchStatus();
    const timer = setInterval(fetchStatus, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const statusMap = Object.fromEntries(
    servers.map((s) => [s.name.toLowerCase(), s.connected])
  ) as Record<string, boolean>;

  return {
    servers,
    mcpStatus: {
      figma: statusMap['figma'] ?? false,
      jira: statusMap['jira'] ?? false,
      git: statusMap['github'] ?? false,
    },
  };
}
