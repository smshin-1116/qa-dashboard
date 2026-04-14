import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const MCP_SERVER_CONFIG = [
  {
    name: 'Figma',
    keys: ['figma-remote-mcp', 'claude.ai figma', 'figma'],
    tools: ['get_design_context', 'get_screenshot', 'generate_diagram'],
  },
  {
    name: 'Jira',
    keys: ['atlassian', 'claude.ai atlassian', 'jira'],
    tools: ['searchJiraIssues', 'createJiraIssue', 'editJiraIssue'],
  },
  {
    name: 'GitHub',
    keys: ['github', 'claude.ai github'],
    tools: ['search_code', 'list_issues', 'create_pull_request'],
  },
];

async function getConnectedMcpServers(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('claude', ['mcp', 'list'], { timeout: 10000 });
    const connected = new Set<string>();
    for (const line of stdout.split('\n')) {
      // '✓ Connected' 또는 '! Needs authentication' 모두 서버가 살아있는 상태로 처리
      if (line.includes('✓ Connected') || line.includes('Needs authentication')) {
        const serverName = line.split(':')[0].trim().toLowerCase();
        connected.add(serverName);
      }
    }
    return connected;
  } catch {
    return new Set();
  }
}

export async function GET() {
  const connected = await getConnectedMcpServers();

  const servers = MCP_SERVER_CONFIG.map((config) => ({
    name: config.name,
    connected: config.keys.some((key) => connected.has(key.toLowerCase())),
    tools: config.tools,
  }));

  return NextResponse.json({ servers });
}
