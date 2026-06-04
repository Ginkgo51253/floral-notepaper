export interface Range {
  start: number;
  end: number;
}

/**
 * 在 content 中查找所有匹配 query 的子串，返回偏移范围列表。
 * @param content  要搜索的文本
 * @param query    搜索关键词
 * @param caseSensitive  是否区分大小写，默认 false
 * @param useRegex  是否将 query 作为正则表达式处理，默认 false
 * @param wholeWord  是否全字匹配（前后边界非 \w），默认 false
 */
export function findAll(
  content: string,
  query: string,
  caseSensitive = false,
  useRegex = false,
  wholeWord = false,
): Range[] {
  if (!query) return [];

  let results: Range[];

  if (useRegex) {
    try {
      const flags = caseSensitive ? "g" : "gi";
      const regex = new RegExp(query, flags);
      results = [];
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        results.push({ start: match.index, end: match.index + match[0].length });
        if (match[0].length === 0) regex.lastIndex++;
      }
    } catch {
      return [];
    }
  } else {
    results = [];
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
  }

  // 全字匹配过滤
  if (wholeWord && results.length > 0) {
    results = results.filter((r) => isWordBoundary(content, r.start, r.end));
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

/**
 * 保留大小写变换：将 replacement 按照 matched 的大小写模式重新映射。
 * 例如 matched="Word" replacement="text" → "Text"；matched="WORD" → "TEXT"。
 */
function preserveCaseTransform(matched: string, replacement: string): string {
  if (!matched || !replacement) return replacement;
  if (matched === matched.toUpperCase()) return replacement.toUpperCase();
  if (
    matched[0] === matched[0].toUpperCase() &&
    matched.slice(1) === matched.slice(1).toLowerCase()
  ) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
  }
  if (matched === matched.toLowerCase()) return replacement.toLowerCase();
  return replacement;
}

/**
 * 替换当前匹配项（由 currentMatchIndex 指定），返回新 content 和调整后的索引。
 * 替换后 content 长度变化，后续匹配位置需要重新计算（由调用方重新 findAll）。
 */
export function replaceCurrent(
  content: string,
  query: string,
  replacement: string,
  currentMatchIndex: number,
  caseSensitive = false,
  useRegex = false,
  wholeWord = false,
  preserveCase = false,
): { content: string; offsetDiff: number } {
  const matches = findAll(content, query, caseSensitive, useRegex, wholeWord);
  if (currentMatchIndex < 0 || currentMatchIndex >= matches.length) {
    return { content, offsetDiff: 0 };
  }

  const { start, end } = matches[currentMatchIndex];
  const matched = content.slice(start, end);
  const finalReplacement = preserveCase ? preserveCaseTransform(matched, replacement) : replacement;
  const diff = finalReplacement.length - (end - start);
  const newContent = content.slice(0, start) + finalReplacement + content.slice(end);
  return { content: newContent, offsetDiff: diff };
}

/**
 * 替换 content 中所有匹配 query 的子串，返回新 content 和替换次数。
 * @param caseSensitive  是否区分大小写
 * @param useRegex  是否正则模式
 * @param wholeWord  是否全字匹配
 * @param preserveCase  是否保留原始匹配的大小写样式
 */
export function replaceAll(
  content: string,
  query: string,
  replacement: string,
  caseSensitive = false,
  useRegex = false,
  wholeWord = false,
  preserveCase = false,
): { content: string; replacedCount: number } {
  if (!query) return { content, replacedCount: 0 };

  // 正则模式
  if (useRegex) {
    try {
      const flags = caseSensitive ? "g" : "gi";
      const regex = new RegExp(query, flags);
      let replacedCount = 0;
      const newContent = content.replace(regex, (match) => {
        if (
          wholeWord &&
          !isWordBoundary(content, regex.lastIndex - match.length, regex.lastIndex)
        ) {
          return match;
        }
        replacedCount++;
        return preserveCase ? preserveCaseTransform(match, replacement) : replacement;
      });
      if (replacedCount === 0) return { content, replacedCount: 0 };
      return { content: newContent, replacedCount };
    } catch {
      return { content, replacedCount: 0 };
    }
  }

  // 普通模式
  const matches = findAll(content, query, caseSensitive, false, wholeWord);
  if (matches.length === 0) return { content, replacedCount: 0 };

  const searchLen = (caseSensitive ? query : query.toLowerCase()).length;
  const parts: string[] = [];
  let lastEnd = 0;

  for (const { start } of matches) {
    const end = start + searchLen;
    parts.push(content.slice(lastEnd, start));
    const matched = content.slice(start, end);
    parts.push(preserveCase ? preserveCaseTransform(matched, replacement) : replacement);
    lastEnd = end;
  }
  parts.push(content.slice(lastEnd));

  return { content: parts.join(""), replacedCount: matches.length };
}
