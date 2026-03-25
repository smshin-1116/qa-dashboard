import { createHighlighter, type Highlighter } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark'],
      langs: [
        'typescript',
        'javascript',
        'python',
        'java',
        'bash',
        'json',
        'html',
        'css',
        'sql',
        'markdown',
      ],
    });
  }
  return highlighterPromise;
}

export async function highlight(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter();
  const loadedLangs = hl.getLoadedLanguages();
  const safeLang = loadedLangs.includes(lang as never) ? lang : 'text';

  return hl.codeToHtml(code, {
    lang: safeLang,
    theme: 'github-dark',
  });
}

/** 마크다운 텍스트에서 ```lang ... ``` 블록을 Shiki HTML로 변환 */
export async function highlightMarkdown(text: string): Promise<string> {
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  const replacements: Array<{ original: string; html: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const lang = match[1] || 'text';
    const code = match[2];
    const html = await highlight(code, lang);
    replacements.push({ original: match[0], html });
  }

  let result = text;
  for (const { original, html } of replacements) {
    result = result.replace(original, html);
  }
  return result;
}
