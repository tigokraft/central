import { useState, ChangeEvent } from "react";
import { Handle, Position } from "@xyflow/react";
import { Brain } from "lucide-react";

export type MemoryGraphNoteData = {
  label: string;
  note: string;
  onChangeNote?: (newVal: string) => void;
};

interface MemoryGraphNoteProps {
  id: string;
  data: MemoryGraphNoteData;
}

export default function MemoryGraphNote({ data }: MemoryGraphNoteProps) {
  const [noteText, setNoteText] = useState(data.note || "");

  const handleTextChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setNoteText(val);
    if (data.onChangeNote) {
      data.onChangeNote(val);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg shadow-2xl overflow-hidden min-w-[320px] p-3 transition-all hover:border-pink-500/50 nodrag">
      <Handle
        type="target"
        position={Position.Left}
        id="trigger"
        style={{ background: "#ec4899", width: "8px", height: "8px" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        style={{ background: "#ec4899", width: "8px", height: "8px" }}
      />

      {/* Header */}
      <div className="flex items-center justify-between mb-2 border-b border-slate-800 pb-1.5">
        <div className="flex items-center gap-1.5">
          <Brain size={13} className="text-pink-400" />
          <span className="font-mono text-[10px] text-slate-300">
            {data.label || "Memory Graph Note"}
          </span>
        </div>
      </div>

      {/* Input Textarea */}
      <div className="relative">
        <textarea
          value={noteText}
          onChange={handleTextChange}
          placeholder="Enter memory key-value pairs or structured knowledge..."
          className="w-full h-[90px] bg-slate-950/80 border border-slate-800 rounded p-2 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-pink-500/50 resize-none font-mono leading-normal"
        />
        <div className="absolute bottom-1 right-2 text-[8px] text-slate-600 font-mono">
          {noteText.length} chars
        </div>
      </div>
    </div>
  );
}
