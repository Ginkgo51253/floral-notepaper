export interface Range {
  start: number;
  end: number;
}

/**
 * 在 content 中查找所有匹配 query 的子串，返回偏移范围列表。
 * @param content  要搜索的文本
 * @param query    搜索关键词
 * @param caseSensitive  是否区分大小写，默认 false
 */
export function findAll(content: string, query: string, caseSensitive = false): Range[] {
  if (!query) return [];

  const results: Range[] = [];
  const source = caseSensitive ? content : content.toLowerCase();
  const search = caseSensitive ? query : query.toLowerCase();
  const searchLen = search.length;

  let pos = 0;
  while (pos < source.length) {
    const index = source.indexOf(search, pos);
    if (index === -1) break;
    results.push({ start: index, end: index + searchLen });
    pos = index + searchLen;
  }

  return results;
}

/**
 * 判断字符串中指定范围是否构成一个"全字"边界：
 * 范围前后的字符均不是 \w（字母、数字、下划线）。
 */
export function isWordBoundary(content: string, start: number, end: number): boolean {
  const charBefore = start > 0 ? content[start - 1] : undefined;
  const charAfter = end < content.length ? content[end] : undefined;
  if (charBefore !== undefined && /\w/.test(charBefore)) return false;
  if (charAfter !== undefined && /\w/.test(charAfter)) return false;
  return true;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 构建带高亮标记的 HTML 字符串，用于在 textarea 底层渲染匹配高亮。
 * @param content  原始文本内容
 * @param matches  匹配范围列表（可由 findAll 返回）
 * @param currentIndex  当前选中的匹配索引，用于特殊高亮
 * @returns  可直接设置为 innerHTML 的字符串，已转义 + <mark> 包裹 + 换行转 <br/>
 */
export function buildHighlightHTML(
  content: string,
  matches: Range[],
  currentIndex: number,
): string {
  if (!matches.length) {
    // 无匹配：直接转义全文，换行转 <br/>
    return escapeHtml(content).replace(/\n/g, "<br/>");
  }

  const parts: string[] = [];
  let lastEnd = 0;

  for (let i = 0; i < matches.length; i++) {
    const { start, end } = matches[i];
    // 匹配前的普通文本
    if (start > lastEnd) {
      parts.push(escapeHtml(content.slice(lastEnd, start)));
    }
    // 匹配文本（高亮包裹）
    const isCurrent = i === currentIndex;
    const cls = isCurrent ? ' class="fh-current"' : ' class="fh-match"';
    parts.push(`<mark${cls}>${escapeHtml(content.slice(start, end))}</mark>`);
    lastEnd = end;
  }
  // 末尾剩余文本
  if (lastEnd < content.length) {
    parts.push(escapeHtml(content.slice(lastEnd)));
  }

  // 合并后统一将换行转 <br/>
  return parts.join("").replace(/\n/g, "<br/>");
}
