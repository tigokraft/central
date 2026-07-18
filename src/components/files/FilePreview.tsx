import { X } from "lucide-react";

interface FilePreviewProps {
  path: string;
  loading: boolean;
  error: string | null;
  content: string | null;
  onClose: () => void;
}

// Read-only preview shown below the tree when a file is selected. No editing here — a real
// code editor arrives in a later PR; this is just enough to see what an agent generated.
export default function FilePreview({ path, loading, error, content, onClose }: FilePreviewProps) {
  const name = path.split("/").pop() ?? path;
  return (
    <div className="mt-2 border border-slate-800 rounded-lg bg-slate-900/60 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-slate-800">
        <span className="text-[10px] font-medium text-slate-300 truncate" title={path}>
          {name}
        </span>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-200 cursor-pointer shrink-0"
          title="Close preview"
        >
          <X size={11} />
        </button>
      </div>
      <div className="max-h-64 overflow-auto p-2">
        {loading ? (
          <div className="text-[10px] text-slate-600 italic">Loading…</div>
        ) : error ? (
          <div className="text-[10px] text-red-400">{error}</div>
        ) : (
          <pre className="text-[10px] font-mono text-slate-300 whitespace-pre">{content}</pre>
        )}
      </div>
    </div>
  );
}
