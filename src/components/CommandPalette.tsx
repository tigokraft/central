import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Terminal,
  Box,
  MessageSquare,
  Brain,
  Frame as FrameIcon,
  Play,
  Map,
  Undo2,
  Redo2,
  Crosshair,
  FolderOpen,
  Home,
  type LucideIcon,
} from "lucide-react";
import Modal from "./ui/Modal";
import { cn } from "../lib/cn";
import {
  useCanvasStore,
  NEW_PROJECT_TEMPLATE,
  type CanvasNode,
  type CanvasEdge,
  type Viewport,
} from "../store/canvasStore";
import { useAppViewStore } from "../store/appViewStore";

interface CommandPaletteProps {
  onClose: () => void;
  toggleMinimap: () => void;
}

interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  lastModifiedAt: number;
  path: string;
}

interface ProjectGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
}

interface Command {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  run: () => void;
}

const ADD_NODE_PRESETS: { type: CanvasNode["type"]; label: string; icon: LucideIcon }[] = [
  { type: "terminalNode", label: "Add Terminal Node", icon: Terminal },
  { type: "promptNode", label: "Add Prompt Node", icon: MessageSquare },
  { type: "actionContainerNode", label: "Add Action Container", icon: Box },
  { type: "memoryNode", label: "Add Neural Memory", icon: Brain },
  { type: "actionFrameNode", label: "Add Action Frame", icon: FrameIcon },
];

// Subsequence fuzzy match: every character of the query must appear in order somewhere in
// the target, with a bonus for consecutive runs so tighter matches ("term") outrank sparse
// ones ("t...e...r...m"). Returns null when the query isn't a subsequence at all.
function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1 + consecutive;
      consecutive += 1;
      qi += 1;
    } else {
      consecutive = 0;
    }
  }
  return qi === q.length ? score : null;
}

export default function CommandPalette({ onClose, toggleMinimap }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const activeProjectId = useAppViewStore((state) => state.activeProjectId);
  const openProject = useAppViewStore((state) => state.openProject);
  const goHome = useAppViewStore((state) => state.goHome);
  const nodes = useCanvasStore((state) => state.nodes);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Project-switcher entries (Phase 3c). Fetched once on open, same call HomeView makes.
  useEffect(() => {
    invoke<ProjectMeta[]>("list_projects")
      .then((list) => setProjects(list.filter((p) => p.id !== activeProjectId)))
      .catch((err) => console.error("Failed to list projects:", err));
  }, [activeProjectId]);

  const switchToProject = async (projectId: string) => {
    try {
      const graph = await invoke<ProjectGraph | null>("load_project_graph", { projectId });
      useCanvasStore.getState().hydrateFromProject(projectId, graph ?? NEW_PROJECT_TEMPLATE);
      openProject(projectId);
    } catch (err) {
      console.error("Failed to open project:", err);
    }
  };

  const commands = useMemo<Command[]>(() => {
    const { addNode, setSelectedNodeIds, zoomToFit, runPipeline } = useCanvasStore.getState();

    const addNodeCommands: Command[] = ADD_NODE_PRESETS.map((preset) => ({
      id: `add-${preset.type}`,
      label: preset.label,
      group: "Add Node",
      icon: preset.icon,
      run: () => {
        const { pointerCanvasPosition, viewport } = useCanvasStore.getState();
        let centerX: number;
        let centerY: number;
        if (pointerCanvasPosition) {
          centerX = pointerCanvasPosition.x;
          centerY = pointerCanvasPosition.y;
        } else {
          const container = document.getElementById("canvas-container");
          const rect = container?.getBoundingClientRect();
          const width = rect?.width ?? window.innerWidth;
          const height = rect?.height ?? window.innerHeight;
          centerX = (width / 2 - viewport.x) / viewport.zoom;
          centerY = (height / 2 - viewport.y) / viewport.zoom;
        }
        const id = addNode(preset.type, centerX - 160, centerY - 75);
        setSelectedNodeIds([id]);
      },
    }));

    const jumpCommands: Command[] = nodes.map((node) => ({
      id: `jump-${node.id}`,
      label: node.data.label || node.type,
      group: "Jump to Node",
      icon: Crosshair,
      run: () => zoomToFit([node.id]),
    }));

    const actionCommands: Command[] = [
      {
        id: "run-pipeline",
        label: "Run Pipeline",
        group: "Run",
        icon: Play,
        run: () => void runPipeline(),
      },
      {
        id: "toggle-minimap",
        label: "Toggle Minimap",
        group: "View",
        icon: Map,
        run: toggleMinimap,
      },
      {
        id: "undo",
        label: "Undo",
        group: "Edit",
        icon: Undo2,
        run: () => useCanvasStore.temporal.getState().undo(),
      },
      {
        id: "redo",
        label: "Redo",
        group: "Edit",
        icon: Redo2,
        run: () => useCanvasStore.temporal.getState().redo(),
      },
    ];

    const projectCommands: Command[] = [
      {
        id: "go-home",
        label: "Go to Home",
        group: "Project",
        icon: Home,
        run: goHome,
      },
      ...projects.map((project) => ({
        id: `switch-${project.id}`,
        label: `Switch to: ${project.name}`,
        group: "Project",
        icon: FolderOpen,
        run: () => void switchToProject(project.id),
      })),
    ];

    return [...addNodeCommands, ...jumpCommands, ...actionCommands, ...projectCommands];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, projects, toggleMinimap, goHome]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((cmd) => ({ cmd, score: fuzzyScore(query, cmd.label) }))
      .filter((entry): entry is { cmd: Command; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.cmd);
  }, [commands, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const runCommand = (cmd: Command) => {
    cmd.run();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[selectedIndex];
      if (cmd) runCommand(cmd);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <Modal onClose={onClose} width={480} className="p-0 overflow-hidden">
      <div className="border-b border-slate-800 px-3 py-2.5">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command..."
          className="w-full bg-transparent text-sm text-slate-200 placeholder-slate-600 focus:outline-none"
        />
      </div>

      <div ref={listRef} className="max-h-80 overflow-y-auto py-1.5">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-xs text-slate-600 text-center">No matching commands</div>
        ) : (
          filtered.map((cmd, i) => (
            <button
              key={cmd.id}
              data-index={i}
              onClick={() => runCommand(cmd)}
              onMouseEnter={() => setSelectedIndex(i)}
              className={cn(
                "w-full text-left px-3 py-1.5 text-xs flex items-center gap-2.5 cursor-pointer transition-colors",
                i === selectedIndex ? "bg-emerald-500/10 text-emerald-400" : "text-slate-300 hover:bg-slate-800"
              )}
            >
              <cmd.icon size={13} className={i === selectedIndex ? "text-emerald-400" : "text-slate-500"} />
              <span className="flex-1 truncate">{cmd.label}</span>
              <span className="text-[10px] text-slate-600 uppercase tracking-wide">{cmd.group}</span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
