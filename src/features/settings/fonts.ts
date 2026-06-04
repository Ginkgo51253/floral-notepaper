/** Fallback stacks from App.css @theme — used when applying a custom font_family. */
export const DEFAULT_FONT_BODY_FALLBACK =
  '"HarmonyOS Sans SC", -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

export const DEFAULT_FONT_DISPLAY_FALLBACK =
  '"HarmonyOS Sans SC", -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

function quoteFontFamily(name: string): string {
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function applyFontFamily(fontFamily: string): void {
  const root = document.documentElement;
  const trimmed = fontFamily.trim();

  if (!trimmed) {
    root.style.removeProperty("--font-body");
    root.style.removeProperty("--font-display");
    return;
  }

  const primary = quoteFontFamily(trimmed);
  root.style.setProperty("--font-body", `${primary}, ${DEFAULT_FONT_BODY_FALLBACK}`);
  root.style.setProperty("--font-display", `${primary}, ${DEFAULT_FONT_DISPLAY_FALLBACK}`);
}
