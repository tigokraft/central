import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// Monotonic counter guarantees unique node ids even when several nodes are created
// synchronously within the same millisecond (e.g. the orchestrator dropping a full plan).
let nodeSeq = 0;
function nextNodeSeq(): number {
  nodeSeq += 1;
  return nodeSeq;
}

export type AgentRole = "coder" | "reviewer" | "test-runner";

export interface AttachedMcpTool {
  serverId: string;
  toolName: string;
}

export interface CanvasNode {
  id: string;
  type:
    | "terminalNode"
    | "actionContainerNode"
    | "promptNode"
    | "memoryNode"
    | "memoryGraphNote"
    | "actionFrameNode"
    | "ephemeralActionNode";
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
  data: {
    label: string;
    prompt?: string;
    note?: string;
    description?: string;
    actions?: string[];
    facts?: string[];
    entities?: string[];
    command?: string;
    isRunning?: boolean;
    status?: "idle" | "running" | "success" | "error";
    role?: AgentRole;
    ephemeral?: boolean;
    attachedTools?: AttachedMcpTool[];
  };
}

// Container node types other nodes can be nested inside via parentId.
const FRAME_CONTAINER_TYPES: CanvasNode["type"][] = ["actionContainerNode", "actionFrameNode"];

export interface EphemeralArchiveEntry {
  id: string;
  label: string;
  command: string;
  status: "success" | "error";
  output: string;
  finishedAt: number;
}

export type EdgeExecState = "idle" | "streaming" | "success" | "fail";

export interface CableDiffStat {
  insertions: number;
  deletions: number;
  filesChanged: number;
  commitSha: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export function getHandlePosition(node: CanvasNode, handleId: string): { x: number; y: number } {
  if (node.type === "terminalNode") {
    if (handleId === "trigger" || handleId === "input" || handleId === "top" || handleId === "done") {
      // If it is top, trigger, input
      if (handleId === "done") {
        return { x: node.x + node.width / 2, y: node.y + node.height };
      }
      return { x: node.x + node.width / 2, y: node.y };
    }
    // Bottom handles
    return { x: node.x + node.width / 2, y: node.y + node.height };
  }
  // Default to Left input, Right output for other nodes
  if (handleId === "trigger" || handleId === "input" || handleId === "left") {
    return { x: node.x, y: node.y + node.height / 2 };
  }
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface CanvasState {
  viewport: Viewport;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  activeTool: "select" | "hand" | "frame";
  draggingEdge: {
    sourceId: string;
    sourceHandle: string;
    x: number;
    y: number;
  } | null;
  pointerCanvasPosition: { x: number; y: number } | null;

  // Setters & Actions
  setViewport: (viewport: Partial<Viewport>) => void;
  panViewport: (dx: number, dy: number) => void;
  zoomViewport: (scale: number, mouseX?: number, mouseY?: number) => void;
  setActiveTool: (tool: "select" | "hand" | "frame") => void;
  setPointerCanvasPosition: (x: number, y: number) => void;
  
  // Node Actions
  addNode: (
    type: CanvasNode["type"],
    x: number,
    y: number,
    overrides?: Partial<Omit<CanvasNode, "id" | "type">>
  ) => string;
  updateNodePosition: (id: string, x: number, y: number, dragDelta?: { dx: number; dy: number }) => void;
  updateNodeDimensions: (id: string, width: number, height: number) => void;
  updateNodeData: (id: string, data: Partial<CanvasNode["data"]>) => void;
  reparentNode: (nodeId: string) => void;
  deleteNode: (id: string) => void;
  attachMcpTool: (nodeId: string, tool: AttachedMcpTool) => void;
  detachMcpTool: (nodeId: string, tool: AttachedMcpTool) => void;

  // Disposable ephemeral nodes
  ephemeralArchive: EphemeralArchiveEntry[];
  archiveEphemeralRun: (entry: EphemeralArchiveEntry) => void;

  // Edge Actions
  addEdge: (sourceId: string, sourceHandle: string, targetId: string, targetHandle: string) => void;
  deleteEdge: (id: string) => void;
  startDraggingEdge: (sourceId: string, sourceHandle: string, x: number, y: number) => void;
  updateDraggingEdge: (x: number, y: number) => void;
  stopDraggingEdge: () => void;

  // Presets & Execution
  loadPreset: (presetName: string) => void;
  runPipeline: () => Promise<void>;

  // Execution state (driven by graph_runner events)
  edgeExecState: Record<string, EdgeExecState>;
  cableDiffStats: Record<string, CableDiffStat>;
  isPipelineRunning: boolean;
  setNodeStatus: (id: string, status: CanvasNode["data"]["status"]) => void;
  setEdgeExecStateForTarget: (targetNodeId: string, execState: EdgeExecState) => void;
  setCableDiffStat: (sourceNodeId: string, targetNodeId: string, stat: CableDiffStat) => void;
  resetExecutionState: () => void;
  setPipelineRunning: (running: boolean) => void;

  // Selection
  selectedNodeIds: string[];
  setSelectedNodeIds: (ids: string[]) => void;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  selectedNodeIds: [],
  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    {
      id: "prompt-1",
      type: "promptNode",
      x: 100,
      y: 200,
      width: 320,
      height: 150,
      data: {
        label: "Prompt Input",
        prompt: "Refactor terminal rendering to support dynamic dimensions and automatic fit resizing.",
      },
    },
    {
      id: "action-1",
      type: "actionContainerNode",
      x: 500,
      y: 150,
      width: 340,
      height: 240,
      data: {
        label: "Action Container Pipeline",
        description: "Validation check and source formatting process pipeline.",
        actions: [
          "echo 'Lint passed'",
          "echo 'Format check passed'",
          "echo 'agent patch' > agent-patch.txt",
          "echo 'Tests passed'",
        ],
      },
    },
    {
      id: "terminal-1",
      type: "terminalNode",
      x: 920,
      y: 170,
      width: 320,
      height: 190,
      data: {
        label: "Tauri Compiler Console",
        command: "echo 'Build verified' && exit 0",
        isRunning: false,
        status: "idle",
      },
    },
  ],
  edges: [
    {
      id: "e-prompt-action",
      source: "prompt-1",
      sourceHandle: "output",
      target: "action-1",
      targetHandle: "input",
    },
    {
      id: "e-action-terminal",
      source: "action-1",
      sourceHandle: "output",
      target: "terminal-1",
      targetHandle: "trigger",
    },
  ],
  activeTool: "select",
  draggingEdge: null,
  pointerCanvasPosition: null,
  edgeExecState: {},
  cableDiffStats: {},
  isPipelineRunning: false,

  setViewport: (vp) =>
    set((state) => ({ viewport: { ...state.viewport, ...vp } })),

  panViewport: (dx, dy) =>
    set((state) => ({
      viewport: {
        ...state.viewport,
        x: state.viewport.x + dx,
        y: state.viewport.y + dy,
      },
    })),

  zoomViewport: (factor, mouseX, mouseY) =>
    set((state) => {
      const zoom = Math.min(Math.max(state.viewport.zoom * factor, 0.15), 4);
      if (mouseX !== undefined && mouseY !== undefined) {
        // Zoom towards mouse pointer
        const dx = mouseX - state.viewport.x;
        const dy = mouseY - state.viewport.y;
        return {
          viewport: {
            zoom,
            x: mouseX - dx * (zoom / state.viewport.zoom),
            y: mouseY - dy * (zoom / state.viewport.zoom),
          },
        };
      }
      return {
        viewport: { ...state.viewport, zoom },
      };
    }),

  setActiveTool: (tool) => set({ activeTool: tool }),

  setPointerCanvasPosition: (x, y) => set({ pointerCanvasPosition: { x, y } }),

  addNode: (type, x, y, overrides) => {
    const id = `${type}-${Date.now()}-${nextNodeSeq()}`;
    let label = "";
    let data: CanvasNode["data"] = { label };
    let width = 320;
    let height = 150;

    switch (type) {
      case "terminalNode":
        label = "Terminal Console";
        data = { label, command: "echo hello", isRunning: false, status: "idle" };
        height = 190;
        break;
      case "actionContainerNode":
        label = "Pipeline Container";
        data = {
          label,
          description: "Custom pipeline tasks.",
          actions: ["npm run lint", "pnpm test"],
        };
        width = 340;
        height = 240;
        break;
      case "promptNode":
        label = "Prompt Input";
        data = { label, prompt: "Enter instructions here..." };
        break;
      case "memoryNode":
        label = "Neural Memory";
        data = { label, facts: ["App uses Tauri", "Memory Node added"] };
        break;
      case "actionFrameNode":
        label = "Action Frame";
        data = { label, description: "Orchestrated agent group" };
        width = 900;
        height = 360;
        break;
      case "ephemeralActionNode":
        label = "Ad-hoc Check";
        data = { label, command: "echo hello", status: "idle", ephemeral: true };
        width = 280;
        height = 110;
        break;
    }

    const newNode: CanvasNode = {
      id,
      type,
      x,
      y,
      width,
      height,
      ...overrides,
      data: { ...data, ...overrides?.data },
    };

    set((state) => ({
      nodes: [...state.nodes, newNode],
    }));

    return id;
  },

  updateNodePosition: (id, x, y, dragDelta) =>
    set((state) => {
      const node = state.nodes.find((n) => n.id === id);
      if (!node) return {};

      const dx = dragDelta ? dragDelta.dx : x - node.x;
      const dy = dragDelta ? dragDelta.dy : y - node.y;

      const isSelected = state.selectedNodeIds.includes(id);
      const nodesToMove = isSelected ? state.selectedNodeIds : [id];

      return {
        nodes: state.nodes.map((n) => {
          if (nodesToMove.includes(n.id)) {
            // Prevent double moving if parent is also selected and being moved
            if (n.parentId && nodesToMove.includes(n.parentId)) {
              return n;
            }
            return { ...n, x: n.x + dx, y: n.y + dy };
          }
          // Move children relative to their parent if the parent is moved but child is not in selection
          if (n.parentId && nodesToMove.includes(n.parentId) && !nodesToMove.includes(n.id)) {
            return { ...n, x: n.x + dx, y: n.y + dy };
          }
          return n;
        }),
      };
    }),

  updateNodeDimensions: (id, width, height) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, width, height } : n
      ),
    })),

  updateNodeData: (id, data) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...data } } : n
      ),
    })),

  reparentNode: (nodeId) =>
    set((state) => {
      const node = state.nodes.find((n) => n.id === nodeId);
      // Frames are always top-level; only they and plain action containers act as containers.
      if (!node || node.type === "actionFrameNode") return {};

      const nodeCenterX = node.x + node.width / 2;
      const nodeCenterY = node.y + node.height / 2;

      let newParentId: string | undefined = undefined;

      // Find the topmost container that bounds this node.
      // Iterate in reverse order so we get the topmost rendered container.
      // An actionContainerNode may only nest inside an actionFrameNode (Figma-style group),
      // never inside another actionContainerNode; every other node type may nest in either.
      for (let i = state.nodes.length - 1; i >= 0; i--) {
        const container = state.nodes[i];
        if (container.id === nodeId || !FRAME_CONTAINER_TYPES.includes(container.type)) continue;
        if (container.type === "actionContainerNode" && node.type === "actionContainerNode") continue;
        if (
          nodeCenterX >= container.x &&
          nodeCenterX <= container.x + container.width &&
          nodeCenterY >= container.y &&
          nodeCenterY <= container.y + container.height
        ) {
          newParentId = container.id;
          break;
        }
      }

      return {
        nodes: state.nodes.map((n) =>
          n.id === nodeId ? { ...n, parentId: newParentId } : n
        ),
      };
    }),

  deleteNode: (id) =>
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== id).map((n) => n.parentId === id ? { ...n, parentId: undefined } : n),
      edges: state.edges.filter((e) => e.source !== id && e.target !== id),
    })),

  attachMcpTool: (nodeId, tool) =>
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const existing = n.data.attachedTools || [];
        if (existing.some((t) => t.serverId === tool.serverId && t.toolName === tool.toolName)) return n;
        return { ...n, data: { ...n.data, attachedTools: [...existing, tool] } };
      }),
    })),

  detachMcpTool: (nodeId, tool) =>
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const existing = n.data.attachedTools || [];
        return {
          ...n,
          data: {
            ...n.data,
            attachedTools: existing.filter((t) => !(t.serverId === tool.serverId && t.toolName === tool.toolName)),
          },
        };
      }),
    })),

  ephemeralArchive: [],
  archiveEphemeralRun: (entry) =>
    set((state) => ({
      ephemeralArchive: [entry, ...state.ephemeralArchive].slice(0, 30),
    })),

  addEdge: (sourceId, sourceHandle, targetId, targetHandle) =>
    set((state) => {
      // Prevent duplicate edges
      const exists = state.edges.some(
        (e) =>
          e.source === sourceId &&
          e.sourceHandle === sourceHandle &&
          e.target === targetId &&
          e.targetHandle === targetHandle
      );
      if (exists) return {};

      // Create unique edge id
      const edgeId = `e-${sourceId}-${sourceHandle}-${targetId}-${targetHandle}`;
      const newEdge: CanvasEdge = {
        id: edgeId,
        source: sourceId,
        sourceHandle,
        target: targetId,
        targetHandle,
      };

      return {
        edges: [...state.edges, newEdge],
      };
    }),

  deleteEdge: (id) =>
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== id),
    })),

  startDraggingEdge: (sourceId, sourceHandle, x, y) =>
    set({
      draggingEdge: { sourceId, sourceHandle, x, y },
    }),

  updateDraggingEdge: (x, y) =>
    set((state) => ({
      draggingEdge: state.draggingEdge
        ? { ...state.draggingEdge, x, y }
        : null,
    })),

  stopDraggingEdge: () => set({ draggingEdge: null }),

  loadPreset: (presetName) => {
    if (presetName === "Code Loop") {
      set({
        nodes: [
          {
            id: "prompt-loop",
            type: "promptNode",
            x: 80,
            y: 220,
            width: 320,
            height: 150,
            data: {
              label: "Code Generation Prompt",
              prompt: "Create a loop utility class with exponential backoff algorithm in TypeScript.",
            },
          },
          {
            id: "action-loop",
            type: "actionContainerNode",
            x: 480,
            y: 180,
            width: 340,
            height: 240,
            data: {
              label: "Build & Verification Suite",
              description: "Runs code checks and verification script before committing.",
              actions: ["Format Code", "Lint Checks", "Run Unit Tests"],
            },
          },
          {
            id: "terminal-loop",
            type: "terminalNode",
            x: 900,
            y: 200,
            width: 320,
            height: 190,
            data: {
              label: "Tauri Compilation Target",
              command: "echo 'Build verified' && exit 0",
              isRunning: false,
              status: "idle",
            },
          },
        ],
        edges: [
          {
            id: "e-prompt-action-loop",
            source: "prompt-loop",
            sourceHandle: "output",
            target: "action-loop",
            targetHandle: "input",
          },
          {
            id: "e-action-terminal-loop",
            source: "action-loop",
            sourceHandle: "output",
            target: "terminal-loop",
            targetHandle: "trigger",
          },
        ],
      });
    } else if (presetName === "Review Pipeline") {
      set({
        nodes: [
          {
            id: "prompt-review",
            type: "promptNode",
            x: 80,
            y: 150,
            width: 320,
            height: 150,
            data: {
              label: "Agent Review Guidelines",
              prompt: "Ensure the code adheres to clean architecture, has 90%+ test coverage and uses standard types.",
            },
          },
          {
            id: "action-review",
            type: "actionContainerNode",
            x: 480,
            y: 120,
            width: 340,
            height: 240,
            data: {
              label: "Verification Checks",
              description: "Linting, static analysis, and code quality controls.",
              actions: ["Check clean architecture rules", "Verify types and constraints"],
            },
          },
          {
            id: "terminal-review",
            type: "terminalNode",
            x: 900,
            y: 140,
            width: 320,
            height: 190,
            data: {
              label: "Static Analyzer Output",
              command: "echo 'Static analysis complete' && exit 0",
              isRunning: false,
              status: "idle",
            },
          },
        ],
        edges: [
          {
            id: "e-prompt-action-review",
            source: "prompt-review",
            sourceHandle: "output",
            target: "action-review",
            targetHandle: "input",
          },
          {
            id: "e-action-terminal-review",
            source: "action-review",
            sourceHandle: "output",
            target: "terminal-review",
            targetHandle: "trigger",
          },
        ],
      });
    }
  },

  runPipeline: async () => {
    if (get().isPipelineRunning) return;

    get().resetExecutionState();
    set({ isPipelineRunning: true });

    const { nodes, edges } = get();
    try {
      await invoke("execute_graph", {
        nodes: nodes.map((n) => ({ id: n.id, type: n.type, data: n.data })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      });
    } catch (err) {
      console.error("Failed to start pipeline execution:", err);
      set({ isPipelineRunning: false });
    }
  },

  setNodeStatus: (id, status) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, status } } : n
      ),
    })),

  setEdgeExecStateForTarget: (targetNodeId, execState) =>
    set((state) => {
      const next = { ...state.edgeExecState };
      state.edges.forEach((e) => {
        if (e.target === targetNodeId) next[e.id] = execState;
      });
      return { edgeExecState: next };
    }),

  setCableDiffStat: (sourceNodeId, targetNodeId, stat) =>
    set((state) => {
      const next = { ...state.cableDiffStats };
      state.edges.forEach((e) => {
        if (e.source === sourceNodeId && e.target === targetNodeId) next[e.id] = stat;
      });
      return { cableDiffStats: next };
    }),

  resetExecutionState: () =>
    set((state) => ({
      edgeExecState: {},
      cableDiffStats: {},
      nodes: state.nodes.map((n) => ({ ...n, data: { ...n.data, status: "idle" as const } })),
    })),

  setPipelineRunning: (running) => set({ isPipelineRunning: running }),
}));
