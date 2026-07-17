import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Sparkles, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useCanvasStore, CanvasNode } from "../../../store/canvasStore";

interface EphemeralActionNodeProps {
  node: CanvasNode;
}

interface NodeEventPayload {
  nodeId: string;
  message?: string;
  output?: string;
}

const SELF_ARCHIVE_DELAY_MS = 2400;

// A disposable one-off execution node: runs its command immediately on drop, then archives
// its result and removes itself from the canvas a moment later. Never gets ports or edges.
export default function EphemeralActionNode({ node }: EphemeralActionNodeProps) {
  const { id, data } = node;
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const archiveEphemeralRun = useCanvasStore((state) => state.archiveEphemeralRun);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const [lastLine, setLastLine] = useState("");
  const [isArchiving, setIsArchiving] = useState(false);
  const outputRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];

    const finish = (status: "success" | "error", finalOutput: string) => {
      if (cancelled) return;
      setIsArchiving(true);
      updateNodeData(id, { status, isRunning: false });
      archiveEphemeralRun({
        id,
        label: data.label || "Ad-hoc Check",
        command: data.command || "",
        status,
        output: finalOutput.trim(),
        finishedAt: Date.now(),
      });
      window.setTimeout(() => {
        if (!cancelled) deleteNode(id);
      }, SELF_ARCHIVE_DELAY_MS);
    };

    const setup = async () => {
      unlistenFns.push(
        await listen<NodeEventPayload>("node-streaming", (e) => {
          if (e.payload.nodeId !== id || cancelled) return;
          const line = e.payload.output || "";
          outputRef.current += line + "\n";
          setLastLine(line);
        })
      );
      unlistenFns.push(
        await listen<NodeEventPayload>("node-success", (e) => {
          if (e.payload.nodeId !== id) return;
          finish("success", e.payload.output || outputRef.current);
        })
      );
      unlistenFns.push(
        await listen<NodeEventPayload>("node-fail", (e) => {
          if (e.payload.nodeId !== id) return;
          finish("error", e.payload.output || e.payload.message || outputRef.current);
        })
      );

      updateNodeData(id, { status: "running", isRunning: true });
      try {
        await invoke("run_ephemeral_command", { nodeId: id, command: data.command || "" });
      } catch (err) {
        finish("error", String(err));
      }
    };

    setup();

    return () => {
      cancelled = true;
      unlistenFns.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const isRunning = data.status === "running";
  const isError = data.status === "error";
  const isSuccess = data.status === "success";

  let StatusIcon = Loader2;
  let statusClass = "text-slate-400 animate-spin";
  if (isSuccess) {
    StatusIcon = CheckCircle2;
    statusClass = "text-emerald-400";
  } else if (isError) {
    StatusIcon = XCircle;
    statusClass = "text-red-400";
  }

  return (
    <div
      className={`relative w-full h-full bg-slate-900 border rounded-lg shadow-panel overflow-hidden p-2.5 flex flex-col gap-1 select-none transition-opacity duration-500 ${
        isError ? "border-red-500/50" : isSuccess ? "border-emerald-500/40" : "border-running/40"
      } ${isArchiving ? "opacity-30" : "opacity-100"}`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <Sparkles size={11} className="text-slate-400 shrink-0" />
        <span className="text-[10px] font-mono text-slate-300 truncate flex-1">
          {data.label || "Ad-hoc Check"}
        </span>
        <StatusIcon size={12} className={`shrink-0 ${statusClass}`} />
      </div>
      <div className="text-[9px] font-mono text-slate-500 truncate" title={data.command}>
        $ {data.command}
      </div>
      {(isRunning || lastLine) && (
        <div className="text-[9px] font-mono text-slate-400 truncate bg-slate-950/70 rounded px-1.5 py-1 border border-slate-800/60">
          {lastLine || "waiting for output..."}
        </div>
      )}
      {isArchiving && (
        <div className="text-[8px] font-mono text-slate-600 italic">archiving & self-removing...</div>
      )}
    </div>
  );
}
