import { lazy, Suspense, useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { useEditorStore } from "../../store/editorStore";
import EditorTabBar from "./EditorTabBar";
import Button from "../ui/Button";

const CodeMirrorHost = lazy(() => import("./CodeMirrorHost"));

// Docked next to the canvas (see CanvasWorkspaceView), mounted only while at least one file is
// open. The CodeMirror editor itself is loaded lazily so opening zero files costs nothing.
export default function EditorPanel() {
  const activePath = useEditorStore((s) => s.activePath);
  const activeTab = useEditorStore((s) => (s.activePath ? s.tabs[s.activePath] : undefined));
  const keepMine = useEditorStore((s) => s.keepMine);
  const reloadFile = useEditorStore((s) => s.reloadFile);
  const closeFile = useEditorStore((s) => s.closeFile);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isModW = (e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "w" || e.code === "KeyW");
      if (isModW) {
        e.preventDefault();
        e.stopPropagation();
        if (activePath) {
          closeFile(activePath);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [activePath, closeFile]);

  return (
    <div className="w-[440px] shrink-0 h-full flex flex-col bg-slate-950 border-l border-slate-800">
      <EditorTabBar />

      {activePath && activeTab?.externalChangePending && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-[11px] text-amber-300 shrink-0">
          <span className="flex items-center gap-1.5">
            <RotateCcw size={11} />
            This file changed on disk. You have unsaved edits.
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="ghost" size="sm" onClick={() => keepMine(activePath)} className="!py-0.5">
              Keep Mine
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void reloadFile(activePath)} className="!py-0.5">
              Reload
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {activePath ? (
          <Suspense
            fallback={
              <div className="h-full flex items-center justify-center text-xs text-slate-600 italic">
                Loading editor…
              </div>
            }
          >
            <CodeMirrorHost />
          </Suspense>
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-slate-600 italic">
            No file open
          </div>
        )}
      </div>
    </div>
  );
}
