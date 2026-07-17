import { useEffect } from "react";
import { Keyboard } from "lucide-react";
import Modal from "./ui/Modal";

interface ShortcutsOverlayProps {
  onClose: () => void;
}

const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: "V", description: "Select tool" },
  { keys: "H", description: "Hand (pan) tool" },
  { keys: "F", description: "Frame tool" },
  { keys: "Delete / Backspace", description: "Delete selection" },
  { keys: "Cmd/Ctrl+Z", description: "Undo" },
  { keys: "Cmd/Ctrl+Shift+Z", description: "Redo" },
  { keys: "Shift+1", description: "Zoom to fit" },
  { keys: "Shift+2", description: "Zoom to selection" },
  { keys: "Space+Drag", description: "Pan canvas" },
  { keys: "Cmd/Ctrl+K", description: "Command palette" },
  { keys: "?", description: "Show this overlay" },
];

export default function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <Modal onClose={onClose} width={360}>
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-800">
        <Keyboard size={14} className="text-emerald-400" />
        <span className="text-xs font-semibold text-slate-200 uppercase tracking-wide">Keyboard Shortcuts</span>
      </div>

      <div className="space-y-1.5">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.keys} className="flex items-center justify-between gap-4">
            <span className="text-xs text-slate-300">{shortcut.description}</span>
            <kbd className="text-[10px] font-mono text-slate-400 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 whitespace-nowrap">
              {shortcut.keys}
            </kbd>
          </div>
        ))}
      </div>
    </Modal>
  );
}
