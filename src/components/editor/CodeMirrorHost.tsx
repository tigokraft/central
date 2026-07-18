// Sole entry point for CodeMirror in the app: every "codemirror"/"@codemirror/*"/"@lezer/*"
// import lives in this one module, which EditorPanel only ever reaches via React.lazy(). That
// keeps the whole editor (~a few hundred KB) out of the initial bundle and in its own chunk.
import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { unifiedMergeView } from "@codemirror/merge";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { cn } from "../../lib/cn";
import { useEditorStore } from "../../store/editorStore";
import { getFileAtHead } from "../../lib/gitStatus";

// Colors lifted straight from src/index.css's @theme block (slate-950/emerald palette) —
// duplicated as hex literals here because CodeMirror's theme/highlight APIs take plain style
// objects, not CSS custom properties.
const theme = EditorView.theme(
  {
    "&": { backgroundColor: "#0a0a0a", color: "#d4d4d4", height: "100%", fontSize: "12px" },
    ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "#3fbf87", padding: "8px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#3fbf87" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(63, 191, 135, 0.25)",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.03)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255, 255, 255, 0.03)" },
    ".cm-gutters": {
      backgroundColor: "#0a0a0a",
      color: "#525252",
      border: "none",
      borderRight: "1px solid #262626",
    },
    ".cm-lineNumbers .cm-gutterElement": { color: "#404040" },
    ".cm-matchingBracket": {
      backgroundColor: "rgba(63, 191, 135, 0.2)",
      outline: "1px solid rgba(63, 191, 135, 0.4)",
    },
    ".cm-panels": { backgroundColor: "#171717", color: "#d4d4d4" },
    ".cm-tooltip": {
      backgroundColor: "#171717",
      border: "1px solid #262626",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-changedLine": { backgroundColor: "rgba(63, 169, 217, 0.08)" },
    ".cm-changedText": { backgroundColor: "rgba(63, 169, 217, 0.25)" },
    ".cm-deletedChunk": { backgroundColor: "rgba(229, 72, 77, 0.1)" },
  },
  { dark: true }
);

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#3fbf87" },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "#d4d4d4" },
  { tag: [t.function(t.variableName), t.labelName], color: "#7fd9ab" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#3fbf87" },
  { tag: [t.definition(t.name), t.separator], color: "#e5e5e5" },
  {
    tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace],
    color: "#3fa9d9",
  },
  {
    tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)],
    color: "#a3a3a3",
  },
  { tag: [t.meta, t.comment], color: "#737373", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "#3fa9d9", textDecoration: "underline" },
  { tag: t.heading, fontWeight: "bold", color: "#e5e5e5" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#e5484d" },
  { tag: [t.processingInstruction, t.string, t.inserted], color: "#d4d4d4" },
  { tag: t.invalid, color: "#e5484d" },
]);

function languageExtension(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "py":
      return python();
    case "rs":
      return rust();
    case "json":
      return json();
    case "md":
    case "markdown":
      return markdown();
    case "html":
    case "htm":
      return html();
    case "css":
      return css();
    default:
      return [];
  }
}

function baseExtensions(path: string): Extension[] {
  return [
    basicSetup,
    theme,
    syntaxHighlighting(highlightStyle),
    languageExtension(path),
    EditorView.lineWrapping,
    // Highest precedence so it wins over basicSetup's own keymaps for the same binding.
    Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            void useEditorStore.getState().saveFile(path);
            return true;
          },
        },
      ])
    ),
    keymap.of([indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        useEditorStore.getState().updateContent(path, update.state.doc.toString());
      }
    }),
  ];
}

// Diff-vs-HEAD content is fetched on demand (only once a tab's diff toggle is switched on) and
// cached per path for the lifetime of this component, so flipping the toggle back and forth
// doesn't re-fetch from disk/git every time.
export default function CodeMirrorHost() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const plainStatesRef = useRef<Map<string, EditorState>>(new Map());
  const plainVersionsRef = useRef<Map<string, number>>(new Map());
  const headContentCacheRef = useRef<Map<string, string | null>>(new Map());
  const [headContentReady, setHeadContentReady] = useState(0);

  const projectId = useEditorStore((s) => s.projectId);
  const activePath = useEditorStore((s) => s.activePath);
  const activeTab = useEditorStore((s) => (s.activePath ? s.tabs[s.activePath] : undefined));

  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({ doc: "", extensions: [theme] }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Fetch (and cache) the HEAD version of the active file whenever diff mode is switched on for
  // a path that isn't cached yet.
  useEffect(() => {
    if (!projectId || !activePath || !activeTab?.diffMode) return;
    if (headContentCacheRef.current.has(activePath)) return;
    let cancelled = false;
    void getFileAtHead(projectId, activePath)
      .then((content) => {
        if (cancelled) return;
        headContentCacheRef.current.set(activePath, content);
        setHeadContentReady((n) => n + 1);
      })
      .catch((err) => {
        console.error(`Failed to load HEAD content for "${activePath}":`, err);
        if (!cancelled) {
          headContentCacheRef.current.set(activePath, null);
          setHeadContentReady((n) => n + 1);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, activePath, activeTab?.diffMode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !activePath || !activeTab || activeTab.loading || activeTab.error) return;

    if (activeTab.diffMode) {
      const headContent = headContentCacheRef.current.get(activePath);
      if (headContent === undefined) return; // still fetching
      const state = EditorState.create({
        doc: activeTab.content,
        extensions: [
          ...baseExtensions(activePath),
          unifiedMergeView({
            original: headContent ?? "",
            mergeControls: false,
            gutter: true,
          }),
        ],
      });
      view.setState(state);
      view.focus();
      return;
    }

    const cachedVersion = plainVersionsRef.current.get(activePath);
    let state = plainStatesRef.current.get(activePath);
    if (!state || cachedVersion !== activeTab.reloadVersion) {
      state = EditorState.create({ doc: activeTab.content, extensions: baseExtensions(activePath) });
      plainStatesRef.current.set(activePath, state);
      plainVersionsRef.current.set(activePath, activeTab.reloadVersion);
    }
    view.setState(state);
    view.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activePath,
    activeTab?.reloadVersion,
    activeTab?.loading,
    activeTab?.error,
    activeTab?.diffMode,
    headContentReady,
  ]);

  return (
    <div className="h-full w-full relative">
      {activeTab?.loading && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-600 italic">
          Loading…
        </div>
      )}
      {activeTab?.error && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400 p-4 text-center">
          {activeTab.error}
        </div>
      )}
      {activeTab?.diffMode && headContentCacheRef.current.get(activePath ?? "") === undefined && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-600 italic">
          Loading diff…
        </div>
      )}
      <div
        ref={containerRef}
        className={cn("h-full w-full overflow-hidden", (activeTab?.loading || activeTab?.error) && "invisible")}
      />
    </div>
  );
}
