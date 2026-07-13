import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Square, X, Zap } from "lucide-react";

export default function CustomTitleBar() {
  const [isWindows, setIsWindows] = useState(false);

  useEffect(() => {
    if (navigator.userAgent.includes("Windows")) {
      setIsWindows(true);
    }
  }, []);

  if (!isWindows) return null;

  const appWindow = getCurrentWindow();

  const handleMinimize = () => {
    appWindow.minimize().catch(console.error);
  };

  const handleMaximize = () => {
    appWindow.toggleMaximize().catch(console.error);
  };

  const handleClose = () => {
    appWindow.close().catch(console.error);
  };

  return (
    <div
      className="h-8 bg-slate-950 border-b border-slate-900 flex items-center justify-between select-none z-50 shrink-0 text-slate-400 text-xs font-sans"
      data-tauri-drag-region
    >
      {/* Title / Logo */}
      <div className="flex items-center gap-2 pl-3 pointer-events-none" data-tauri-drag-region>
        <Zap className="text-emerald-500 w-3.5 h-3.5" />
        <span className="font-semibold tracking-wider text-[10px] uppercase text-slate-300">Central</span>
      </div>

      {/* Drag Region Filler */}
      <div className="flex-1 h-full cursor-default" data-tauri-drag-region />

      {/* Window Action Controls */}
      <div className="flex items-center h-full">
        <button
          onClick={handleMinimize}
          className="w-11 h-full flex items-center justify-center hover:bg-slate-800 transition-colors text-slate-400 hover:text-slate-200 cursor-pointer"
          title="Minimize"
        >
          <span className="w-2.5 h-[1.5px] bg-current" />
        </button>
        <button
          onClick={handleMaximize}
          className="w-11 h-full flex items-center justify-center hover:bg-slate-800 transition-colors text-slate-400 hover:text-slate-200 cursor-pointer"
          title="Maximize"
        >
          <Square size={9} className="stroke-[2px]" />
        </button>
        <button
          onClick={handleClose}
          className="w-11 h-full flex items-center justify-center hover:bg-red-600 transition-colors text-slate-400 hover:text-white cursor-pointer"
          title="Close"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
