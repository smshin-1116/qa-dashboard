import { NextResponse } from 'next/server';

/**
 * MCP 서버 연결 상태를 반환합니다.
 * 실제 환경에서는 각 MCP 서버에 ping을 보내거나 프로세스 상태를 확인합니다.
 * 현재는 환경변수 존재 여부로 연결 상태를 판단합니다.
 */
export async function GET() {
  const servers = [
    {
      name: 'Figma',
      connected: !!process.env.FIGMA_ACCESS_TOKEN,
      tools: ['get_design_context', 'get_screenshot', 'generate_diagram'],
    },
    {
      name: 'Jira',
      connected: !!(process.env.CONFLUENCE_API_TOKEN && process.env.CONFLUENCE_BASE_URL),
      tools: ['searchJiraIssues', 'createJiraIssue', 'editJiraIssue'],
    },
    {
      name: 'GitHub',
      connected: !!process.env.GITHUB_TOKEN,
      tools: ['search_code', 'list_issues', 'create_pull_request'],
    },
  ];

  return NextResponse.json({ servers });
}
