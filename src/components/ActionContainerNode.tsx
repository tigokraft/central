import React from "react";
import { Handle, Position } from "@xyflow/react";
import { Box, Settings, ArrowRight } from "lucide-react";

export type ActionContainerData = {
  label: string;
  description?: string;
  actions?: string[];
};

interface ActionContainerProps {
  id: string;
  data: ActionContainerData;
}

export default function ActionContainerNode({ id, data }: ActionContainerProps) {
  const actionsList = data.actions || ["Run Linter", "Execute Unit Tests", "Format Codebase"];

  return (
    <div className="bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-xl shadow-2xl overflow-hidden min-w-[340px] min-h-[180px] p-4 transition-all hover:border-emerald-500/40 nodrag">
      <Handle
        type="target"
        position={Position.Left}
        id="input"
        style={{ background: "#10b981", width: "8px", height: "8px" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        style={{ background: "#10b981", width: "8px", height: "8px" }}
      />

      {/* Header */}
      <div className="flex items-center justify-between mb-3 border-b border-slate-800/80 pb-2">
        <div className="flex items-center gap-2">
          <Box size={14} className="text-emerald-400" />
          <span className="font-semibold text-xs text-slate-200 tracking-wide uppercase">
            {data.label || "Action Container"}
          </span>
        </div>
        <Settings size={12} className="text-slate-400 cursor-pointer hover:text-emerald-400" />
      </div>

      {/* Description */}
      <p className="text-[11px] text-slate-400 mb-4 italic leading-relaxed">
        {data.description || "Container encapsulating sub-steps of the pipeline execution."}
      </p>

      {/* Nested Actions List */}
      <div className="space-y-1.5">
        {actionsList.map((action, index) => (
          <div
            key={index}
            className="flex items-center justify-between bg-slate-950/80 border border-slate-800/60 rounded px-2.5 py-1.5 text-[10px] font-mono text-slate-300"
          >
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {action}
            </span>
            <ArrowRight size={10} className="text-slate-500" />
          </div>
        ))}
      </div>
    </div>
  );
}
