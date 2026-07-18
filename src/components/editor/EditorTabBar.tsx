import { useState } from "react";
import { GitCompare, PanelRightClose, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { useEditorStore } from "../../store/editorStore";
import { useGitStatusStore, statusFor, GIT_STATUS_DOT_CLASS } from "../../store/gitStatusStore";
import IconButton from "../ui/IconButton";
import Modal from "../ui/Modal";
import Button from "../ui/Button";

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

// Tab strip for open files, plus the diff-vs-HEAD toggle for whichever tab is active. Lives
// outside the CodeMirror lazy chunk (no "codemirror"/"@codemirror/*" imports here) so it renders
// instantly while the editor itself is still loading.
export default function EditorTabBar() {
  const order = useEditorStore((s) => s.order);
  const tabs = useEditorStore((s) => s.tabs);
  const activePath = useEditorStore((s) => s.activePath);
  const setActivePath = useEditorStore((s) => s.setActivePath);
  const closeFile = useEditorStore((s) => s.closeFile);
  const closeAll = useEditorStore((s) => s.closeAll);
  const saveFile = useEditorStore((s) => s.saveFile);
  const saveAllDirty = useEditorStore((s) => s.saveAllDirty);
  const toggleDiff = useEditorStore((s) => s.toggleDiff);
  const byPath = useGitStatusStore((s) => s.byPath);

  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [closeAllRequested, setCloseAllRequested] = useState(false);

  const requestClose = (path: string) => {
    if (tabs[path]?.dirty) {
      setCloseTarget(path);
    } else {
      closeFile(path);
    }
  };

  const dirtyCount = order.filter((path) => tabs[path]?.dirty).length;

  const requestCloseAll = () => {
    if (dirtyCount > 0) {
      setCloseAllRequested(true);
    } else {
      closeAll();
    }
  };

  const activeTab = activePath ? tabs[activePath] : undefined;

  if (order.length === 0) return null;

  return (
    <div className="flex items-center border-b border-slate-800 bg-slate-950 shrink-0">
      <div className="flex-1 flex items-center overflow-x-auto">
        {order.map((path) => {
          const tab = tabs[path];
          if (!tab) return null;
          const status = statusFor(byPath, path, false);
          const isActive = path === activePath;
          return (
            <div
              key={path}
              onClick={() => setActivePath(path)}
              title={path}
              className={cn(
                "group flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] border-r border-slate-800 cursor-pointer select-none shrink-0 max-w-[180px]",
                isActive
                  ? "bg-slate-900 text-slate-100"
                  : "text-slate-400 hover:bg-slate-900/60 hover:text-slate-200"
              )}
            >
              {status && (
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", GIT_STATUS_DOT_CLASS[status])} />
              )}
              <span className="truncate">{fileName(path)}</span>
              {tab.dirty && <span className="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose(path);
                }}
                className="shrink-0 text-slate-600 hover:text-slate-200 opacity-0 group-hover:opacity-100 cursor-pointer"
                title="Close"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-0.5 px-1 shrink-0 border-l border-slate-800">
        {activePath && activeTab && !activeTab.loading && !activeTab.error && (
          <IconButton
            title="Toggle diff vs HEAD"
            variant={activeTab.diffMode ? "active" : "default"}
            onClick={() => toggleDiff(activePath)}
          >
            <GitCompare size={12} />
          </IconButton>
        )}
        <IconButton title="Close editor panel" onClick={requestCloseAll}>
          <PanelRightClose size={12} />
        </IconButton>
      </div>

      {closeTarget && (
        <Modal onClose={() => setCloseTarget(null)} width={360}>
          <p className="text-xs font-semibold text-slate-200 uppercase tracking-wide">Unsaved Changes</p>
          <p className="text-xs text-slate-400 mt-2">
            <span className="text-slate-200 font-medium">{fileName(closeTarget)}</span> has unsaved changes.
            Save before closing?
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCloseTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                closeFile(closeTarget);
                setCloseTarget(null);
              }}
              className="text-red-400"
            >
              Discard
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void saveFile(closeTarget).then(() => closeFile(closeTarget));
                setCloseTarget(null);
              }}
            >
              Save & Close
            </Button>
          </div>
        </Modal>
      )}

      {closeAllRequested && (
        <Modal onClose={() => setCloseAllRequested(false)} width={360}>
          <p className="text-xs font-semibold text-slate-200 uppercase tracking-wide">Unsaved Changes</p>
          <p className="text-xs text-slate-400 mt-2">
            {dirtyCount} file{dirtyCount === 1 ? "" : "s"} have unsaved changes. Save before closing the
            editor?
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCloseAllRequested(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                closeAll();
                setCloseAllRequested(false);
              }}
              className="text-red-400"
            >
              Discard All
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void saveAllDirty().then(() => closeAll());
                setCloseAllRequested(false);
              }}
            >
              Save All & Close
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
