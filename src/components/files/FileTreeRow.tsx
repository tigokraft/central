import { type ChangeEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronRight, ChevronDown, Folder, File as FileIcon } from "lucide-react";
import { cn } from "../../lib/cn";

interface FileTreeRowProps {
  depth: number;
  name: string;
  kind: "file" | "dir";
  isExpanded?: boolean;
  isSelected?: boolean;
  isEditing?: boolean;
  editingValue?: string;
  onEditingValueChange?: (value: string) => void;
  onCommitEdit?: () => void;
  onCancelEdit?: () => void;
  onClick?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
}

// A single visible line in the flattened file tree: either a normal file/dir row, or (when
// isEditing) an inline text input used for both "create" (empty starting value) and "rename"
// (pre-filled with the current name) — same interaction shape as PipelineTabBar's tab rename.
export default function FileTreeRow({
  depth,
  name,
  kind,
  isExpanded,
  isSelected,
  isEditing,
  editingValue,
  onEditingValueChange,
  onCommitEdit,
  onCancelEdit,
  onClick,
  onContextMenu,
}: FileTreeRowProps) {
  return (
    <div
      onClick={isEditing ? undefined : onClick}
      onContextMenu={onContextMenu}
      style={{ paddingLeft: 6 + depth * 12 }}
      className={cn(
        "flex items-center gap-1 pr-2 py-0.5 rounded text-[10px] cursor-pointer select-none",
        isSelected ? "bg-emerald-500/10 text-emerald-300" : "text-slate-300 hover:bg-slate-800/60"
      )}
    >
      {kind === "dir" ? (
        isExpanded ? (
          <ChevronDown size={10} className="shrink-0 text-slate-500" />
        ) : (
          <ChevronRight size={10} className="shrink-0 text-slate-500" />
        )
      ) : (
        <span className="w-[10px] shrink-0" />
      )}
      {kind === "dir" ? (
        <Folder size={11} className="shrink-0 text-slate-500" />
      ) : (
        <FileIcon size={11} className="shrink-0 text-slate-500" />
      )}
      {isEditing ? (
        <input
          autoFocus
          value={editingValue}
          onClick={(e) => e.stopPropagation()}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onEditingValueChange?.(e.target.value)}
          onBlur={onCommitEdit}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") onCommitEdit?.();
            if (e.key === "Escape") onCancelEdit?.();
          }}
          className="bg-slate-900 border border-emerald-500/50 rounded px-1 py-0 text-[10px] text-slate-100 w-full min-w-0 focus:outline-none"
        />
      ) : (
        <span className="truncate">{name}</span>
      )}
    </div>
  );
}
