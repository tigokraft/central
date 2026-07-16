import { CheckCircle2, XCircle } from "lucide-react";
import { useCanvasStore } from "../../store/canvasStore";

export default function EphemeralRunsPanel() {
  const runs = useCanvasStore((state) => state.ephemeralArchive);

  if (runs.length === 0) {
    return <div className="text-[10px] text-slate-600 italic px-1 py-1">No disposable checks run yet.</div>;
  }

  return (
    <div className="space-y-1.5 py-1">
      {runs.map((run) => (
        <div key={`${run.id}-${run.finishedAt}`} className="bg-slate-900/60 border border-slate-800 rounded-lg p-2 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[10px] text-slate-200 truncate">
              {run.status === "success" ? (
                <CheckCircle2 size={10} className="text-emerald-500 shrink-0" />
              ) : (
                <XCircle size={10} className="text-red-400 shrink-0" />
              )}
              {run.label}
            </span>
            <span className="text-[8px] text-slate-500 shrink-0">
              {new Date(run.finishedAt).toLocaleTimeString()}
            </span>
          </div>
          <div className="text-[9px] font-mono text-slate-500 truncate" title={run.command}>
            $ {run.command}
          </div>
        </div>
      ))}
    </div>
  );
}
