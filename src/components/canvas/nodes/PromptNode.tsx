import React, { useState } from "react";
import { MessageSquareCode, Save } from "lucide-react";
import { useCanvasStore, CanvasNode } from "../../../store/canvasStore";
import Port from "../Port";

interface PromptNodeProps {
  node: CanvasNode;
}

export default function PromptNode({ node }: PromptNodeProps) {
  const { id, data } = node;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [promptText, setPromptText] = useState(data.prompt || "");

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setPromptText(val);
    updateNodeData(id, { prompt: val });
  };

  return (
    <div className="relative w-full h-full bg-slate-900 border border-slate-800 rounded-lg shadow-2xl overflow-hidden p-3 flex flex-col transition-all hover:border-emerald-500/50 select-none">
      {/* Sockets - Left input (trigger) and Right output (output) */}
      <Port
        nodeId={id}
        handleId="trigger"
        type="target"
        className="absolute -left-1.5 top-1/2 -translate-y-1/2"
      />
      <Port
        nodeId={id}
        handleId="output"
        type="source"
        className="absolute -right-1.5 top-1/2 -translate-y-1/2"
      />

      {/* Header */}
      <div className="flex items-center justify-between mb-2 border-b border-slate-800 pb-1.5 shrink-0">
        <div className="flex items-center gap-1.5">
          <MessageSquareCode size={13} className="text-emerald-400" />
          <span className="font-mono text-[10px] text-slate-300">
            {data.label || "Prompt Editor"}
          </span>
        </div>
        <button className="p-0.5 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-400 transition-colors cursor-pointer">
          <Save size={11} />
        </button>
      </div>

      {/* Input Textarea */}
      <div className="relative flex-1 min-h-0">
        <textarea
          value={promptText}
          onChange={handleTextChange}
          placeholder="Type execution prompt or instruction script here..."
          className="w-full h-full bg-slate-950/80 border border-slate-800 rounded p-2 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 resize-none font-mono leading-normal"
          data-nodrag
        />
        <div className="absolute bottom-1 right-2 text-[8px] text-slate-600 font-mono pointer-events-none">
          {promptText.length} chars
        </div>
      </div>
    </div>
  );
}
