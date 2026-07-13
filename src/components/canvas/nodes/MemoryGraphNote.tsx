import React, { useState } from "react";
import { Brain } from "lucide-react";
import { useCanvasStore, CanvasNode } from "../../../store/canvasStore";
import Port from "../Port";

interface MemoryGraphNoteProps {
  node: CanvasNode;
}

export default function MemoryGraphNote({ node }: MemoryGraphNoteProps) {
  const { id, data } = node;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [noteText, setNoteText] = useState(data.note || "");

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setNoteText(val);
    updateNodeData(id, { note: val });
  };

  return (
    <div className="relative w-full h-full bg-slate-900 border border-slate-800 rounded-lg shadow-2xl overflow-hidden p-3 flex flex-col transition-all hover:border-pink-500/50 select-none">
      {/* Sockets - Pink color for Memory Nodes */}
      <Port
        nodeId={id}
        handleId="trigger"
        type="target"
        color="pink"
        className="absolute -left-1.5 top-1/2 -translate-y-1/2"
      />
      <Port
        nodeId={id}
        handleId="output"
        type="source"
        color="pink"
        className="absolute -right-1.5 top-1/2 -translate-y-1/2"
      />

      {/* Header */}
      <div className="flex items-center justify-between mb-2 border-b border-slate-800 pb-1.5 shrink-0">
        <div className="flex items-center gap-1.5">
          <Brain size={13} className="text-pink-400" />
          <span className="font-mono text-[10px] text-slate-300">
            {data.label || "Memory Graph Note"}
          </span>
        </div>
      </div>

      {/* Input Textarea */}
      <div className="relative flex-1 min-h-0">
        <textarea
          value={noteText}
          onChange={handleTextChange}
          placeholder="Enter memory key-value pairs or structured knowledge..."
          className="w-full h-full bg-slate-950/80 border border-slate-800 rounded p-2 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-pink-500/50 resize-none font-mono leading-normal"
          data-nodrag
        />
        <div className="absolute bottom-1 right-2 text-[8px] text-slate-600 font-mono pointer-events-none">
          {noteText.length} chars
        </div>
      </div>
    </div>
  );
}
