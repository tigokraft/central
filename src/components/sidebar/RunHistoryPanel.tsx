import { CheckCircle2, XCircle, Terminal as TerminalIcon } from "lucide-react";
import { useCanvasStore } from "../../store/canvasStore";

// Merges disposable ephemeralActionNode runs (one entry per whole run) with lines submitted
// to long-lived terminalNode PTY sessions (one entry per Enter press) into a single
// chronological feed, since both are "things that ran in this project" from the user's
// perspective.
export default function RunHistoryPanel() {
  const ephemeralRuns = useCanvasStore((state) => state.ephemeralArchive);
  const terminalLines = useCanvasStore((state) => state.terminalRunHistory);

  if (ephemeralRuns.length === 0 && terminalLines.length === 0) {
    return <div className="text-[10px] text-slate-600 italic px-1 py-1">No run history yet.</div>;
  }

  const items = [
    ...ephemeralRuns.map((run) => ({ kind: "ephemeral" as const, at: run.finishedAt, run })),
    ...terminalLines.map((line) => ({ kind: "terminal" as const, at: line.submittedAt, line })),
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="space-y-1.5 py-1">
      {items.map((item) =>
        item.kind === "ephemeral" ? (
          <div
            key={`eph-${item.run.id}-${item.run.finishedAt}`}
            className="bg-slate-900/60 border border-slate-800 rounded-lg p-2 space-y-1"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[10px] text-slate-200 truncate">
                {item.run.status === "success" ? (
                  <CheckCircle2 size={10} className="text-emerald-500 shrink-0" />
                ) : (
                  <XCircle size={10} className="text-red-400 shrink-0" />
                )}
                {item.run.label}
              </span>
              <span className="text-[8px] text-slate-500 shrink-0">
                {new Date(item.run.finishedAt).toLocaleTimeString()}
              </span>
            </div>
            <div className="text-[9px] font-mono text-slate-500 truncate" title={item.run.command}>
              $ {item.run.command}
            </div>
          </div>
        ) : (
          <div
            key={item.line.id}
            className="bg-slate-900/60 border border-slate-800 rounded-lg p-2 space-y-1"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[10px] text-slate-200 truncate">
                <TerminalIcon size={10} className="text-emerald-500 shrink-0" />
                {item.line.nodeLabel}
              </span>
              <span className="text-[8px] text-slate-500 shrink-0 flex items-center gap-1">
                {new Date(item.line.submittedAt).toLocaleTimeString()}
                {item.line.exitCode !== undefined && (
                  <span className={item.line.exitCode === 0 ? "text-emerald-500" : "text-red-400"}>
                    exit {item.line.exitCode}
                  </span>
                )}
              </span>
            </div>
            <div className="text-[9px] font-mono text-slate-500 truncate" title={item.line.command}>
              $ {item.line.command}
            </div>
          </div>
        )
      )}
    </div>
  );
}
