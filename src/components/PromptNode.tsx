import React, { useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { MessageSquareCode, Save } from "lucide-react";

export type PromptNodeData = {
  label: string;
  prompt: string;
  onChangePrompt?: (newVal: string) => void;
};

interface PromptNodeProps {
  id: string;
  data: PromptNodeData;
}

export default function PromptNode({ data }: PromptNodeProps) {
  const [promptText, setPromptText] = useState(data.prompt || "");

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setPromptText(val);
    if (data.onChangePrompt) {
      data.onChangePrompt(val);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg shadow-2xl overflow-hidden min-w-[320px] p-3 transition-all hover:border-emerald-500/50 nodrag">
      <Handle
        type="target"
        position={Position.Left}
        id="trigger"
        style={{ background: "#10b981", width: "8px", height: "8px" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        style={{ background: "#10b981", width: "8px", height: "8px" }}
      />

      {/* Header */}
      <div className="flex items-center justify-between mb-2 border-b border-slate-800 pb-1.5">
        <div className="flex items-center gap-1.5">
          <MessageSquareCode size={13} className="text-emerald-400" />
          <span className="font-mono text-[10px] text-slate-300">
            {data.label || "Prompt Editor"}
          </span>
        </div>
        <button className="p-0.5 hover:bg-slate-800 rounded text-slate-400 hover:text-emerald-400 transition-colors">
          <Save size={11} />
        </button>
      </div>

      {/* Input Textarea */}
      <div className="relative">
        <textarea
          value={promptText}
          onChange={handleTextChange}
          placeholder="Type execution prompt or instruction script here..."
          className="w-full h-[90px] bg-slate-950/80 border border-slate-800 rounded p-2 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 resize-none font-mono leading-normal"
        />
        <div className="absolute bottom-1 right-2 text-[8px] text-slate-600 font-mono">
          {promptText.length} chars
        </div>
      </div>
    </div>
  );
}
