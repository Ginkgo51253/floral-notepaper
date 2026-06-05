import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exportMarkdownNote, importMarkdownNote } from "../features/importExport/api";
import { MarkdownPreview } from "../features/markdown/MarkdownPreview";
import {
  chooseNotesDirectory,
  getConfig,
  normalizeViewMode,
  saveConfig,
} from "../features/settings/api";
import type { AppConfig, ViewMode } from "../features/settings/types";
import { normalizeTileColor } from "../features/settings/tileColor";
import { BackgroundLayer } from "./BackgroundLayer";
import { SettingsPanel } from "./SettingsPanel";
import { SlidingButtonGroup } from "./SlidingButtonGroup";
import {
  createNote,
  createCategory,
  deleteCategory,
  deleteNote,
  getErrorMessage,
  getFileModifiedTime,
  getNote,
  listCategories,
  listNotes,
  moveNoteCategory,
  readExternalFile,
  renameCategory,
  saveExternalFile,
  updateNote,
} from "../features/notes/api";
import { cleanUnusedImages } from "../features/images/api";
import { useImagePaste } from "../features/images/useImagePaste";
import { useImageBaseDir } from "../features/images/useImageBaseDir";
import type { ExternalFile, Note, NoteMetadata } from "../features/notes/types";
import {
  countNoteChars,
  filterNotes,
  formatShortDate,
  formatTime,
  getDisplayTitle,
  groupNotesByCategory,
  metadataFromNote,
} from "../features/notes/noteUtils";
import type { CategoryGroup } from "../features/notes/noteUtils";
import {
  findAll,
  buildHighlightHTML,
  replaceCurrent,
  replaceAll,
} from "../features/editor/findReplace";
import type { Range } from "../features/editor/findReplace";
import {
  getNoteContextMenuItems,
  type NoteContextMenuAction,
} from "../features/notes/noteContextMenu";

// 跨笔记匹配：在 Range 基础上增加来源笔记信息
interface CrossNoteMatch extends Range {
  noteId: string;
  noteTitle: string;
}
import { openNotepadWindow, takeStartupFile, toggleTileWindow } from "../features/windows/api";
import {
  closeCurrentWindow,
  minimizeCurrentWindow,
  toggleMaximizeCurrentWindow,
  isCurrentWindowMaximized,
  startCurrentWindowDrag,
} from "../features/windows/controls";
import {
  TILE_WINDOW_CLOSED_EVENT,
  TILE_WINDOW_UNPINNED_EVENT,
  syncPinnedTileIds,
} from "../features/windows/tileWindowEvents";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

interface NoteMenuState {
  x: number;
  y: number;
  noteId: string;
}

interface CategoryMenuState {
  x: number;
  y: number;
  category: string;
}

type FormatAction =
  | "bold"
  | "italic"
  | "heading"
  | "hr"
  | "ul"
  | "ol"
  | "code"
  | "quote"
  | "inlineMath"
  | "blockMath";

function applyFormat(
  textarea: HTMLTextAreaElement,
  action: FormatAction,
  translate: TFunction,
  setContent: (v: string) => void,
  markDirty: () => void,
) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);

  const lineStart = before.lastIndexOf("\n") + 1;
  const currentLine = before.slice(lineStart);

  let result: string;
  let cursorStart: number;
  let cursorEnd: number;

  switch (action) {
    case "bold": {
      const fallback = translate("main.formatSample.boldText", { defaultValue: "粗体文本" });
      const wrapped = `**${selected || fallback}**`;
      result = before + wrapped + after;
      cursorStart = start + 2;
      cursorEnd = cursorStart + (selected || fallback).length;
      break;
    }
    case "italic": {
      const fallback = translate("main.formatSample.italicText", { defaultValue: "斜体文本" });
      const wrapped = `*${selected || fallback}*`;
      result = before + wrapped + after;
      cursorStart = start + 1;
      cursorEnd = cursorStart + (selected || fallback).length;
      break;
    }
    case "heading": {
      const prefix = currentLine.match(/^(#{1,5})\s/);
      if (prefix) {
        const newLevel = prefix[1].length < 5 ? "#".repeat(prefix[1].length + 1) : "#";
        const beforeLine = value.slice(0, lineStart);
        const afterPrefix = value.slice(lineStart + prefix[0].length);
        result = beforeLine + newLevel + " " + afterPrefix;
        const offset = newLevel.length + 1 - prefix[0].length;
        cursorStart = start + offset;
        cursorEnd = end + offset;
      } else if (currentLine.length > 0 && start === end) {
        result = value.slice(0, lineStart) + "## " + value.slice(lineStart);
        cursorStart = start + 3;
        cursorEnd = cursorStart;
      } else if (selected) {
        result = before + `## ${selected}` + after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + selected.length;
      } else {
        result =
          before +
          `## ${translate("main.formatSample.headingText", { defaultValue: "标题" })}` +
          after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + 2;
      }
      break;
    }
    case "hr": {
      const newlineBefore = before.endsWith("\n") || before === "" ? "" : "\n";
      const newlineAfter = after.startsWith("\n") || after === "" ? "" : "\n";
      result = before + `${newlineBefore}---${newlineAfter}` + after;
      cursorStart = cursorEnd = before.length + newlineBefore.length + 3;
      break;
    }
    case "ul": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l) => `- ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.listItem", { defaultValue: "列表项" });
        const item = `- ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 2;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "ol": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l, i) => `${i + 1}. ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.listItem", { defaultValue: "列表项" });
        const item = `1. ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 3;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "code": {
      if (selected.includes("\n")) {
        const wrapped = "```\n" + selected + "\n```";
        result = before + wrapped + after;
        cursorStart = start + 4;
        cursorEnd = cursorStart + selected.length;
      } else {
        const fallback = translate("main.formatSample.codeText", { defaultValue: "代码" });
        const wrapped = `\`${selected || fallback}\``;
        result = before + wrapped + after;
        cursorStart = start + 1;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "quote": {
      if (selected.includes("\n")) {
        const lines = selected
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
        result = before + lines + after;
        cursorStart = start;
        cursorEnd = start + lines.length;
      } else {
        const fallback = translate("main.formatSample.quoteText", { defaultValue: "引用文本" });
        const item = `> ${selected || fallback}`;
        result = before + item + after;
        cursorStart = start + 2;
        cursorEnd = cursorStart + (selected || fallback).length;
      }
      break;
    }
    case "inlineMath": {
      const wrapped = `$${selected || "E=mc^2"}$`;
      result = before + wrapped + after;
      cursorStart = start + 1;
      cursorEnd = cursorStart + (selected || "E=mc^2").length;
      break;
    }
    case "blockMath": {
      const wrapped = `\n$$\n${selected || "x^2 + y^2 = r^2"}\n$$\n`;
      result = before + wrapped + after;
      cursorStart = start + 4;
      cursorEnd = cursorStart + (selected || "x^2 + y^2 = r^2").length;
      break;
    }
  }

  textarea.focus();
  textarea.setSelectionRange(0, value.length);
  document.execCommand("insertText", false, result);
  setContent(result);
  markDirty();
  requestAnimationFrame(() => {
    textarea.setSelectionRange(cursorStart, cursorEnd);
  });
}

function runEditorCommand(textarea: HTMLTextAreaElement | null, command: "undo" | "redo"): boolean {
  if (!textarea || textarea.disabled) return false;
  textarea.focus();
  return document.execCommand(command);
}

/** 在 textarea 选区内 insertText，写入原生撤销栈。返回更新后的全文。 */
function applyTextareaRangeReplace(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
  replacement: string,
  focusEditor = true,
): string {
  if (focusEditor) textarea.focus();
  textarea.setSelectionRange(start, end);
  document.execCommand("insertText", false, replacement);
  return textarea.value;
}

/** 一次性替换 textarea 全文，单次撤销可恢复。返回更新后的全文。 */
function applyTextareaFullContent(textarea: HTMLTextAreaElement, newContent: string): string {
  textarea.focus();
  textarea.setSelectionRange(0, textarea.value.length);
  document.execCommand("insertText", false, newContent);
  return textarea.value;
}

interface ReplaceBatchConfirmState {
  scope: "category" | "all";
  noteCount: number;
  affectedNoteCount: number;
  matchCount: number;
  categoryName: string;
}

/** 侧栏搜索、标题等非编辑区输入框内不拦截 Ctrl+F / Ctrl+H */
function shouldSkipEditorShortcut(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("[data-editor-shortcut-skip]") !== null;
}

export function pinTileButtonTitle(isPinned: boolean): string {
  return isPinned ? "取消钉屏" : "钉到屏幕";
}

interface MainWindowProps {
  initialSettingsOpen?: boolean;
  initialConfig?: AppConfig;
  initialErrorMessage?: string | null;
}

export function MainWindow({
  initialSettingsOpen = false,
  initialConfig = undefined,
  initialErrorMessage = null,
}: MainWindowProps = {}) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [externalFiles, setExternalFiles] = useState<ExternalFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(
    normalizeViewMode(initialConfig?.defaultViewMode ?? "split"),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(initialErrorMessage);
  const [noteMenu, setNoteMenu] = useState<NoteMenuState | null>(null);
  const [noteMenuClosing, setNoteMenuClosing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const [settingsConfig, setSettingsConfig] = useState<AppConfig | null>(initialConfig ?? null);
  const [savedNotesDir, setSavedNotesDir] = useState<string | null>(
    initialConfig?.notesDir ?? null,
  );
  const [noteTransitionKey, setNoteTransitionKey] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteExiting, setDeleteExiting] = useState(false);
  const [pinnedTileIds, setPinnedTileIds] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<string[]>([]);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [showCategoryInput, setShowCategoryInput] = useState(false);
  const [categoryInputValue, setCategoryInputValue] = useState("");
  const [noteMenuMode, setNoteMenuMode] = useState<"main" | "move">("main");
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null);
  const [renameCategoryValue, setRenameCategoryValue] = useState("");
  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null);
  const [settingsOverlay, setSettingsOverlay] = useState(() => window.innerWidth < 1080);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const [gotoLineOpen, setGotoLineOpen] = useState(false);
  const [gotoLineValue, setGotoLineValue] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findSearched, setFindSearched] = useState(false);
  const [findMatches, setFindMatches] = useState<Range[]>([]);
  const [findCurrentIndex, setFindCurrentIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceQuery, setReplaceQuery] = useState("");
  const [replaceSearched, setReplaceSearched] = useState(false);
  const [replaceMatches, setReplaceMatches] = useState<Range[]>([]);
  const [replaceCurrentIndex, setReplaceCurrentIndex] = useState(0);
  const [replaceValue, setReplaceValue] = useState("");
  const [replaceCaseSensitive, setReplaceCaseSensitive] = useState(false);
  const [replaceUseRegex, setReplaceUseRegex] = useState(false);
  const [replaceWholeWord, setReplaceWholeWord] = useState(false);
  const [replacePreserveCase, setReplacePreserveCase] = useState(false);
  const [replaceScope, setReplaceScope] = useState<"current" | "category" | "all">("current");
  const [replaceFindCount, setReplaceFindCount] = useState<number | null>(null);
  const [replaceAllCount, setReplaceAllCount] = useState<number | null>(null);
  const [replaceCrossMatches, setReplaceCrossMatches] = useState<CrossNoteMatch[]>([]);
  const replaceCrossNoteContentsRef = useRef<
    Map<string, { title: string; content: string; category: string }>
  >(new Map());
  const replaceNavInProgressRef = useRef(false);
  const prevReplaceCategoryRef = useRef<string | null>(null);
  const [replaceBatchConfirm, setReplaceBatchConfirm] = useState<ReplaceBatchConfirmState | null>(
    null,
  );
  const replaceFindInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceOpenRef = useRef(false);
  const replaceApplyingRef = useRef(false);
  replaceOpenRef.current = replaceOpen;
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const [categoryMenu, setCategoryMenu] = useState<CategoryMenuState | null>(null);
  const [categoryMenuClosing, setCategoryMenuClosing] = useState(false);
  const [categoryMenuConfirmDelete, setCategoryMenuConfirmDelete] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const externalFileMtimeRef = useRef<number>(0);
  const lastExternalSaveRef = useRef<number>(0);
  const imageBaseDir = useImageBaseDir();
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedId) ?? null,
    [notes, selectedId],
  );
  const selectedNoteRef = useRef(selectedNote);
  selectedNoteRef.current = selectedNote;

  const selectedExternalFile = useMemo(
    () => externalFiles.find((f) => f.id === selectedId) ?? null,
    [externalFiles, selectedId],
  );

  const isExternal = selectedExternalFile !== null;

  const noteMenuTarget = useMemo(
    () => notes.find((note) => note.id === noteMenu?.noteId) ?? null,
    [noteMenu?.noteId, notes],
  );
  const noteContextMenuItems = useMemo(() => getNoteContextMenuItems(t), [t]);
  const saveStateLabel = useMemo<Record<SaveState, string>>(
    () => ({
      idle: t("main.statusBar.saveState.idle", { defaultValue: "未选择" }),
      dirty: t("main.statusBar.saveState.dirty", { defaultValue: "未保存" }),
      saving: t("main.statusBar.saveState.saving", { defaultValue: "保存中" }),
      saved: t("main.statusBar.saveState.saved", { defaultValue: "已保存" }),
      error: t("main.statusBar.saveState.error", { defaultValue: "保存失败" }),
    }),
    [t],
  );
  const toolbarButtons = useMemo<
    { label: string; title: string; style: string; action: FormatAction }[]
  >(
    () => [
      {
        label: "B",
        title: t("main.toolbar.bold", { defaultValue: "粗体" }),
        style: "font-bold",
        action: "bold",
      },
      {
        label: "I",
        title: t("main.toolbar.italic", { defaultValue: "斜体" }),
        style: "italic",
        action: "italic",
      },
      {
        label: "H",
        title: t("main.toolbar.heading", { defaultValue: "标题" }),
        style: "font-bold",
        action: "heading",
      },
      {
        label: "—",
        title: t("main.toolbar.hr", { defaultValue: "分割线" }),
        style: "",
        action: "hr",
      },
      {
        label: "•",
        title: t("main.toolbar.ul", { defaultValue: "无序列表" }),
        style: "",
        action: "ul",
      },
      {
        label: "1.",
        title: t("main.toolbar.ol", { defaultValue: "有序列表" }),
        style: "font-mono text-[9px]",
        action: "ol",
      },
      {
        label: "<>",
        title: t("main.toolbar.code", { defaultValue: "代码" }),
        style: "font-mono text-[9px]",
        action: "code",
      },
      {
        label: "❝",
        title: t("main.toolbar.quote", { defaultValue: "引用" }),
        style: "",
        action: "quote",
      },
      {
        label: "∑",
        title: t("main.toolbar.inlineMath", { defaultValue: "行内公式" }),
        style: "font-mono text-[11px]",
        action: "inlineMath",
      },
      {
        label: "∫",
        title: t("main.toolbar.blockMath", { defaultValue: "块级公式" }),
        style: "font-mono text-[11px]",
        action: "blockMath",
      },
    ],
    [t],
  );
  const viewModeOptions = useMemo(
    () => [
      {
        value: "edit" as ViewMode,
        label: t("settings.defaultView.edit", { defaultValue: "编辑" }),
      },
      {
        value: "split" as ViewMode,
        label: t("settings.defaultView.split", { defaultValue: "分栏" }),
      },
      {
        value: "preview" as ViewMode,
        label: t("settings.defaultView.preview", { defaultValue: "预览" }),
      },
    ],
    [t],
  );

  const filteredNotes = useMemo(() => filterNotes(notes, searchQuery), [notes, searchQuery]);

  const categoryGroups = useMemo(
    () => groupNotesByCategory(filteredNotes, categories),
    [filteredNotes, categories],
  );

  const lineCount = useMemo(() => content.split("\n").length, [content]);
  const byteSize = useMemo(
    () => (new TextEncoder().encode(content).length / 1024).toFixed(1),
    [content],
  );
  const charCount = useMemo(() => countNoteChars(content), [content]);
  const editorFontSize = settingsConfig?.fontSize ?? 14;
  const showLineNumbers = settingsConfig?.showLineNumbers ?? true;
  const wordWrap = settingsConfig?.wordWrap ?? true;

  // 视觉行测量：当自动换行开启时，每个逻辑行可能占多个视觉行
  const lineMeasureRef = useRef<HTMLDivElement>(null);
  const [visualLineCounts, setVisualLineCounts] = useState<number[]>([1]);

  const recalcVisualLines = useCallback(() => {
    if (!wordWrap) {
      setVisualLineCounts([]);
      return;
    }
    const textarea = contentRef.current;
    const measure = lineMeasureRef.current;
    if (!textarea || !measure) return;

    const logicalLines = content.split("\n");
    const taStyle = getComputedStyle(textarea);
    const pl = parseFloat(taStyle.paddingLeft) || 0;
    const pr = parseFloat(taStyle.paddingRight) || 0;
    const width = textarea.clientWidth - pl - pr;

    measure.style.width = `${width}px`;
    measure.style.font = taStyle.font;
    measure.style.lineHeight = taStyle.lineHeight;
    measure.style.letterSpacing = taStyle.letterSpacing;
    measure.style.wordSpacing = taStyle.wordSpacing;

    const lineH = editorFontSize * 1.9;
    const counts: number[] = [];
    for (const line of logicalLines) {
      measure.textContent = line || "\u200B"; // 零宽空格保证空行可测高
      counts.push(Math.max(1, Math.round(measure.offsetHeight / lineH)));
    }
    setVisualLineCounts((prev) =>
      prev.length === counts.length && prev.every((v, i) => v === counts[i]) ? prev : counts,
    );
  }, [content, wordWrap, editorFontSize]);

  // 内容或换行设置变化时重算视觉行
  useEffect(() => {
    recalcVisualLines();
  }, [recalcVisualLines]);

  // 窗口 resize 时重算
  useEffect(() => {
    if (!wordWrap) return;
    const textarea = contentRef.current;
    if (!textarea) return;
    // 使用容器元素来检测 resize
    const container = textarea.parentElement;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      recalcVisualLines();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [wordWrap, recalcVisualLines]);

  // 生成行号数组（换行开启时：每个逻辑行 i 重复 N 次）
  const lineNumberRows = useMemo(() => {
    if (!wordWrap || visualLineCounts.length === 0) {
      return Array.from({ length: content.split("\n").length }, (_, i) => i + 1);
    }
    const rows: number[] = [];
    visualLineCounts.forEach((count, i) => {
      for (let j = 0; j < count; j++) {
        rows.push(i + 1);
      }
    });
    return rows;
  }, [wordWrap, visualLineCounts, content]);

  const applyNote = useCallback((note: Note) => {
    setSelectedId(note.id);
    setTitle(note.title);
    setContent(note.content);
    setSaveState("saved");
    setErrorMessage(null);
    setNoteTransitionKey((k) => k + 1);
  }, []);

  const replaceNoteMetadata = useCallback((note: Note) => {
    const metadata = metadataFromNote(note);
    setNotes((current) => {
      const exists = current.some((item) => item.id === metadata.id);
      const next = exists
        ? current.map((item) => (item.id === metadata.id ? metadata : item))
        : [metadata, ...current];
      return [...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  }, []);

  const loadNote = useCallback(
    async (id: string) => {
      setErrorMessage(null);
      const note = await getNote(id);
      applyNote(note);
      replaceNoteMetadata(note);
    },
    [applyNote, replaceNoteMetadata],
  );

  const refreshNotes = useCallback(async () => {
    const [loadedNotes, loadedCategories] = await Promise.all([listNotes(), listCategories()]);
    setNotes(loadedNotes);
    setCategories(loadedCategories);
    return loadedNotes;
  }, []);

  const clearCurrentNote = useCallback(() => {
    setSelectedId(null);
    setTitle("");
    setContent("");
    setSaveState("idle");
  }, []);

  const loadExternalFile = useCallback(async (filePath: string) => {
    setErrorMessage(null);
    try {
      const [fileContent, mtime] = await Promise.all([
        readExternalFile(filePath),
        getFileModifiedTime(filePath),
      ]);
      const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
      const displayTitle = fileName.replace(/\.(md|txt)$/i, "");

      setExternalFiles((current) => {
        if (current.some((f) => f.id === filePath)) {
          return current;
        }
        return [
          ...current,
          {
            id: filePath,
            title: displayTitle,
            filePath,
          },
        ];
      });

      setSelectedId(filePath);
      setTitle(displayTitle);
      setContent(fileContent);
      setSaveState("saved");
      setNoteTransitionKey((k) => k + 1);
      externalFileMtimeRef.current = mtime;
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setIsLoading(true);
      try {
        const [loadedConfig, loadedNotes, loadedCategories] = await Promise.all([
          getConfig(),
          listNotes(),
          listCategories(),
        ]);
        if (cancelled) return;
        setSettingsConfig(loadedConfig);
        setSavedNotesDir(loadedConfig.notesDir);
        setViewMode(normalizeViewMode(loadedConfig.defaultViewMode));
        setNotes(loadedNotes);
        setCategories(loadedCategories);
        setCollapsedCategories(new Set(loadedCategories));
        if (loadedNotes[0]) {
          const note = await getNote(loadedNotes[0].id);
          if (!cancelled) applyNote(note);
        } else {
          clearCurrentNote();
        }

        if (!cancelled) {
          const startupFile = await takeStartupFile();
          if (!cancelled && startupFile) {
            await loadExternalFile(startupFile);
          }
        }
      } catch (error) {
        if (!cancelled) setErrorMessage(getErrorMessage(error));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyNote, clearCurrentNote]);

  useEffect(() => {
    const unlisten = listen("notes-changed", () => {
      void refreshNotes().then((loaded) => {
        const currentId = selectedIdRef.current;
        if (!currentId) return;
        const stillExists = loaded.some((n) => n.id === currentId);
        if (stillExists) {
          if (saveStateRef.current !== "dirty") {
            void getNote(currentId)
              .then((note) => {
                if (selectedIdRef.current !== currentId) return;
                setTitle(note.title);
                setContent(note.content);
                setSaveState("saved");
              })
              .catch(() => undefined);
          }
        } else if (selectedNoteRef.current) {
          if (loaded[0]) {
            void loadNote(loaded[0].id);
          } else {
            clearCurrentNote();
          }
        }
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes, loadNote, clearCurrentNote]);

  useEffect(() => {
    function handleFocus() {
      void refreshNotes();
    }
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshNotes]);

  useEffect(() => {
    const onResize = () => setSettingsOverlay(window.innerWidth < 1080);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("open-external-file", (event) => {
      void loadExternalFile(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [loadExternalFile]);

  useEffect(() => {
    const unlisten = listen<string>("open-note", (event) => {
      void loadNote(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [loadNote]);

  useEffect(() => {
    const unlisten = listen<string>("shortcut-register-failed", (event) => {
      setErrorMessage(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>(TILE_WINDOW_CLOSED_EVENT, (event) => {
      setPinnedTileIds((previous) => syncPinnedTileIds(previous, event.payload, false));
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>(TILE_WINDOW_UNPINNED_EVENT, (event) => {
      setPinnedTileIds((previous) => syncPinnedTileIds(previous, event.payload, false));
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!selectedExternalFile) return;

    const interval = window.setInterval(async () => {
      if (Date.now() - lastExternalSaveRef.current < 2000) return;
      try {
        const mtime = await getFileModifiedTime(selectedExternalFile.filePath);
        if (mtime !== externalFileMtimeRef.current) {
          externalFileMtimeRef.current = mtime;
          const fileContent = await readExternalFile(selectedExternalFile.filePath);
          setContent(fileContent);
          setSaveState("saved");
        }
      } catch {
        // file may have been deleted or become inaccessible
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [selectedExternalFile]);

  useEffect(() => {
    function closeMenus() {
      setNoteMenuClosing(true);
      setCategoryMenuClosing(true);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenus();
    }

    document.addEventListener("mousedown", closeMenus);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", closeMenus);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!noteMenuClosing || !noteMenu) return;
    const timer = window.setTimeout(() => {
      setNoteMenu(null);
      setNoteMenuClosing(false);
      setNoteMenuMode("main");
    }, 150);
    return () => window.clearTimeout(timer);
  }, [noteMenuClosing, noteMenu]);

  useEffect(() => {
    if (!categoryMenuClosing || !categoryMenu) return;
    const timer = window.setTimeout(() => {
      setCategoryMenu(null);
      setCategoryMenuClosing(false);
      setCategoryMenuConfirmDelete(false);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [categoryMenuClosing, categoryMenu]);

  const saveCurrentNote = useCallback(async () => {
    if (!selectedId) return null;

    if (isExternal && selectedExternalFile) {
      setSaveState("saving");
      try {
        await saveExternalFile(selectedExternalFile.filePath, content);
        lastExternalSaveRef.current = Date.now();
        const mtime = await getFileModifiedTime(selectedExternalFile.filePath);
        externalFileMtimeRef.current = mtime;
        setSaveState("saved");
        setErrorMessage(null);
        return { id: selectedId, title, content } as Note;
      } catch (error) {
        setSaveState("error");
        setErrorMessage(getErrorMessage(error));
        return null;
      }
    }

    setSaveState("saving");
    try {
      const category = selectedNote?.category ?? "";
      const note = await updateNote(selectedId, { title, content, category });
      replaceNoteMetadata(note);
      setSaveState("saved");
      setErrorMessage(null);
      return note;
    } catch (error) {
      setSaveState("error");
      setErrorMessage(getErrorMessage(error));
      return null;
    }
  }, [
    content,
    isExternal,
    replaceNoteMetadata,
    selectedExternalFile,
    selectedId,
    selectedNote,
    title,
  ]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        void saveCurrentNote();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [saveCurrentNote]);

  const handleGotoLineSubmit = useCallback(() => {
    const parsed = Number.parseInt(gotoLineValue, 10);
    const textarea = contentRef.current;
    if (!Number.isNaN(parsed) && textarea) {
      const lines = content.split("\n");
      const target = Math.min(Math.max(1, parsed), lines.length);
      let offset = 0;
      for (let i = 0; i < target - 1; i += 1) {
        offset += lines[i].length + 1;
      }
      textarea.focus();
      textarea.setSelectionRange(offset, offset);
      const lineHeight = editorFontSize * 1.9;
      textarea.scrollTop = Math.max(0, (target - 1) * lineHeight - textarea.clientHeight / 2);
      if (lineNumbersRef.current) {
        lineNumbersRef.current.scrollTop = textarea.scrollTop;
      }
    }
    setGotoLineOpen(false);
    setGotoLineValue("");
  }, [content, editorFontSize, gotoLineValue]);

  const focusReplacePanelInput = useCallback(() => {
    requestAnimationFrame(() => {
      replaceFindInputRef.current?.focus();
    });
  }, []);

  const scrollToMatch = useCallback(
    (textarea: HTMLTextAreaElement, matchStart: number) => {
      const lineHeight = editorFontSize * 1.9;
      const beforeText = textarea.value.substring(0, matchStart);
      const lineNum = beforeText.split("\n").length;
      textarea.scrollTop = Math.max(0, (lineNum - 1) * lineHeight - textarea.clientHeight / 2);
      if (lineNumbersRef.current) {
        lineNumbersRef.current.scrollTop = textarea.scrollTop;
      }
      if (highlightRef.current) {
        highlightRef.current.scrollTop = textarea.scrollTop;
      }
    },
    [editorFontSize],
  );

  const syncReplaceMatchesForNote = useCallback(
    (noteContent: string, query: string) => {
      const localMatches = findAll(
        noteContent,
        query,
        replaceCaseSensitive,
        replaceUseRegex,
        replaceWholeWord,
      );
      setReplaceMatches(localMatches);
      return localMatches;
    },
    [replaceCaseSensitive, replaceUseRegex, replaceWholeWord],
  );

  const handleFindChange = useCallback((value: string) => {
    setFindQuery(value);
    setFindSearched(false);
  }, []);

  const handleFindExecute = useCallback(
    (direction: "next" | "prev") => {
      const query = findQuery;
      if (!query) {
        setFindMatches([]);
        setFindCurrentIndex(-1);
        return;
      }
      const newMatches = findAll(content, query);
      setFindMatches(newMatches);
      setFindSearched(true);

      if (newMatches.length === 0) {
        setFindCurrentIndex(-1);
        return;
      }

      const textarea = contentRef.current;
      const cursorPos = textarea?.selectionStart ?? 0;

      let idx: number;
      if (direction === "next") {
        // 从光标位置向后找第一个匹配
        idx = newMatches.findIndex((m) => m.start >= cursorPos);
        if (idx === -1) idx = 0; // 无后面的，折回到第一个
      } else {
        // 从光标位置向前找第一个匹配
        idx = -1;
        for (let i = newMatches.length - 1; i >= 0; i--) {
          if (newMatches[i].end <= cursorPos) {
            idx = i;
            break;
          }
        }
        if (idx === -1) idx = newMatches.length - 1; // 无前面的，折回到最后一个
      }
      setFindCurrentIndex(idx);

      if (textarea) {
        const match = newMatches[idx];
        textarea.setSelectionRange(match.start, match.end);
        scrollToMatch(textarea, match.start);
      }
    },
    [content, findQuery, scrollToMatch],
  );

  const handleFindPrev = useCallback(() => {
    if (!findSearched) {
      handleFindExecute("prev");
      return;
    }
    const total = findMatches.length;
    if (total === 0) return;
    const idx = ((findCurrentIndex >= 0 ? findCurrentIndex : 0) - 1 + total) % total;
    setFindCurrentIndex(idx);
    const textarea = contentRef.current;
    if (textarea) {
      const match = findMatches[idx];
      textarea.setSelectionRange(match.start, match.end);
      scrollToMatch(textarea, match.start);
    }
  }, [findMatches, findCurrentIndex, scrollToMatch, findSearched, handleFindExecute]);

  const handleFindNext = useCallback(() => {
    if (!findSearched) {
      handleFindExecute("next");
      return;
    }
    const total = findMatches.length;
    if (total === 0) return;
    const idx = ((findCurrentIndex >= 0 ? findCurrentIndex : -1) + 1) % total;
    setFindCurrentIndex(idx);
    const textarea = contentRef.current;
    if (textarea) {
      const match = findMatches[idx];
      textarea.setSelectionRange(match.start, match.end);
      scrollToMatch(textarea, match.start);
    }
  }, [findMatches, findCurrentIndex, scrollToMatch, findSearched, handleFindExecute]);

  const handleFindClose = useCallback(() => {
    setFindOpen(false);
    setFindSearched(false);
    contentRef.current?.focus();
  }, []);

  const handleReplaceFindChange = useCallback((value: string) => {
    setReplaceQuery(value);
    setReplaceSearched(false);
    setReplaceMatches([]);
    setReplaceCrossMatches([]);
    setReplaceCurrentIndex(-1);
    setReplaceFindCount(null);
    setReplaceAllCount(null);
  }, []);

  // 导航到某个匹配（自动切换笔记）
  const navigateToMatchAt = useCallback(
    (idx: number, matches: Range[], crossAllMatches: CrossNoteMatch[]) => {
      const keepPanelFocus = replaceOpenRef.current;

      // 跨笔记模式：匹配在 crossAllMatches 中，需要处理笔记切换
      if (crossAllMatches.length > 0) {
        const cm = crossAllMatches[idx];
        if (!cm) return;
        const noteMap = replaceCrossNoteContentsRef.current;
        const noteData = noteMap.get(cm.noteId);
        if (cm.noteId !== selectedId && noteData) {
          // 展开目标笔记的分类
          setCollapsedCategories((prev) => {
            if (noteData.category && prev.has(noteData.category)) {
              const next = new Set(prev);
              next.delete(noteData.category);
              return next;
            }
            return prev;
          });
          // 切换到目标笔记
          setSelectedId(cm.noteId);
          setTitle(noteData.title);
          setContent(noteData.content);
          // 在下一个 tick 中滚动可见（替换面板打开时保持面板焦点）
          requestAnimationFrame(() => {
            const ta = contentRef.current;
            if (ta) {
              if (!keepPanelFocus) {
                ta.setSelectionRange(cm.start, cm.end);
              }
              scrollToMatch(ta, cm.start);
              if (keepPanelFocus) focusReplacePanelInput();
            }
          });
        } else {
          const ta = contentRef.current;
          if (ta) {
            if (!keepPanelFocus) {
              ta.setSelectionRange(cm.start, cm.end);
            }
            scrollToMatch(ta, cm.start);
            if (keepPanelFocus) focusReplacePanelInput();
          }
        }
        return;
      }

      // 当前笔记模式
      const match = matches[idx];
      if (!match) return;
      const ta = contentRef.current;
      if (ta) {
        if (!keepPanelFocus) {
          ta.setSelectionRange(match.start, match.end);
        }
        scrollToMatch(ta, match.start);
        if (keepPanelFocus) focusReplacePanelInput();
      }
    },
    [selectedId, scrollToMatch, setCollapsedCategories, focusReplacePanelInput],
  );

  // 跨笔记查找：按 scope 加载所有笔记并搜索
  const runCrossNoteSearch = useCallback(
    async (query: string): Promise<CrossNoteMatch[]> => {
      const noteMetas = await listNotes();
      const scope = replaceScope; // 闭包捕获
      const cat = selectedNote?.category ?? "";
      const filtered =
        scope === "all"
          ? noteMetas
          : scope === "category"
            ? noteMetas.filter((n) => n.category === cat)
            : [];

      const allMatches: CrossNoteMatch[] = [];
      const contentMap = new Map<string, { title: string; content: string; category: string }>();

      for (const meta of filtered) {
        try {
          const note = await getNote(meta.id);
          contentMap.set(meta.id, {
            title: note.title,
            content: note.content,
            category: meta.category,
          });
          const ranges = findAll(
            note.content,
            query,
            replaceCaseSensitive,
            replaceUseRegex,
            replaceWholeWord,
          );
          for (const r of ranges) {
            allMatches.push({ start: r.start, end: r.end, noteId: meta.id, noteTitle: meta.title });
          }
        } catch {
          // skip
        }
      }

      replaceCrossNoteContentsRef.current = contentMap;
      return allMatches;
    },
    [replaceScope, selectedNote, replaceCaseSensitive, replaceUseRegex, replaceWholeWord],
  );

  const handleReplaceFindExecute = useCallback(
    async (direction: "next" | "prev", queryOverride?: string) => {
      const query = queryOverride ?? replaceQuery;
      if (!query) {
        setReplaceMatches([]);
        setReplaceCurrentIndex(-1);
        setReplaceCrossMatches([]);
        return;
      }

      if (replaceScope !== "current") {
        // 跨笔记模式
        setReplaceSearched(true);
        setReplaceCrossMatches([]);
        replaceAllCount !== null && setReplaceAllCount(null);
        const crossMatches = await runCrossNoteSearch(query);
        setReplaceCrossMatches(crossMatches);
        setReplaceFindCount(crossMatches.length);
        prevReplaceCategoryRef.current = selectedNote?.category ?? "";

        if (crossMatches.length === 0) {
          setReplaceMatches([]);
          setReplaceCurrentIndex(-1);
          return;
        }

        const ta = contentRef.current;
        const cursorPos = ta?.selectionStart ?? 0;

        let idx: number;
        if (direction === "next") {
          // 找当前光标位置后的第一个匹配（跨笔记：先找当前笔记内的，再跨笔记）
          const currentNoteFirst = crossMatches.findIndex(
            (m) => m.noteId === selectedId && m.start >= cursorPos,
          );
          idx = currentNoteFirst !== -1 ? currentNoteFirst : 0;
        } else {
          idx = -1;
          for (let i = crossMatches.length - 1; i >= 0; i--) {
            if (crossMatches[i].noteId === selectedId && crossMatches[i].end <= cursorPos) {
              idx = i;
              break;
            }
          }
          if (idx === -1) idx = crossMatches.length - 1;
        }
        setReplaceCurrentIndex(idx);
        const cm = crossMatches[idx];
        const noteContent =
          cm.noteId === selectedId
            ? content
            : (replaceCrossNoteContentsRef.current.get(cm.noteId)?.content ?? "");
        syncReplaceMatchesForNote(noteContent, query);
        navigateToMatchAt(idx, [], crossMatches);
        if (replaceOpenRef.current) focusReplacePanelInput();
        return;
      }

      // 当前笔记模式（原有逻辑）
      const newMatches = findAll(
        content,
        query,
        replaceCaseSensitive,
        replaceUseRegex,
        replaceWholeWord,
      );
      setReplaceMatches(newMatches);
      setReplaceCrossMatches([]);
      setReplaceSearched(true);
      setReplaceFindCount(newMatches.length);
      replaceAllCount !== null && setReplaceAllCount(null);

      if (newMatches.length === 0) {
        setReplaceCurrentIndex(-1);
        return;
      }

      const textarea = contentRef.current;
      const cursorPos = textarea?.selectionStart ?? 0;

      let idx: number;
      if (direction === "next") {
        idx = newMatches.findIndex((m) => m.start >= cursorPos);
        if (idx === -1) idx = 0;
      } else {
        idx = -1;
        for (let i = newMatches.length - 1; i >= 0; i--) {
          if (newMatches[i].end <= cursorPos) {
            idx = i;
            break;
          }
        }
        if (idx === -1) idx = newMatches.length - 1;
      }
      setReplaceCurrentIndex(idx);

      if (textarea) {
        const match = newMatches[idx];
        if (!replaceOpenRef.current) {
          textarea.setSelectionRange(match.start, match.end);
        }
        scrollToMatch(textarea, match.start);
        if (replaceOpenRef.current) focusReplacePanelInput();
      }
    },
    [
      content,
      replaceQuery,
      replaceCaseSensitive,
      replaceUseRegex,
      replaceWholeWord,
      scrollToMatch,
      replaceScope,
      selectedId,
      navigateToMatchAt,
      runCrossNoteSearch,
      syncReplaceMatchesForNote,
      focusReplacePanelInput,
    ],
  );

  const handleReplaceFindPrev = useCallback(() => {
    if (!replaceSearched) {
      handleReplaceFindExecute("prev");
      return;
    }
    // 跨笔记模式
    if (replaceCrossMatches.length > 0) {
      const total = replaceCrossMatches.length;
      if (total === 0) return;
      const idx = ((replaceCurrentIndex >= 0 ? replaceCurrentIndex : 0) - 1 + total) % total;
      replaceNavInProgressRef.current = true;
      setReplaceCurrentIndex(idx);
      navigateToMatchAt(idx, [], replaceCrossMatches);
      return;
    }
    // 当前笔记模式
    const total = replaceMatches.length;
    if (total === 0) return;
    const idx = ((replaceCurrentIndex >= 0 ? replaceCurrentIndex : 0) - 1 + total) % total;
    setReplaceCurrentIndex(idx);
    navigateToMatchAt(idx, replaceMatches, []);
  }, [
    replaceMatches,
    replaceCrossMatches,
    replaceCurrentIndex,
    scrollToMatch,
    replaceSearched,
    handleReplaceFindExecute,
    navigateToMatchAt,
  ]);

  const handleReplaceFindNext = useCallback(() => {
    if (!replaceSearched) {
      handleReplaceFindExecute("next");
      return;
    }
    // 跨笔记模式
    if (replaceCrossMatches.length > 0) {
      const total = replaceCrossMatches.length;
      if (total === 0) return;
      const idx = ((replaceCurrentIndex >= 0 ? replaceCurrentIndex : -1) + 1) % total;
      replaceNavInProgressRef.current = true;
      setReplaceCurrentIndex(idx);
      navigateToMatchAt(idx, [], replaceCrossMatches);
      return;
    }
    // 当前笔记模式
    const total = replaceMatches.length;
    if (total === 0) return;
    const idx = ((replaceCurrentIndex >= 0 ? replaceCurrentIndex : -1) + 1) % total;
    setReplaceCurrentIndex(idx);
    navigateToMatchAt(idx, replaceMatches, []);
  }, [
    replaceMatches,
    replaceCrossMatches,
    replaceCurrentIndex,
    scrollToMatch,
    replaceSearched,
    handleReplaceFindExecute,
    navigateToMatchAt,
  ]);

  const handleReplaceClose = useCallback(() => {
    setReplaceOpen(false);
    setReplaceSearched(false);
    setReplaceFindCount(null);
    setReplaceAllCount(null);
    setReplaceBatchConfirm(null);
    if (highlightRef.current) highlightRef.current.innerHTML = "";
    contentRef.current?.focus();
  }, []);

  const handleReplaceCurrent = useCallback(() => {
    const textarea = contentRef.current;
    if (!textarea || !replaceQuery || !replaceSearched) return;

    const applyReplaceWithUndo = (
      start: number,
      end: number,
      replacement: string,
      newContent: string,
    ) => {
      replaceApplyingRef.current = true;
      applyTextareaRangeReplace(textarea, start, end, replacement, true);
      replaceApplyingRef.current = false;
      setContent(newContent);
      markDirty();
    };

    const advanceAfterReplace = (
      newLocalMatches: Range[],
      updatedCross: CrossNoteMatch[],
      prevIndex: number,
    ) => {
      setReplaceMatches(newLocalMatches);
      setReplaceCrossMatches(updatedCross);
      setReplaceSearched(true);
      setReplaceFindCount(updatedCross.length > 0 ? updatedCross.length : newLocalMatches.length);
      setReplaceAllCount(null);

      const activeList = updatedCross.length > 0 ? updatedCross : newLocalMatches;
      if (activeList.length === 0) {
        setReplaceCurrentIndex(-1);
        focusReplacePanelInput();
        return;
      }

      const nextIdx = prevIndex % activeList.length;
      setReplaceCurrentIndex(nextIdx);
      if (updatedCross.length > 0) {
        replaceNavInProgressRef.current = true;
        navigateToMatchAt(nextIdx, [], updatedCross);
      } else {
        scrollToMatch(textarea, newLocalMatches[nextIdx].start);
        focusReplacePanelInput();
      }
    };

    const findOpts = [replaceCaseSensitive, replaceUseRegex, replaceWholeWord] as const;

    // 跨笔记模式：需要在当前笔记中执行替换（导航后已是目标笔记）
    if (replaceCrossMatches.length > 0) {
      const cm = replaceCrossMatches[replaceCurrentIndex];
      if (!cm || cm.noteId !== selectedId || replaceCurrentIndex < 0) return;
      const localMatches = findAll(content, replaceQuery, ...findOpts);
      const localIdx = localMatches.findIndex((m) => m.start === cm.start && m.end === cm.end);
      if (localIdx < 0) return;

      const { start, end } = localMatches[localIdx];
      const { content: newContent, offsetDiff } = replaceCurrent(
        content,
        replaceQuery,
        replaceValue,
        localIdx,
        replaceCaseSensitive,
        replaceUseRegex,
        replaceWholeWord,
        replacePreserveCase,
      );
      const replacement = newContent.slice(start, start + (end - start) + offsetDiff);
      applyReplaceWithUndo(start, end, replacement, newContent);

      const noteMap = replaceCrossNoteContentsRef.current;
      const noteData = noteMap.get(selectedId);
      if (noteData) noteData.content = newContent;

      const newMatches = findAll(newContent, replaceQuery, ...findOpts);
      const updatedCross = replaceCrossMatches.filter((m) => m.noteId !== selectedId);
      for (const m of newMatches) {
        updatedCross.push({ ...m, noteId: selectedId, noteTitle: cm.noteTitle });
      }
      updatedCross.sort((a, b) => {
        if (a.noteId !== b.noteId) return a.noteId.localeCompare(b.noteId);
        return a.start - b.start;
      });

      advanceAfterReplace(newMatches, updatedCross, replaceCurrentIndex);
      return;
    }

    const localMatches = findAll(content, replaceQuery, ...findOpts);
    if (replaceCurrentIndex < 0 || replaceCurrentIndex >= localMatches.length) return;

    const { start, end } = localMatches[replaceCurrentIndex];
    const { content: newContent, offsetDiff } = replaceCurrent(
      content,
      replaceQuery,
      replaceValue,
      replaceCurrentIndex,
      replaceCaseSensitive,
      replaceUseRegex,
      replaceWholeWord,
      replacePreserveCase,
    );
    const replacement = newContent.slice(start, start + (end - start) + offsetDiff);
    applyReplaceWithUndo(start, end, replacement, newContent);

    const newMatches = findAll(newContent, replaceQuery, ...findOpts);
    advanceAfterReplace(newMatches, [], replaceCurrentIndex);
  }, [
    content,
    replaceQuery,
    replaceCurrentIndex,
    replaceMatches,
    replaceValue,
    replaceCaseSensitive,
    replaceUseRegex,
    replaceWholeWord,
    replacePreserveCase,
    replaceCrossMatches,
    replaceSearched,
    selectedId,
    scrollToMatch,
    navigateToMatchAt,
    focusReplacePanelInput,
  ]);

  const isReplaceCurrentDisabled =
    !replaceQuery ||
    !replaceSearched ||
    replaceCurrentIndex < 0 ||
    (replaceCrossMatches.length > 0
      ? (() => {
          const cm = replaceCrossMatches[replaceCurrentIndex];
          if (!cm || cm.noteId !== selectedId) return true;
          const localMatches = findAll(
            content,
            replaceQuery,
            replaceCaseSensitive,
            replaceUseRegex,
            replaceWholeWord,
          );
          return !localMatches.some((m) => m.start === cm.start && m.end === cm.end);
        })()
      : replaceCurrentIndex >=
        findAll(content, replaceQuery, replaceCaseSensitive, replaceUseRegex, replaceWholeWord)
          .length);

  const executeCrossNoteReplaceBatch = useCallback(async () => {
    if (!replaceQuery) return;

    const noteMetas = await listNotes();
    const cat = selectedNote?.category ?? "";
    const filtered =
      replaceScope === "all" ? noteMetas : noteMetas.filter((n) => n.category === cat);

    let totalReplaced = 0;
    let currentNoteContent: string | null = null;

    for (const meta of filtered) {
      try {
        const note = await getNote(meta.id);
        const { content: newContent, replacedCount } = replaceAll(
          note.content,
          replaceQuery,
          replaceValue,
          replaceCaseSensitive,
          replaceUseRegex,
          replaceWholeWord,
          replacePreserveCase,
        );
        if (replacedCount > 0) {
          await updateNote(meta.id, {
            title: note.title,
            content: newContent,
            category: note.category,
          });
          totalReplaced += replacedCount;
          if (meta.id === selectedId) {
            currentNoteContent = newContent;
          }
          const noteMap = replaceCrossNoteContentsRef.current;
          const cached = noteMap.get(meta.id);
          if (cached) cached.content = newContent;
        }
      } catch {
        // skip notes that fail
      }
    }

    if (totalReplaced > 0) {
      await emit("notes-changed");
    }

    if (currentNoteContent !== null) {
      const ta = contentRef.current;
      if (ta) {
        ta.value = currentNoteContent;
      }
      setContent(currentNoteContent);
      setSaveState("saved");
    }

    setReplaceMatches([]);
    setReplaceCrossMatches([]);
    setReplaceCurrentIndex(-1);
    setReplaceSearched(false);
    setReplaceFindCount(null);
    setReplaceAllCount(totalReplaced);
    setReplaceBatchConfirm(null);
  }, [
    replaceQuery,
    replaceValue,
    replaceCaseSensitive,
    replaceUseRegex,
    replaceWholeWord,
    replacePreserveCase,
    replaceScope,
    selectedNote?.category,
    selectedId,
  ]);

  const handleReplaceAll = useCallback(() => {
    if (!replaceQuery) return;

    if (replaceScope === "category" || replaceScope === "all") {
      const cat = selectedNote?.category ?? "";
      const categoryName = cat || t("main.category.uncategorized", { defaultValue: "未分类" });
      const noteCount =
        replaceScope === "all" ? notes.length : notes.filter((n) => n.category === cat).length;
      void (async () => {
        const crossMatches = await runCrossNoteSearch(replaceQuery);
        const affectedNoteCount = new Set(crossMatches.map((m) => m.noteId)).size;
        if (affectedNoteCount === 0) return;
        setReplaceBatchConfirm({
          scope: replaceScope,
          noteCount,
          affectedNoteCount,
          matchCount: crossMatches.length,
          categoryName,
        });
      })();
      return;
    }

    const textarea = contentRef.current;
    if (!textarea) return;

    const { content: newContent, replacedCount } = replaceAll(
      content,
      replaceQuery,
      replaceValue,
      replaceCaseSensitive,
      replaceUseRegex,
      replaceWholeWord,
      replacePreserveCase,
    );
    if (replacedCount === 0) return;

    replaceApplyingRef.current = true;
    const applied = applyTextareaFullContent(textarea, newContent);
    replaceApplyingRef.current = false;
    setContent(applied);
    markDirty();
    setReplaceMatches([]);
    setReplaceCrossMatches([]);
    setReplaceCurrentIndex(-1);
    setReplaceSearched(false);
    setReplaceFindCount(null);
    setReplaceAllCount(replacedCount);
  }, [
    content,
    replaceQuery,
    replaceValue,
    replaceCaseSensitive,
    replaceUseRegex,
    replaceWholeWord,
    replacePreserveCase,
    replaceScope,
    notes,
    selectedNote?.category,
    runCrossNoteSearch,
    t,
  ]);

  // 高亮渲染：查找面板或替换面板有搜索结果时渲染黄色高亮
  useEffect(() => {
    if (!highlightRef.current) return;
    const isFindActive = findOpen && findSearched;
    const isReplaceActive = replaceOpen && replaceSearched;
    if (isFindActive) {
      highlightRef.current.innerHTML = buildHighlightHTML(content, findMatches, findCurrentIndex);
    } else if (isReplaceActive) {
      const localMatches = findAll(
        content,
        replaceQuery,
        replaceCaseSensitive,
        replaceUseRegex,
        replaceWholeWord,
      );
      let effectiveIdx = replaceCurrentIndex;
      if (replaceCrossMatches.length > 0) {
        effectiveIdx = -1;
        if (replaceCurrentIndex >= 0) {
          const cm = replaceCrossMatches[replaceCurrentIndex];
          if (cm && cm.noteId === selectedId) {
            const localIdx = localMatches.findIndex(
              (m) => m.start === cm.start && m.end === cm.end,
            );
            if (localIdx !== -1) effectiveIdx = localIdx;
          }
        }
      } else if (effectiveIdx >= localMatches.length) {
        effectiveIdx = localMatches.length > 0 ? 0 : -1;
      }
      highlightRef.current.innerHTML = buildHighlightHTML(content, localMatches, effectiveIdx);
    } else {
      highlightRef.current.innerHTML = "";
    }
    if ((isFindActive || isReplaceActive) && contentRef.current) {
      highlightRef.current.scrollTop = contentRef.current.scrollTop;
    }
  }, [
    findOpen,
    findSearched,
    findMatches,
    findCurrentIndex,
    replaceOpen,
    replaceSearched,
    replaceQuery,
    replaceCaseSensitive,
    replaceUseRegex,
    replaceWholeWord,
    replaceCurrentIndex,
    replaceCrossMatches,
    content,
  ]);

  // 切换笔记时自动重新执行查找（两个面板独立处理）
  const prevFindNoteId = useRef<string | null>(null);
  const prevReplaceNoteId = useRef<string | null>(null);

  useEffect(() => {
    if (prevFindNoteId.current === selectedId) return;
    prevFindNoteId.current = selectedId;
    if (!findOpen || !findQuery || !selectedId) return;
    const newMatches = findAll(content, findQuery);
    setFindMatches(newMatches);
    setFindSearched(true);
    if (newMatches.length > 0) {
      setFindCurrentIndex(0);
      const textarea = contentRef.current;
      if (textarea) {
        textarea.setSelectionRange(newMatches[0].start, newMatches[0].end);
        scrollToMatch(textarea, newMatches[0].start);
      }
    } else {
      setFindCurrentIndex(-1);
    }
  }, [selectedId, findOpen, findQuery, content, scrollToMatch]);

  useEffect(() => {
    if (prevReplaceNoteId.current === selectedId) return;
    prevReplaceNoteId.current = selectedId;
    if (!replaceOpen || !replaceQuery || !selectedId) return;

    // 跨笔记导航触发的笔记切换：不覆盖索引和选区，仅更新高亮层
    if (replaceNavInProgressRef.current) {
      replaceNavInProgressRef.current = false;
      const newMatches = findAll(
        content,
        replaceQuery,
        replaceCaseSensitive,
        replaceUseRegex,
        replaceWholeWord,
      );
      setReplaceMatches(newMatches);
      return;
    }

    const currentCategory = selectedNote?.category ?? "";

    // "当前分类"模式下检测分类变化 → 重新执行跨笔记查找
    if (replaceScope === "category" && prevReplaceCategoryRef.current !== currentCategory) {
      prevReplaceCategoryRef.current = currentCategory;
      void (async () => {
        const crossMatches = await runCrossNoteSearch(replaceQuery);
        setReplaceCrossMatches(crossMatches);
        setReplaceFindCount(crossMatches.length);
        // 找当前笔记的第一个匹配
        const firstInNote = crossMatches.findIndex((m) => m.noteId === selectedId);
        if (firstInNote !== -1) {
          setReplaceCurrentIndex(firstInNote);
          const cm = crossMatches[firstInNote];
          const ta = contentRef.current;
          if (ta) {
            ta.setSelectionRange(cm.start, cm.end);
            scrollToMatch(ta, cm.start);
          }
        } else {
          setReplaceCurrentIndex(-1);
        }
        const newMatches = findAll(
          content,
          replaceQuery,
          replaceCaseSensitive,
          replaceUseRegex,
          replaceWholeWord,
        );
        setReplaceMatches(newMatches);
        setReplaceSearched(true);
      })();
      return;
    }

    // 跨笔记模式（已有 crossMatches）：手动切换笔记时找当前笔记的第一个匹配
    if (replaceCrossMatches.length > 0) {
      const firstInNote = replaceCrossMatches.findIndex((m) => m.noteId === selectedId);
      if (firstInNote !== -1) {
        setReplaceCurrentIndex(firstInNote);
        const cm = replaceCrossMatches[firstInNote];
        const ta = contentRef.current;
        if (ta) {
          ta.setSelectionRange(cm.start, cm.end);
          scrollToMatch(ta, cm.start);
        }
      }
      const newMatches = findAll(
        content,
        replaceQuery,
        replaceCaseSensitive,
        replaceUseRegex,
        replaceWholeWord,
      );
      setReplaceMatches(newMatches);
      return;
    }

    // 当前笔记模式
    const newMatches = findAll(
      content,
      replaceQuery,
      replaceCaseSensitive,
      replaceUseRegex,
      replaceWholeWord,
    );
    setReplaceMatches(newMatches);
    setReplaceSearched(true);
    if (newMatches.length > 0) {
      setReplaceCurrentIndex(0);
      const textarea = contentRef.current;
      if (textarea) {
        textarea.setSelectionRange(newMatches[0].start, newMatches[0].end);
        scrollToMatch(textarea, newMatches[0].start);
      }
    } else {
      setReplaceCurrentIndex(-1);
    }
  }, [
    selectedId,
    replaceOpen,
    replaceQuery,
    replaceCaseSensitive,
    replaceUseRegex,
    replaceWholeWord,
    replaceCrossMatches,
    content,
    scrollToMatch,
    replaceScope,
    selectedNote,
    runCrossNoteSearch,
  ]);

  // 选项 / 范围变更时自动重新搜索
  useEffect(() => {
    if (!replaceSearched || !replaceOpen || !replaceQuery) return;
    handleReplaceFindExecute("next");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaceScope, replaceCaseSensitive, replaceUseRegex, replaceWholeWord]);

  // 批量替换确认面板：Esc 关闭
  useEffect(() => {
    if (!replaceBatchConfirm) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setReplaceBatchConfirm(null);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [replaceBatchConfirm]);

  // 切换到 preview 模式时关闭所有面板
  useEffect(() => {
    if (viewMode === "preview") {
      if (findOpen) {
        setFindOpen(false);
        setFindSearched(false);
        if (highlightRef.current) highlightRef.current.innerHTML = "";
      }
      if (replaceOpen) {
        setReplaceOpen(false);
        setReplaceSearched(false);
        if (highlightRef.current) highlightRef.current.innerHTML = "";
      }
      setReplaceBatchConfirm(null);
    }
  }, [viewMode, findOpen, replaceOpen]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && (event.key === "g" || event.key === "G")) {
        event.preventDefault();
        if (!selectedId) return;
        setFindOpen(false);
        setReplaceOpen(false);
        setGotoLineOpen(true);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedId]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && (event.key === "f" || event.key === "F")) {
        if (shouldSkipEditorShortcut(event)) return;
        event.preventDefault();
        if (!selectedId) return;
        if (viewMode === "preview") return;
        if (findOpen) {
          // 有框选文本时更新查找
          const textarea = contentRef.current;
          if (textarea && textarea.selectionStart !== textarea.selectionEnd) {
            const selected = content.substring(textarea.selectionStart, textarea.selectionEnd);
            if (selected) {
              setFindQuery(selected);
              const newMatches = findAll(content, selected);
              setFindMatches(newMatches);
              setFindSearched(true);
              if (newMatches.length > 0) {
                const cursorPos = textarea.selectionStart;
                let idx = newMatches.findIndex((m) => m.start >= cursorPos);
                if (idx === -1) idx = 0;
                setFindCurrentIndex(idx);
                const match = newMatches[idx];
                textarea.setSelectionRange(match.start, match.end);
                scrollToMatch(textarea, match.start);
              } else {
                setFindCurrentIndex(-1);
              }
              return;
            }
          }
          findInputRef.current?.focus();
          findInputRef.current?.select();
        } else {
          setGotoLineOpen(false);
          setReplaceOpen(false);
          const textarea = contentRef.current;
          // 有框选文本时自动填入并搜索
          if (textarea && textarea.selectionStart !== textarea.selectionEnd) {
            const selected = content.substring(textarea.selectionStart, textarea.selectionEnd);
            if (selected) {
              setFindQuery(selected);
              setFindOpen(true);
              const newMatches = findAll(content, selected);
              setFindMatches(newMatches);
              setFindSearched(true);
              if (newMatches.length > 0) {
                const cursorPos = textarea.selectionStart;
                let idx = newMatches.findIndex((m) => m.start >= cursorPos);
                if (idx === -1) idx = 0;
                setFindCurrentIndex(idx);
                const match = newMatches[idx];
                requestAnimationFrame(() => {
                  textarea.focus();
                  textarea.setSelectionRange(match.start, match.end);
                  scrollToMatch(textarea, match.start);
                });
              } else {
                setFindCurrentIndex(-1);
              }
              return;
            }
          }
          // 无框选时仅打开面板
          setFindOpen(true);
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedId, viewMode, findOpen, content, scrollToMatch]);

  // Ctrl+H — 替换面板
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && (event.key === "h" || event.key === "H")) {
        if (shouldSkipEditorShortcut(event)) return;
        event.preventDefault();
        if (!selectedId) return;
        if (viewMode === "preview") return;
        const textarea = contentRef.current;
        const selected =
          textarea && textarea.selectionStart !== textarea.selectionEnd
            ? content.substring(textarea.selectionStart, textarea.selectionEnd)
            : "";
        if (replaceOpen) {
          if (selected) {
            setReplaceQuery(selected);
            void handleReplaceFindExecute("next", selected);
            return;
          }
          replaceFindInputRef.current?.focus();
          replaceFindInputRef.current?.select();
        } else {
          setGotoLineOpen(false);
          setFindOpen(false);
          setReplaceOpen(true);
          if (selected) {
            setReplaceQuery(selected);
            requestAnimationFrame(() => {
              void handleReplaceFindExecute("next", selected);
            });
          }
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedId, viewMode, replaceOpen, content, handleReplaceFindExecute]);

  useEffect(() => {
    if (!selectedId || saveState !== "dirty") return undefined;
    if (isExternal) {
      if (!settingsConfig?.externalFileAutoSave) return undefined;
    } else {
      if (!settingsConfig?.noteAutoSave) return undefined;
    }

    const timer = window.setTimeout(() => {
      void saveCurrentNote();
    }, 900);

    return () => window.clearTimeout(timer);
  }, [
    isExternal,
    saveCurrentNote,
    saveState,
    selectedId,
    settingsConfig?.noteAutoSave,
    settingsConfig?.externalFileAutoSave,
  ]);

  const handleNewNote = async () => {
    setErrorMessage(null);
    if (saveState === "dirty") {
      await saveCurrentNote();
    }
    try {
      const note = await createNote({ title: "", content: "", category: activeCategory });
      replaceNoteMetadata(note);
      applyNote(note);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleOpenSettings = async () => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    setSettingsOpen(true);
    if (settingsConfig) return;

    setErrorMessage(null);
    try {
      const config = await getConfig();
      setSettingsConfig(config);
      setSavedNotesDir(config.notesDir);
      setViewMode(normalizeViewMode(config.defaultViewMode));
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleChooseNotesDir = async () => {
    if (!settingsConfig) return;

    setErrorMessage(null);
    try {
      const notesDir = await chooseNotesDirectory();
      if (!notesDir) return;
      handleSettingsChange({ ...settingsConfig, notesDir });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistSettings = useCallback(
    (nextConfig: AppConfig) => {
      if (settingsSaveTimer.current) {
        clearTimeout(settingsSaveTimer.current);
      }
      settingsSaveTimer.current = setTimeout(async () => {
        const previousNotesDir = savedNotesDir ?? nextConfig.notesDir;
        const normalizedConfig = {
          ...nextConfig,
          defaultViewMode: normalizeViewMode(nextConfig.defaultViewMode),
          tileColor: normalizeTileColor(nextConfig.tileColor),
        };
        try {
          const savedConfig = await saveConfig(normalizedConfig);
          setSettingsConfig(savedConfig);
          setSavedNotesDir(savedConfig.notesDir);
          setViewMode(normalizeViewMode(savedConfig.defaultViewMode));

          if (savedConfig.notesDir !== previousNotesDir) {
            const loadedNotes = await refreshNotes();
            if (loadedNotes[0]) {
              await loadNote(loadedNotes[0].id);
            } else {
              clearCurrentNote();
            }
          }
        } catch (error) {
          setErrorMessage(getErrorMessage(error));
        }
      }, 300);
    },
    [savedNotesDir, refreshNotes, loadNote, clearCurrentNote],
  );

  const handleSettingsChange = useCallback(
    (nextConfig: AppConfig) => {
      setSettingsConfig(nextConfig);
      void emit("config-changed", nextConfig);
      persistSettings(nextConfig);
    },
    [persistSettings],
  );

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const handleImportNote = async () => {
    setErrorMessage(null);
    try {
      if (selectedId && saveState === "dirty") {
        const saved = await saveCurrentNote();
        if (!saved) return;
      }

      const note = await importMarkdownNote(activeCategory);
      if (!note) return;

      replaceNoteMetadata(note);
      applyNote(note);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleSelectNote = async (id: string) => {
    if (id === selectedId) return;
    setDeleteConfirm(false);
    if (saveState === "dirty") {
      await saveCurrentNote();
    }

    setIsLoading(true);
    try {
      await loadNote(id);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectExternalFile = async (id: string) => {
    if (id === selectedId) return;
    setDeleteConfirm(false);
    if (saveState === "dirty") {
      await saveCurrentNote();
    }

    const file = externalFiles.find((f) => f.id === id);
    if (!file) return;

    setIsLoading(true);
    try {
      const [fileContent, mtime] = await Promise.all([
        readExternalFile(file.filePath),
        getFileModifiedTime(file.filePath),
      ]);
      setSelectedId(id);
      setTitle(file.title);
      setContent(fileContent);
      setSaveState("saved");
      setErrorMessage(null);
      setNoteTransitionKey((k) => k + 1);
      externalFileMtimeRef.current = mtime;
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveExternalFile = async (id: string) => {
    if (selectedId === id && saveState === "dirty") {
      const shouldSave = window.confirm(
        t("main.confirm.unsavedExternalFile", {
          title: title || t("common.untitledFile", { defaultValue: "未命名文件" }),
          defaultValue: "「{{title}}」有未保存的更改，是否保存到原文件？",
        }),
      );
      if (shouldSave) {
        const saved = await saveCurrentNote();
        if (!saved) return;
      }
    }
    setExternalFiles((current) => current.filter((f) => f.id !== id));
    if (selectedId === id) {
      clearCurrentNote();
    }
  };

  const handleDeleteNote = async (noteId = selectedId) => {
    if (!noteId) return;

    setDeleteConfirm(false);
    setErrorMessage(null);
    try {
      await deleteNote(noteId);
      const remaining = await refreshNotes();
      if (noteId === selectedId && remaining[0]) {
        await loadNote(remaining[0].id);
      } else if (noteId === selectedId) {
        clearCurrentNote();
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleOpenNoteMenu = (event: MouseEvent<HTMLElement>, noteId: string) => {
    event.preventDefault();
    event.stopPropagation();

    const menuWidth = 168;
    const menuHeight = 76;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 4);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 4);

    setNoteMenuClosing(false);
    setHoveredId(noteId);
    setNoteMenu({
      x: Math.max(4, x),
      y: Math.max(4, y),
      noteId,
    });
  };

  const handleExportNote = async (note: NoteMetadata) => {
    setErrorMessage(null);
    try {
      if (note.id === selectedId && saveState === "dirty") {
        const saved = await saveCurrentNote();
        if (!saved) return;
      }

      await exportMarkdownNote({
        id: note.id,
        title: note.id === selectedId ? title : note.title,
      });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleNoteMenuAction = (action: NoteContextMenuAction) => {
    const note = noteMenuTarget;
    if (!note) return;

    if (action === "export") {
      setNoteMenuClosing(true);
      void handleExportNote(note);
      return;
    }

    if (action === "move") {
      setNoteMenuMode("move");
      return;
    }

    setNoteMenuClosing(true);
    void handleDeleteNote(note.id);
  };

  const handleMoveNote = async (noteId: string, targetCategory: string) => {
    setNoteMenuClosing(true);
    setErrorMessage(null);
    try {
      await moveNoteCategory(noteId, targetCategory);
      await refreshNotes();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleCreateCategory = async () => {
    const name = categoryInputValue.trim();
    if (!name) {
      setShowCategoryInput(false);
      return;
    }
    setErrorMessage(null);
    try {
      await createCategory(name);
      setCategories((prev) => [...prev, name].sort());
      setShowCategoryInput(false);
      setCategoryInputValue("");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleRenameCategory = async (oldName: string) => {
    const newName = renameCategoryValue.trim();
    if (!newName || newName === oldName) {
      setRenamingCategory(null);
      return;
    }
    setErrorMessage(null);
    try {
      await renameCategory(oldName, newName);
      await refreshNotes();
      setRenamingCategory(null);
      setRenameCategoryValue("");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleDeleteCategory = async (name: string) => {
    setErrorMessage(null);
    try {
      await deleteCategory(name);
      await refreshNotes();
      if (activeCategory === name) {
        setActiveCategory("");
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const toggleCategoryCollapse = (category: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const markDirty = () => {
    if (selectedId) setSaveState("dirty");
  };

  const ensureNoteSaved = useCallback(async (): Promise<string | null> => {
    if (selectedId) return selectedId;
    try {
      const note = await createNote({ title, content, category: activeCategory });
      replaceNoteMetadata(note);
      applyNote(note);
      return note.id;
    } catch {
      return null;
    }
  }, [selectedId, title, content, activeCategory, replaceNoteMetadata, applyNote]);

  const {
    handlePaste: imagePasteHandler,
    handleDrop: imageDropHandler,
    handleDragOver: imageDragOverHandler,
  } = useImagePaste({
    noteId: selectedId,
    textareaRef: contentRef,
    setContent,
    markDirty,
    onEnsureNoteSaved: ensureNoteSaved,
    disabled: isExternal,
    onError: setErrorMessage,
    t,
  });

  const handleCleanUnusedImages = async () => {
    if (!selectedId || isExternal) return;
    try {
      const removed = await cleanUnusedImages(selectedId, content);
      if (removed.length > 0) {
        setErrorMessage(
          t("main.images.cleaned", {
            count: removed.length,
            defaultValue: "已清理 {{count}} 张图片",
          }),
        );
      } else {
        setErrorMessage(t("main.images.cleanedNone", { defaultValue: "没有需要清理的图片" }));
      }
      setTimeout(() => setErrorMessage(null), 3000);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleUndo = () => {
    if (!selectedId) return;
    const textarea = contentRef.current;
    if (runEditorCommand(textarea, "undo")) {
      setContent(textarea?.value ?? content);
      markDirty();
    }
  };

  const handleRedo = () => {
    if (!selectedId) return;
    const textarea = contentRef.current;
    if (runEditorCommand(textarea, "redo")) {
      setContent(textarea?.value ?? content);
      markDirty();
    }
  };

  const handleOpenNotepad = async () => {
    setErrorMessage(null);
    try {
      await openNotepadWindow();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    void isCurrentWindowMaximized().then(setIsMaximized);
    const unlisten = getCurrentWindow().onResized(() => {
      void isCurrentWindowMaximized().then(setIsMaximized);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!isResizingSidebar) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (e: globalThis.MouseEvent) => {
      const newWidth = Math.min(Math.max(e.clientX, 180), 500);
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => setIsResizingSidebar(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingSidebar]);

  useEffect(() => {
    if (!isResizingSplit) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (e: globalThis.MouseEvent) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(Math.max(ratio, 0.2), 0.8));
    };
    const onMouseUp = () => setIsResizingSplit(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingSplit]);

  const handlePinEntry = async () => {
    if (!selectedId) return;
    const isPinned = pinnedTileIds.has(selectedId);
    if (!isPinned && saveState === "dirty") {
      await saveCurrentNote();
    }

    setErrorMessage(null);
    try {
      const pinned = await toggleTileWindow(selectedId);
      setPinnedTileIds((previous) => {
        return syncPinnedTileIds(previous, selectedId, pinned);
      });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const selectedTilePinned = selectedId ? pinnedTileIds.has(selectedId) : false;

  const handleTitleBarDrag = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    void startCurrentWindowDrag().catch(() => undefined);
  };

  const toggleMaximize = () => {
    void toggleMaximizeCurrentWindow().then(() => isCurrentWindowMaximized().then(setIsMaximized));
  };

  const handleTitleBarDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    toggleMaximize();
  };

  const handleMinimize = () => {
    void minimizeCurrentWindow();
  };

  const handleMaximize = () => {
    toggleMaximize();
  };

  const handleClose = () => {
    void closeCurrentWindow();
  };

  return (
    <div className="w-full h-screen flex flex-col">
      <div className="relative noise-bg bg-cloud overflow-hidden flex flex-col flex-1">
        <BackgroundLayer config={settingsConfig} />
        <div
          className="relative z-10 flex items-center justify-between pl-5 pr-0 h-11 bg-paper/55 backdrop-blur-[1px] border-b border-paper-deep/30 shrink-0 select-none cursor-default"
          onMouseDown={handleTitleBarDrag}
          onDoubleClick={handleTitleBarDoubleClick}
        >
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[13px] font-display font-medium text-ink-soft tracking-wide">
              花笺
            </span>
            <span className="text-[11px] text-ink-ghost font-body">—</span>
            <span className="text-[11px] text-ink-faint font-body truncate max-w-[240px]">
              {title ||
                selectedNote?.preview ||
                t("common.untitledNote", { defaultValue: "无标题笔记" })}
            </span>
          </div>
          <div className="flex items-center">
            {errorMessage && (
              <span className="max-w-[200px] truncate text-[11px] text-red-400 mr-2">
                {errorMessage}
              </span>
            )}
            <button
              onClick={() => void handleOpenNotepad()}
              className="w-10 h-11 flex items-center justify-center text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer"
              title={t("main.window.quickNotepad", { defaultValue: "快捷便签" })}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 4h16v14H7l-3 3V4z" />
                <path d="M8 9h8M8 13h5" />
              </svg>
            </button>
            <button
              onClick={() => void handleOpenSettings()}
              className="w-10 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer"
              title={t("main.window.settings", { defaultValue: "设置" })}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>

            <div className="w-px h-4 bg-paper-deep/30 mx-0.5" />

            <button
              onClick={handleMinimize}
              className="w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-all cursor-pointer"
              title={t("main.window.minimize", { defaultValue: "最小化" })}
            >
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="1" y="5.5" width="10" height="1" fill="currentColor" rx="0.5" />
              </svg>
            </button>
            <button
              onClick={handleMaximize}
              className="w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-all cursor-pointer"
              title={
                isMaximized
                  ? t("main.window.restore", { defaultValue: "还原" })
                  : t("main.window.maximize", { defaultValue: "最大化" })
              }
            >
              {isMaximized ? (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                >
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <path d="M3 5H2V2a1 1 0 0 1 1-1h5v1" />
                </svg>
              ) : (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                >
                  <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
                </svg>
              )}
            </button>
            <button
              onClick={handleClose}
              className="w-11 h-11 flex items-center justify-center text-ink-ghost hover:text-red-500 hover:bg-danger-bg transition-all cursor-pointer"
              title={t("main.window.close", { defaultValue: "关闭" })}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          </div>
        </div>

        <div className="relative z-10 flex flex-1 min-h-0">
          <div
            className="border-r border-paper-deep/30 bg-paper/40 shrink-0 overflow-hidden transition-[width] duration-[600ms]"
            style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
          >
            <div className="flex flex-col h-full" style={{ width: `${sidebarWidth}px` }}>
              <div className="px-3 pt-3 pb-2 shrink-0">
                <div className="flex items-center gap-2 px-2.5 h-8 rounded-lg bg-paper-warm/80 border border-paper-deep/40 focus-within:border-bamboo/30 focus-within:bg-cloud transition-all">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    className="text-ink-ghost shrink-0"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                  <input
                    type="text"
                    data-editor-shortcut-skip
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={t("main.sidebar.searchPlaceholder", { defaultValue: "搜索笔记…" })}
                    className="flex-1 text-[12px] font-body text-ink placeholder:text-ink-ghost/60 bg-transparent"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery("")}
                      className="text-ink-ghost hover:text-ink-faint transition-colors cursor-pointer"
                      title={t("main.sidebar.clearSearch", { defaultValue: "清空搜索" })}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                      >
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              <div className="px-3 pb-2 shrink-0 space-y-1">
                <button
                  onClick={handleNewNote}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-bamboo hover:bg-bamboo-mist/60 transition-all cursor-pointer group"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    className="group-hover:rotate-90 transition-transform duration-200"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  <span>{t("main.sidebar.newNote", { defaultValue: "新建笔记" })}</span>
                </button>
                <button
                  onClick={() => void handleImportNote()}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer group"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 3v12" />
                    <path d="m7 10 5 5 5-5" />
                    <path d="M5 21h14" />
                  </svg>
                  <span>{t("main.sidebar.importMarkdown", { defaultValue: "导入 Markdown" })}</span>
                </button>
              </div>

              <div className="flex items-center justify-between px-5 pb-1.5 shrink-0">
                <span className="text-[10px] text-ink-ghost font-mono tracking-wider uppercase">
                  {t("common.noteCount", {
                    count: filteredNotes.length,
                    defaultValue: "{{count}} 篇笔记",
                  })}
                  {externalFiles.length > 0
                    ? ` · ${t("common.externalFileCount", {
                        count: externalFiles.length,
                        defaultValue: "{{count}} 个外部文件",
                      })}`
                    : ""}
                </span>
                <button
                  onClick={() => setShowCategoryInput(true)}
                  className="text-[10px] text-ink-ghost hover:text-bamboo transition-colors cursor-pointer"
                  title={t("main.category.new", { defaultValue: "新建分类" })}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </div>

              {showCategoryInput && (
                <div className="px-3 pb-2 shrink-0">
                  <input
                    type="text"
                    autoFocus
                    value={categoryInputValue}
                    onChange={(e) => setCategoryInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleCreateCategory();
                      if (e.key === "Escape") {
                        setShowCategoryInput(false);
                        setCategoryInputValue("");
                      }
                    }}
                    onBlur={() => void handleCreateCategory()}
                    placeholder={t("main.category.placeholder", { defaultValue: "输入分类名…" })}
                    className="w-full px-2.5 h-7 rounded-lg text-[12px] font-body text-ink bg-paper-warm/80 border border-paper-deep/40 focus:border-bamboo/30 placeholder:text-ink-ghost/60"
                  />
                </div>
              )}

              <div className="flex-1 overflow-y-auto px-2 pb-2">
                <div className="space-y-0.5">
                  {externalFiles.length > 0 && (
                    <>
                      <div className="px-3 py-1.5 text-[10px] text-ink-ghost/50 font-mono tracking-wider uppercase">
                        {t("main.externalFiles.title", { defaultValue: "外部文件" })}
                      </div>
                      {externalFiles.map((file) => {
                        const isSelected = file.id === selectedId;
                        const isHovered = file.id === hoveredId;

                        return (
                          <button
                            key={file.id}
                            onClick={() => void handleSelectExternalFile(file.id)}
                            onMouseEnter={() => setHoveredId(file.id)}
                            onMouseLeave={() => setHoveredId(null)}
                            className={`w-full text-left rounded-xl px-3 py-2.5 transition-all duration-[600ms] cursor-pointer group relative ${
                              isSelected
                                ? "bg-bamboo-mist/70"
                                : isHovered
                                  ? "bg-paper-warm/70"
                                  : "bg-transparent"
                            }`}
                          >
                            <div
                              className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-bamboo/60 transition-all duration-[600ms] ${
                                isSelected ? "h-5 opacity-100" : "h-0 opacity-0"
                              }`}
                            />

                            <div className="flex items-baseline justify-between mb-0.5">
                              <span
                                className={`text-[13px] font-display font-medium truncate pr-2 transition-colors flex items-center gap-1.5 ${
                                  isSelected ? "text-bamboo" : "text-ink-soft"
                                }`}
                              >
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  className="shrink-0 opacity-60"
                                >
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                  <polyline points="14 2 14 8 20 8" />
                                </svg>
                                {file.title}
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveExternalFile(file.id);
                                }}
                                className="opacity-0 group-hover:opacity-100 text-ink-ghost hover:text-red-400 transition-all p-0.5"
                                title={t("main.externalFiles.remove", {
                                  defaultValue: "从列表移除",
                                })}
                              >
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                >
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                              </button>
                            </div>

                            <p className="text-[11px] text-ink-ghost leading-relaxed line-clamp-2 group-hover:text-ink-faint transition-colors pl-[18px]">
                              {file.filePath}
                            </p>
                          </button>
                        );
                      })}
                    </>
                  )}

                  {categoryGroups.map((group: CategoryGroup) => {
                    if (!group.category) {
                      return (
                        <div
                          key="__uncategorized__"
                          className={`rounded-lg transition-all duration-200 ${
                            dragOverCategory === "" ? "bg-bamboo/10 ring-1 ring-bamboo/20" : ""
                          }`}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            setDragOverCategory("");
                          }}
                          onDragLeave={(e) => {
                            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                              setDragOverCategory(null);
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            setDragOverCategory(null);
                            const noteId = e.dataTransfer.getData("text/plain");
                            if (noteId) void handleMoveNote(noteId, "");
                          }}
                        >
                          {group.notes.map((note) => {
                            const isSelected = note.id === selectedId;
                            const isHovered = note.id === hoveredId;
                            return (
                              <div
                                key={note.id}
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.setData("text/plain", note.id);
                                  e.dataTransfer.effectAllowed = "move";
                                }}
                                onClick={() => void handleSelectNote(note.id)}
                                onContextMenu={(event) => handleOpenNoteMenu(event, note.id)}
                                onMouseEnter={() => setHoveredId(note.id)}
                                onMouseLeave={() => setHoveredId(null)}
                                className={`w-full text-left rounded-xl px-3 py-2.5 transition-all duration-[600ms] cursor-pointer group relative ${
                                  isSelected
                                    ? "bg-bamboo-mist/70"
                                    : isHovered
                                      ? "bg-paper-warm/70"
                                      : "bg-transparent"
                                }`}
                              >
                                <div
                                  className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-bamboo/60 transition-all duration-[600ms] ${
                                    isSelected ? "h-5 opacity-100" : "h-0 opacity-0"
                                  }`}
                                />
                                <div className="flex items-baseline justify-between mb-0.5">
                                  <span
                                    className={`text-[13px] font-display font-medium truncate pr-2 transition-colors ${
                                      isSelected ? "text-bamboo" : "text-ink-soft"
                                    }`}
                                  >
                                    {getDisplayTitle(note, t)}
                                  </span>
                                  <span className="text-[10px] text-ink-ghost font-mono tabular-nums shrink-0">
                                    {formatShortDate(note.updatedAt)}
                                  </span>
                                </div>
                                <p className="text-[11px] text-ink-ghost leading-relaxed line-clamp-2 group-hover:text-ink-faint transition-colors">
                                  {note.preview ||
                                    t("common.blankNote", { defaultValue: "空白笔记" })}
                                </p>
                                <div className="flex items-center gap-2 mt-1">
                                  <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
                                    {formatTime(note.updatedAt)}
                                  </span>
                                  <span className="text-[10px] text-ink-ghost/40">·</span>
                                  <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
                                    {t("common.wordCount", {
                                      count: note.wordCount,
                                      defaultValue: "{{count}} 字",
                                    })}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    }

                    const isCollapsed = collapsedCategories.has(group.category);

                    return (
                      <div key={group.category} className="px-2 mb-0.5">
                        <div
                          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg group/cat cursor-pointer select-none transition-all duration-200 ${
                            dragOverCategory === group.category
                              ? "bg-bamboo/15 border border-bamboo/40 ring-1 ring-bamboo/20"
                              : isCollapsed
                                ? "bg-transparent border border-bamboo/15"
                                : "bg-bamboo/8 border border-bamboo/15 rounded-b-none"
                          }`}
                          onClick={() => toggleCategoryCollapse(group.category)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setCategoryMenu({
                              x: e.clientX,
                              y: e.clientY,
                              category: group.category,
                            });
                            setCategoryMenuClosing(false);
                            setCategoryMenuConfirmDelete(false);
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            setDragOverCategory(group.category);
                          }}
                          onDragLeave={() => setDragOverCategory(null)}
                          onDrop={(e) => {
                            e.preventDefault();
                            setDragOverCategory(null);
                            const noteId = e.dataTransfer.getData("text/plain");
                            if (noteId) void handleMoveNote(noteId, group.category);
                          }}
                        >
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={`text-bamboo/50 shrink-0 transition-transform duration-200 ${isCollapsed ? "" : "rotate-90"}`}
                          >
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="text-bamboo/50 shrink-0"
                          >
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                          {renamingCategory === group.category ? (
                            <input
                              type="text"
                              autoFocus
                              value={renameCategoryValue}
                              onChange={(e) => setRenameCategoryValue(e.target.value)}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") void handleRenameCategory(group.category);
                                if (e.key === "Escape") setRenamingCategory(null);
                              }}
                              onBlur={() => void handleRenameCategory(group.category)}
                              onClick={(e) => e.stopPropagation()}
                              className="flex-1 min-w-0 px-1 text-[10px] font-mono text-ink bg-paper-warm/80 border border-bamboo/30 rounded"
                            />
                          ) : (
                            <span className="text-[11px] text-bamboo/70 font-medium truncate">
                              {group.category}
                            </span>
                          )}
                          <span className="text-[9px] text-bamboo/40 font-mono ml-auto shrink-0">
                            {group.notes.length}
                          </span>
                        </div>

                        <div className={`category-body ${isCollapsed ? "" : "expanded"}`}>
                          <div
                            className="category-body-inner bg-bamboo/[0.03] border border-t-0 border-bamboo/10 rounded-b-lg pb-1 pt-1"
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                              setDragOverCategory(group.category);
                            }}
                            onDragLeave={(e) => {
                              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                setDragOverCategory(null);
                              }
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              setDragOverCategory(null);
                              const noteId = e.dataTransfer.getData("text/plain");
                              if (noteId) void handleMoveNote(noteId, group.category);
                            }}
                          >
                            {group.notes.length === 0 ? (
                              <div className="px-3 py-3 text-center text-[11px] text-ink-ghost/50">
                                {t("main.category.emptyFolder", { defaultValue: "空文件夹" })}
                              </div>
                            ) : (
                              group.notes.map((note) => {
                                const isSelected = note.id === selectedId;
                                const isHovered = note.id === hoveredId;

                                return (
                                  <div
                                    key={note.id}
                                    draggable
                                    onDragStart={(e) => {
                                      e.dataTransfer.setData("text/plain", note.id);
                                      e.dataTransfer.effectAllowed = "move";
                                    }}
                                    onClick={() => void handleSelectNote(note.id)}
                                    onContextMenu={(event) => handleOpenNoteMenu(event, note.id)}
                                    onMouseEnter={() => setHoveredId(note.id)}
                                    onMouseLeave={() => setHoveredId(null)}
                                    className={`w-full text-left rounded-lg mx-1 px-2.5 py-2 transition-all duration-[600ms] cursor-pointer group relative ${
                                      isSelected
                                        ? "bg-bamboo-mist/70"
                                        : isHovered
                                          ? "bg-paper-warm/70"
                                          : "bg-transparent"
                                    }`}
                                    style={{ width: "calc(100% - 8px)" }}
                                  >
                                    <div
                                      className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-bamboo/60 transition-all duration-[600ms] ${
                                        isSelected ? "h-5 opacity-100" : "h-0 opacity-0"
                                      }`}
                                    />

                                    <div className="flex items-baseline justify-between mb-0.5">
                                      <span
                                        className={`text-[13px] font-display font-medium truncate pr-2 transition-colors ${
                                          isSelected ? "text-bamboo" : "text-ink-soft"
                                        }`}
                                      >
                                        {getDisplayTitle(note, t)}
                                      </span>
                                      <span className="text-[10px] text-ink-ghost font-mono tabular-nums shrink-0">
                                        {formatShortDate(note.updatedAt)}
                                      </span>
                                    </div>

                                    <p className="text-[11px] text-ink-ghost leading-relaxed line-clamp-2 group-hover:text-ink-faint transition-colors">
                                      {note.preview ||
                                        t("common.blankNote", { defaultValue: "空白笔记" })}
                                    </p>

                                    <div className="flex items-center gap-2 mt-1">
                                      <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
                                        {formatTime(note.updatedAt)}
                                      </span>
                                      <span className="text-[10px] text-ink-ghost/40">·</span>
                                      <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
                                        {t("common.wordCount", {
                                          count: note.wordCount,
                                          defaultValue: "{{count}} 字",
                                        })}
                                      </span>
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {!isLoading && filteredNotes.length === 0 && externalFiles.length === 0 && (
                    <div className="px-3 py-8 text-center text-[12px] text-ink-ghost leading-relaxed">
                      {searchQuery
                        ? t("main.search.noResults", { defaultValue: "没有匹配的笔记" })
                        : t("main.search.empty", { defaultValue: "还没有笔记" })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {!sidebarCollapsed && (
            <div
              className={`w-1 shrink-0 cursor-col-resize group relative ${isResizingSidebar ? "bg-bamboo/30" : "hover:bg-bamboo/20"} transition-colors`}
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingSidebar(true);
              }}
            >
              <div
                className={`absolute inset-y-0 -left-1 -right-1 ${isResizingSidebar ? "" : "group-hover:bg-bamboo/5"}`}
              />
            </div>
          )}

          <div className="flex-1 flex flex-col min-w-0 relative">
            {gotoLineOpen && selectedId && (
              <div className="absolute top-12 right-4 z-40 flex items-center gap-2 h-9 pl-3 pr-1 rounded-lg bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 shadow-lg animate-menu-enter">
                <span className="text-[11px] font-body text-ink-faint whitespace-nowrap">
                  {t("main.gotoLine.label", { defaultValue: "跳转行" })}
                </span>
                <span className="w-px h-4 bg-paper-deep/30" />
                <input
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  value={gotoLineValue}
                  onChange={(event) => setGotoLineValue(event.target.value.replace(/\D/g, ""))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleGotoLineSubmit();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setGotoLineOpen(false);
                      setGotoLineValue("");
                    }
                  }}
                  placeholder={t("main.gotoLine.range", {
                    count: lineCount,
                    defaultValue: `1-${lineCount}`,
                  })}
                  className="w-16 text-[12px] font-mono text-ink bg-transparent tabular-nums placeholder:text-ink-ghost/50"
                />
                <span className="w-px h-4 bg-paper-deep/30" />
                <button
                  type="button"
                  onClick={() => {
                    setGotoLineOpen(false);
                    setGotoLineValue("");
                  }}
                  className="w-6 h-6 flex items-center justify-center rounded text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
                  title={t("common.close", { defaultValue: "关闭" })}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <path d="M2 2l8 8M10 2l-8 8" />
                  </svg>
                </button>
              </div>
            )}
            {findOpen && selectedId && (
              <div className="absolute top-12 right-4 z-40 flex items-center gap-2 h-9 pl-3 pr-1 rounded-lg bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 shadow-lg animate-menu-enter">
                <span className="text-[11px] font-body text-ink-faint whitespace-nowrap">
                  {t("main.find.label", { defaultValue: "查找" })}
                </span>
                <span className="w-px h-4 bg-paper-deep/30" />
                <input
                  ref={findInputRef}
                  type="text"
                  autoFocus
                  value={findQuery}
                  onChange={(event) => handleFindChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (event.shiftKey) {
                        handleFindPrev();
                      } else {
                        handleFindNext();
                      }
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      handleFindClose();
                    }
                  }}
                  placeholder=""
                  className="w-28 text-[12px] font-mono text-ink bg-transparent tabular-nums placeholder:text-ink-ghost/50"
                />
                <span className="w-px h-4 bg-paper-deep/30" />
                <span className="text-[11px] font-mono text-ink-ghost tabular-nums min-w-[28px] text-center">
                  {!findSearched
                    ? "—"
                    : findMatches.length > 0
                      ? `${findCurrentIndex + 1}/${findMatches.length}`
                      : "0/0"}
                </span>
                <button
                  type="button"
                  onClick={handleFindPrev}
                  disabled={findMatches.length === 0}
                  className="w-6 h-6 flex items-center justify-center rounded text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                  title={t("main.find.prev", { defaultValue: "上一个匹配" })}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <path d="M6 10V2M6 2L2 6M6 2l4 4" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={handleFindNext}
                  disabled={findMatches.length === 0}
                  className="w-6 h-6 flex items-center justify-center rounded text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                  title={t("main.find.next", { defaultValue: "下一个匹配" })}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <path d="M6 2v8M6 10l4-4M6 10l-4-4" />
                  </svg>
                </button>
                <span className="w-px h-4 bg-paper-deep/30" />
                <button
                  type="button"
                  onClick={handleFindClose}
                  className="w-6 h-6 flex items-center justify-center rounded text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
                  title={t("common.close", { defaultValue: "关闭" })}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <path d="M2 2l8 8M10 2l-8 8" />
                  </svg>
                </button>
              </div>
            )}
            {replaceOpen && selectedId && (
              <div className="absolute top-12 right-4 z-40 flex-col gap-1.5 py-2 px-3 rounded-lg bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 shadow-lg animate-menu-enter min-w-[420px]">
                {/* 第一行：查找（替换面板独立 state） */}
                <div className="flex items-center gap-2">
                  <span className="w-10 text-right shrink-0 text-[11px] font-body text-ink-faint">
                    {t("main.find.label", { defaultValue: "查找" })}
                  </span>
                  <input
                    ref={replaceFindInputRef}
                    type="text"
                    autoFocus
                    value={replaceQuery}
                    onChange={(event) => handleReplaceFindChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        if (event.shiftKey) {
                          handleReplaceFindPrev();
                        } else {
                          handleReplaceFindNext();
                        }
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        handleReplaceClose();
                      }
                    }}
                    placeholder=""
                    className="flex-1 min-w-[120px] h-7 px-2 text-[12px] font-mono text-ink bg-transparent border border-paper-deep/20 rounded-md focus:border-bamboo/40 outline-none"
                  />
                  <span className="w-px h-4 bg-paper-deep/30 shrink-0" />
                  <span className="text-[11px] font-mono text-ink-ghost tabular-nums min-w-[32px] text-center shrink-0">
                    {!replaceSearched
                      ? "—"
                      : replaceCrossMatches.length > 0
                        ? `${replaceCurrentIndex + 1}/${replaceCrossMatches.length}`
                        : replaceMatches.length > 0
                          ? `${replaceCurrentIndex + 1}/${replaceMatches.length}`
                          : "0/0"}
                  </span>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={handleReplaceFindPrev}
                    disabled={
                      (replaceCrossMatches.length === 0 && replaceMatches.length === 0) ||
                      !replaceSearched
                    }
                    className="w-6 h-6 flex items-center justify-center rounded text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default shrink-0"
                    title={t("main.find.prev", { defaultValue: "上一个匹配" })}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <path d="M6 10V2M6 2L2 6M6 2l4 4" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={handleReplaceFindNext}
                    disabled={
                      (replaceCrossMatches.length === 0 && replaceMatches.length === 0) ||
                      !replaceSearched
                    }
                    className="w-6 h-6 flex items-center justify-center rounded text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default shrink-0"
                    title={t("main.find.next", { defaultValue: "下一个匹配" })}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <path d="M6 2v8M6 10l4-4M6 10l-4-4" />
                    </svg>
                  </button>
                  <span className="w-px h-4 bg-paper-deep/30 shrink-0" />
                  <button
                    type="button"
                    onClick={handleReplaceClose}
                    className="w-6 h-6 flex items-center justify-center rounded text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer shrink-0"
                    title={t("common.close", { defaultValue: "关闭" })}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <path d="M2 2l8 8M10 2l-8 8" />
                    </svg>
                  </button>
                </div>
                {/* 第二行：替换 — 对齐设计 */}
                <div className="flex items-center gap-2">
                  <span className="w-10 text-right shrink-0 text-[11px] font-body text-ink-faint">
                    {t("main.replace.label", { defaultValue: "替换为" })}
                  </span>
                  <input
                    ref={replaceInputRef}
                    type="text"
                    value={replaceValue}
                    onChange={(event) => setReplaceValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleReplaceCurrent();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        handleReplaceClose();
                      }
                    }}
                    placeholder=""
                    className="flex-1 min-w-[120px] h-7 px-2 text-[12px] font-mono text-ink bg-transparent border border-paper-deep/20 rounded-md focus:border-bamboo/40 outline-none"
                  />
                  <span className="w-px h-4 bg-paper-deep/30 shrink-0" />
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleReplaceFindExecute("next")}
                      disabled={!replaceQuery}
                      className="px-2 h-6 text-[11px] font-mono rounded-md border border-paper-deep/30 text-ink-ghost hover:text-ink-soft hover:border-ink-ghost/30 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                    >
                      {t("main.find.label", { defaultValue: "查找" })}
                    </button>
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={handleReplaceCurrent}
                      disabled={isReplaceCurrentDisabled}
                      className="px-2 h-6 text-[11px] font-mono rounded-md border border-paper-deep/30 text-ink-ghost hover:text-ink-soft hover:border-ink-ghost/30 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                    >
                      {t("main.replace.btn", { defaultValue: "替换" })}
                    </button>
                    <button
                      type="button"
                      onClick={handleReplaceAll}
                      disabled={!replaceQuery}
                      className="px-2 h-6 text-[11px] font-mono rounded-md border border-paper-deep/30 text-ink-ghost hover:text-ink-soft hover:border-ink-ghost/30 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                    >
                      {t("main.replace.replaceAll", { defaultValue: "全部替换" })}
                    </button>
                  </div>
                </div>
                {/* 第三行：选项 + 范围 + 替换计数 */}
                <div className="flex items-center gap-2">
                  <span className="w-10 text-right shrink-0 text-[11px] font-body text-ink-faint">
                    {t("main.replace.options.label", { defaultValue: "选项" })}
                  </span>
                  <div className="flex gap-1.5 flex-1 items-center">
                    <button
                      type="button"
                      onClick={() => setReplaceCaseSensitive(!replaceCaseSensitive)}
                      className={`px-2 h-6 text-[11px] rounded-md border transition-colors cursor-pointer ${
                        replaceCaseSensitive
                          ? "bg-bamboo/15 text-bamboo border-bamboo/30"
                          : "bg-transparent text-ink-ghost border-paper-deep/30 hover:border-ink-ghost/30"
                      }`}
                      title={t("main.replace.options.caseSensitive", {
                        defaultValue: "匹配大小写",
                      })}
                    >
                      Aa
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplaceUseRegex(!replaceUseRegex)}
                      className={`px-2 h-6 text-[11px] rounded-md border transition-colors cursor-pointer ${
                        replaceUseRegex
                          ? "bg-bamboo/15 text-bamboo border-bamboo/30"
                          : "bg-transparent text-ink-ghost border-paper-deep/30 hover:border-ink-ghost/30"
                      }`}
                      title={t("main.replace.options.regex", { defaultValue: "使用正则表达式" })}
                    >
                      .*
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplaceWholeWord(!replaceWholeWord)}
                      className={`px-2 h-6 text-[11px] rounded-md border transition-colors cursor-pointer ${
                        replaceWholeWord
                          ? "bg-bamboo/15 text-bamboo border-bamboo/30"
                          : "bg-transparent text-ink-ghost border-paper-deep/30 hover:border-ink-ghost/30"
                      }`}
                      title={t("main.replace.options.wholeWord", { defaultValue: "全字匹配" })}
                    >
                      <span style={{ textDecoration: "underline" }}>ab</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplacePreserveCase(!replacePreserveCase)}
                      className={`px-2 h-6 text-[11px] rounded-md border transition-colors cursor-pointer ${
                        replacePreserveCase
                          ? "bg-bamboo/15 text-bamboo border-bamboo/30"
                          : "bg-transparent text-ink-ghost border-paper-deep/30 hover:border-ink-ghost/30"
                      }`}
                      title={t("main.replace.options.preserveCase", { defaultValue: "保留大小写" })}
                    >
                      AB
                    </button>
                    <span className="w-px h-4 bg-paper-deep/30 mx-1" />
                    <select
                      value={replaceScope}
                      onChange={(e) =>
                        setReplaceScope(e.target.value as "current" | "category" | "all")
                      }
                      className="px-2 h-6 text-[11px] font-mono rounded-md border border-paper-deep/30 bg-transparent text-ink-ghost hover:text-ink-soft hover:border-ink-ghost/30 transition-colors cursor-pointer outline-none"
                    >
                      <option value="current">
                        {t("main.replace.scope.current", { defaultValue: "当前笔记" })}
                      </option>
                      <option value="category">
                        {t("main.replace.scope.category", { defaultValue: "当前分类" })}
                      </option>
                      <option value="all">
                        {t("main.replace.scope.all", { defaultValue: "所有笔记" })}
                      </option>
                    </select>
                    <span className="text-[11px] font-mono text-bamboo tabular-nums ml-auto">
                      {replaceFindCount !== null && replaceSearched
                        ? `${t("main.replace.matchCount", { defaultValue: "匹配{{count}}处", count: replaceFindCount })}`
                        : replaceAllCount !== null
                          ? `${t("main.replace.replacedCount", { defaultValue: "成功替换{{count}}处", count: replaceAllCount })}`
                          : ""}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {replaceBatchConfirm && (
              <div className="absolute top-12 right-4 z-50 flex flex-col gap-2 py-3 px-4 rounded-lg bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 shadow-lg animate-menu-enter min-w-[380px] max-w-[420px]">
                <p className="text-[12px] font-body text-ink-soft leading-relaxed">
                  {replaceBatchConfirm.scope === "category"
                    ? t("main.replace.batchConfirm.category", {
                        defaultValue:
                          "即将修改 {{fileCount}} 份文件，共计 {{matchCount}} 个匹配项（「{{category}}」分类）。此操作无法通过 Ctrl+Z 撤回。",
                        category: replaceBatchConfirm.categoryName,
                        fileCount: replaceBatchConfirm.affectedNoteCount,
                        matchCount: replaceBatchConfirm.matchCount,
                      })
                    : t("main.replace.batchConfirm.all", {
                        defaultValue:
                          "即将修改 {{fileCount}} 份文件，共计 {{matchCount}} 个匹配项。此操作无法通过 Ctrl+Z 撤回。",
                        fileCount: replaceBatchConfirm.affectedNoteCount,
                        matchCount: replaceBatchConfirm.matchCount,
                      })}
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setReplaceBatchConfirm(null)}
                    className="px-3 h-7 text-[11px] font-mono rounded-md border border-paper-deep/30 text-ink-ghost hover:text-ink-soft hover:border-ink-ghost/30 transition-colors cursor-pointer"
                  >
                    {t("common.cancel", { defaultValue: "取消" })}
                  </button>
                  <button
                    type="button"
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void executeCrossNoteReplaceBatch();
                      }
                    }}
                    onClick={() => void executeCrossNoteReplaceBatch()}
                    className="px-3 h-7 text-[11px] font-mono rounded-md border border-bamboo/30 bg-bamboo/15 text-bamboo hover:bg-bamboo/25 transition-colors cursor-pointer"
                  >
                    {t("main.replace.batchConfirm.confirm", { defaultValue: "确认" })}
                  </button>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between px-4 h-10 border-b border-paper-deep/20 shrink-0 bg-paper/20">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer"
                  title={
                    sidebarCollapsed
                      ? t("main.window.expandSidebar", { defaultValue: "展开侧栏" })
                      : t("main.window.collapseSidebar", { defaultValue: "收起侧栏" })
                  }
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                </button>

                <div className="h-4 w-px bg-paper-deep/30 mx-1" />

                <button
                  onClick={() => void handlePinEntry()}
                  disabled={!selectedId}
                  aria-label={pinTileButtonTitle(selectedTilePinned)}
                  className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                    selectedTilePinned
                      ? "text-bamboo bg-bamboo-mist/40 hover:text-red-400 hover:bg-danger-bg"
                      : "text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50"
                  }`}
                  title={pinTileButtonTitle(selectedTilePinned)}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 17v5" />
                    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z" />
                  </svg>
                </button>

                <button
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleUndo}
                  disabled={!selectedId}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t("main.editor.undo", { defaultValue: "撤销（Ctrl+Z）" })}
                  aria-label={t("main.editor.undoLabel", { defaultValue: "撤销" })}
                >
                  <svg
                    data-testid="main-editor-undo-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M9 14 4 9l5-5" />
                    <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
                  </svg>
                </button>

                <button
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleRedo}
                  disabled={!selectedId}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t("main.editor.redo", { defaultValue: "重做（Ctrl+Y）" })}
                  aria-label={t("main.editor.redoLabel", { defaultValue: "重做" })}
                >
                  <svg
                    data-testid="main-editor-redo-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    style={{ transform: "scaleX(-1)" }}
                  >
                    <path d="M9 14 4 9l5-5" />
                    <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
                  </svg>
                </button>

                <button
                  onClick={() => void saveCurrentNote()}
                  disabled={!selectedId || saveState === "saving"}
                  className="px-2.5 h-7 flex items-center justify-center rounded-lg text-[11px] text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t("common.save", { defaultValue: "保存" })}
                >
                  {t("common.save", { defaultValue: "保存" })}
                </button>

                {deleteConfirm ? (
                  <div
                    className={`flex items-center gap-1 ml-1 ${deleteExiting ? "animate-delete-confirm-exit" : "animate-delete-confirm"}`}
                  >
                    <span className="text-[11px] text-red-400 whitespace-nowrap">
                      {t("main.editor.confirmDelete", { defaultValue: "确认删除？" })}
                    </span>
                    <button
                      onClick={() => {
                        setDeleteExiting(true);
                        setTimeout(() => {
                          setDeleteExiting(false);
                          setDeleteConfirm(false);
                          void handleDeleteNote();
                        }, 150);
                      }}
                      className="px-2 h-6 rounded-md text-[11px] text-cloud bg-red-400 hover:bg-red-500 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {t("common.delete", { defaultValue: "删除" })}
                    </button>
                    <button
                      onClick={() => {
                        setDeleteExiting(true);
                        setTimeout(() => {
                          setDeleteExiting(false);
                          setDeleteConfirm(false);
                        }, 150);
                      }}
                      className="px-2 h-6 rounded-md text-[11px] text-ink-faint hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
                    >
                      {t("common.cancel", { defaultValue: "取消" })}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteConfirm(true)}
                    disabled={!selectedId}
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-red-400 hover:bg-danger-bg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    title={t("noteMenu.delete", { defaultValue: "删除笔记" })}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="3,6 5,6 21,6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                )}
              </div>

              <SlidingButtonGroup
                options={viewModeOptions}
                value={viewMode}
                onChange={setViewMode}
                buttonClassName="px-3 py-1"
              />
            </div>

            <div
              key={noteTransitionKey}
              className="animate-note-enter px-6 pt-4 pb-2 shrink-0 border-b border-paper-deep/15"
            >
              <input
                type="text"
                data-editor-shortcut-skip
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  markDirty();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    contentRef.current?.focus();
                  }
                }}
                placeholder={t("common.untitledNote", { defaultValue: "无标题笔记" })}
                disabled={!selectedId}
                className="w-full text-[20px] font-display font-bold text-ink placeholder:text-ink-ghost/50 tracking-wide disabled:opacity-60"
              />
              <div className="flex items-center gap-3 mt-1.5">
                <span className="text-[10px] text-ink-ghost font-mono tabular-nums truncate max-w-[200px]">
                  {selectedExternalFile
                    ? t("main.externalFile.label", {
                        path: selectedExternalFile.filePath,
                        defaultValue: "外部文件 · {{path}}",
                      })
                    : selectedNote
                      ? `${formatShortDate(selectedNote.updatedAt)} ${formatTime(selectedNote.updatedAt)}`
                      : "--"}
                </span>
                <span className="text-[10px] text-ink-ghost/40">·</span>
                <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
                  {t("common.wordCount", { count: charCount, defaultValue: "{{count}} 字" })}
                </span>
                <span className="text-[10px] text-ink-ghost/40">·</span>
                <span
                  key={saveState}
                  className={`text-[10px] font-mono tabular-nums animate-status-fade ${
                    saveState === "error"
                      ? "text-red-400"
                      : saveState === "dirty"
                        ? "text-amber-500/70"
                        : "text-bamboo/60"
                  }`}
                >
                  {saveStateLabel[saveState]}
                </span>
              </div>
            </div>

            <div
              key={viewMode}
              ref={splitContainerRef}
              className="flex-1 flex min-h-0 animate-view-fade"
            >
              {!selectedId && !isLoading ? (
                <div className="flex-1 flex items-center justify-center text-[13px] text-ink-ghost">
                  {t("main.editor.emptyHint", { defaultValue: "选择或新建一篇笔记" })}
                </div>
              ) : (
                <>
                  {(viewMode === "edit" || viewMode === "split") && (
                    <div
                      className="flex flex-col min-h-0 shrink-0"
                      style={{ width: viewMode === "split" ? `${splitRatio * 100}%` : "100%" }}
                    >
                      <div className="flex items-center gap-0.5 px-4 pt-2 pb-1 shrink-0">
                        {toolbarButtons.map((button) => (
                          <button
                            key={button.label}
                            title={button.title}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              if (contentRef.current) {
                                applyFormat(
                                  contentRef.current,
                                  button.action,
                                  t,
                                  setContent,
                                  markDirty,
                                );
                              }
                            }}
                            className={`w-6 h-6 flex items-center justify-center rounded text-[11px] text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer ${button.style}`}
                          >
                            {button.label}
                          </button>
                        ))}
                      </div>

                      <div className="flex-1 overflow-hidden px-5 pb-4 flex">
                        {showLineNumbers && (
                          <div
                            ref={lineNumbersRef}
                            aria-hidden="true"
                            data-testid="editor-line-numbers"
                            className="shrink-0 h-full overflow-hidden text-right pr-3 mr-3 border-r border-paper-deep/30 text-ink-ghost/50 font-mono tabular-nums select-none"
                            style={{ fontSize: `${editorFontSize}px` }}
                          >
                            {lineNumberRows.map((num, index, arr) => {
                              const isFirst = index === 0 || num !== arr[index - 1];
                              return (
                                <div
                                  key={index}
                                  style={{ lineHeight: 1.9 }}
                                  className={isFirst ? "" : "opacity-40"}
                                >
                                  {num}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <div className="flex-1 relative min-w-0 self-stretch">
                          {/* 视觉行测量元素（隐藏）：与 textarea 同宽/同字体，用于测量换行 */}
                          <div
                            ref={lineMeasureRef}
                            aria-hidden="true"
                            className="absolute invisible pointer-events-none top-0 left-0"
                            style={{
                              fontSize: `${editorFontSize}px`,
                              fontFamily: "inherit",
                              lineHeight: "1.9",
                              tabSize: "var(--tab-indent-size, 2)",
                              whiteSpace: "pre-wrap",
                              wordWrap: "break-word",
                              overflowWrap: "break-word",
                            }}
                          />
                          <div
                            ref={highlightRef}
                            className="find-highlight-layer absolute inset-0 leading-[1.9] font-body"
                            style={{
                              fontSize: `${editorFontSize}px`,
                              tabSize: "var(--tab-indent-size, 2)",
                              whiteSpace: wordWrap ? "pre-wrap" : "pre",
                              wordWrap: wordWrap ? "break-word" : "normal",
                              overflow: "hidden",
                            }}
                          />
                          <textarea
                            ref={contentRef}
                            data-tab-indent="true"
                            value={content}
                            wrap={wordWrap ? "soft" : "off"}
                            onChange={(event) => {
                              setContent(event.target.value);
                              markDirty();
                              if (replaceApplyingRef.current) return;
                              if (findOpen) {
                                setFindOpen(false);
                                setFindSearched(false);
                                if (highlightRef.current) highlightRef.current.innerHTML = "";
                              }
                              if (replaceOpen) {
                                setReplaceOpen(false);
                                setReplaceSearched(false);
                                if (highlightRef.current) highlightRef.current.innerHTML = "";
                              }
                            }}
                            onScroll={(event) => {
                              const ta = event.currentTarget;
                              if (lineNumbersRef.current) {
                                lineNumbersRef.current.scrollTop = ta.scrollTop;
                              }
                              if (highlightRef.current) {
                                highlightRef.current.scrollTop = ta.scrollTop;
                                if (!wordWrap) {
                                  highlightRef.current.scrollLeft = ta.scrollLeft;
                                }
                              }
                            }}
                            onPaste={imagePasteHandler}
                            onDrop={imageDropHandler}
                            onDragOver={imageDragOverHandler}
                            className="relative w-full h-full leading-[1.9] text-ink-soft font-body placeholder:text-ink-ghost/40 bg-transparent"
                            style={{
                              fontSize: `${editorFontSize}px`,
                              tabSize: `var(--tab-indent-size, 2)`,
                              whiteSpace: wordWrap ? "pre-wrap" : "pre",
                              overflowWrap: wordWrap ? "break-word" : "normal",
                            }}
                            placeholder={t("main.editor.contentPlaceholder", {
                              defaultValue: "开始写作……",
                            })}
                            spellCheck={false}
                            disabled={!selectedId}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {viewMode === "split" && (
                    <div
                      className={`w-1.5 shrink-0 cursor-col-resize group relative flex items-center justify-center ${isResizingSplit ? "bg-bamboo/30" : "hover:bg-bamboo/20"} transition-colors`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setIsResizingSplit(true);
                      }}
                    >
                      <div
                        className={`absolute inset-y-0 -left-1.5 -right-1.5 ${isResizingSplit ? "" : "group-hover:bg-bamboo/5"}`}
                      />
                      {/* 拖拽手柄指示器 */}
                      <div className="relative z-10 flex flex-col gap-[3px] opacity-30 group-hover:opacity-100 transition-opacity">
                        <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                        <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                        <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                      </div>
                    </div>
                  )}

                  {(viewMode === "preview" || viewMode === "split") && (
                    <div className="flex flex-col min-h-0 min-w-0 flex-1">
                      {viewMode === "split" && (
                        <div className="px-4 pt-2.5 pb-1 shrink-0">
                          <span className="text-[10px] text-ink-ghost/60 font-mono tracking-widest uppercase">
                            {t("main.editor.previewLabel", { defaultValue: "Preview" })}
                          </span>
                        </div>
                      )}
                      <div
                        className={`flex-1 overflow-y-auto px-6 pb-6 ${
                          viewMode === "preview" ? "pt-3" : "pt-1"
                        }`}
                      >
                        <MarkdownPreview
                          content={content}
                          fontSize={settingsConfig?.fontSize ?? 14}
                          renderHtml={settingsConfig?.renderHtmlMarkdown ?? false}
                          imageBaseDir={imageBaseDir ?? undefined}
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-between px-4 h-7 border-t border-paper-deep/20 bg-paper/30 shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
                  {t("main.statusBar.lineNumber", {
                    count: lineCount,
                    defaultValue: "Ln {{count}}",
                  })}
                </span>
                <span className="text-[10px] text-ink-ghost/40">|</span>
                <span className="text-[10px] text-ink-ghost font-mono">
                  {t("main.statusBar.format", { defaultValue: "Markdown + LaTeX" })}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {selectedId && !isExternal && content.includes("images/") && (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleCleanUnusedImages()}
                      className="text-[10px] text-ink-ghost hover:text-bamboo font-mono cursor-pointer transition-colors"
                    >
                      {t("main.images.cleanUnused", { defaultValue: "清理未使用图片" })}
                    </button>
                    <span className="text-[10px] text-ink-ghost/40">|</span>
                  </>
                )}
                <span className="text-[10px] text-ink-ghost font-mono">
                  {t("main.statusBar.encoding", { defaultValue: "UTF-8" })}
                </span>
                <span className="text-[10px] text-ink-ghost/40">|</span>
                <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
                  {t("main.statusBar.byteSize", { size: byteSize, defaultValue: "{{size}} KB" })}
                </span>
              </div>
            </div>
          </div>
          {settingsConfig && settingsOpen && settingsOverlay && (
            <div className="absolute inset-0 z-20" onClick={handleCloseSettings} />
          )}
          {settingsConfig && (
            <div
              className={`transition-all duration-[600ms] overflow-hidden h-full ${
                settingsOverlay
                  ? `absolute right-0 top-0 bottom-0 z-30 ${settingsOpen ? "w-[360px] shadow-xl" : "w-0"}`
                  : `relative shrink-0 ${settingsOpen ? "w-[360px]" : "w-0"}`
              }`}
            >
              <div className="w-[360px] h-full">
                <SettingsPanel
                  config={settingsConfig}
                  onChange={handleSettingsChange}
                  onChooseNotesDir={() => void handleChooseNotesDir()}
                  onClose={handleCloseSettings}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      {noteMenu && noteMenuTarget && (
        <div
          className={`fixed z-[9999] min-w-[168px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg overflow-hidden select-none ${noteMenuClosing ? "animate-menu-exit" : "animate-menu-enter"}`}
          style={{ left: noteMenu.x, top: noteMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {noteMenuMode === "main" ? (
            <div key="main" className="animate-menu-slide-right">
              {noteContextMenuItems.map((item, index) => (
                <button
                  key={item.action}
                  onClick={() => handleNoteMenuAction(item.action)}
                  className={`w-full flex items-center justify-between px-3 py-1.5 text-[12px] font-body transition-colors cursor-pointer ${
                    item.tone === "danger"
                      ? "text-red-400 hover:bg-danger-bg hover:text-red-500"
                      : "text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo"
                  } ${index > 0 ? "border-t border-paper-deep/20" : ""}`}
                >
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <div key="move" className="animate-menu-slide-left">
              <button
                onClick={() => setNoteMenuMode("main")}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-body text-ink-ghost hover:bg-paper-warm transition-colors cursor-pointer border-b border-paper-deep/20"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                <span>{t("common.back", { defaultValue: "返回" })}</span>
              </button>
              <button
                onClick={() => void handleMoveNote(noteMenuTarget.id, "")}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.category.uncategorized", { defaultValue: "未分类" })}
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => void handleMoveNote(noteMenuTarget.id, cat)}
                  className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
                >
                  {cat}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {categoryMenu && (
        <div
          className={`fixed z-[9999] min-w-[140px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg overflow-hidden select-none ${categoryMenuClosing ? "animate-menu-exit" : "animate-menu-enter"}`}
          style={{ left: categoryMenu.x, top: categoryMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {categoryMenuConfirmDelete ? (
            <div className="animate-menu-slide-left">
              <div className="px-3 py-1.5 text-[11px] font-body text-ink-faint border-b border-paper-deep/20">
                {t("main.category.confirmDelete", {
                  category: categoryMenu.category,
                  defaultValue: "确认删除「{{category}}」？",
                })}
              </div>
              <button
                onClick={() => {
                  void handleDeleteCategory(categoryMenu.category);
                  setCategoryMenuClosing(true);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer"
              >
                {t("main.category.confirmDeleteAction", { defaultValue: "确认删除" })}
              </button>
              <button
                onClick={() => setCategoryMenuConfirmDelete(false)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("common.cancel", { defaultValue: "取消" })}
              </button>
            </div>
          ) : (
            <div className="animate-menu-slide-right">
              <button
                onClick={() => {
                  setCategoryMenuClosing(true);
                  setRenamingCategory(categoryMenu.category);
                  setRenameCategoryValue(categoryMenu.category);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {t("main.category.rename", { defaultValue: "重命名" })}
              </button>
              <button
                onClick={() => setCategoryMenuConfirmDelete(true)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer border-t border-paper-deep/20"
              >
                {t("main.category.delete", { defaultValue: "删除分类" })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
