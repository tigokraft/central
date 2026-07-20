import { CheckCircle2, CircleDashed, GitMerge, Loader2, RotateCcw, XCircle } from "lucide-react";
import type { RunTaskStatus } from "../../store/runStore";
import { cn } from "../../lib/cn";

const STATE_META: Record<
  RunTaskStatus["state"],
  { label: string; icon: typeof CircleDashed; className: string }
> = {
  pending: { label: "Pending", icon: CircleDashed, className: "text-slate-500" },
  running: { label: "Running", icon: Loader2, className: "text-sky-400" },
  merging: { label: "Merging", icon: GitMerge, className: "text-amber-400" },
  done: { label: "Done", icon: CheckCircle2, className: "text-emerald-400" },
  failed: { label: "Failed", icon: XCircle, className: "text-red-400" },
  bounced: { label: "Bounced", icon: RotateCcw, className: "text-amber-400" },
};

export default function RunTaskCard({ status }: { status: RunTaskStatus }) {
  const meta = STATE_META[status.state];
  const Icon = meta.icon;
  const spinning = status.state === "running";

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-semibold text-slate-200" title={status.task.title}>
          {status.task.title}
        </span>
        <span className={cn("flex items-center gap-1 shrink-0 text-[10px] font-semibold uppercase tracking-wide", meta.className)}>
          <Icon size={12} className={spinning ? "animate-spin" : undefined} />
          {meta.label}
          {status.retryCount > 0 && ` · retry ${status.retryCount}`}
        </span>
      </div>

      {status.task.fileScopes.length > 0 && (
        <div className="truncate text-[10px] text-slate-500 font-mono" title={status.task.fileScopes.join(", ")}>
          {status.task.fileScopes.join(", ")}
        </div>
      )}

      <p className="text-[11px] leading-snug text-slate-400 line-clamp-3">{status.task.prompt}</p>

      {status.message && (
        <pre
          className={cn(
            "mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-2 text-[10px] leading-snug",
            status.state === "failed"
              ? "border-red-900/60 bg-red-950/30 text-red-300"
              : "border-amber-900/60 bg-amber-950/20 text-amber-300"
          )}
        >
          {status.message}
        </pre>
      )}
    </div>
  );
}
