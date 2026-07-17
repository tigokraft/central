import { create } from "zustand";
import { temporal } from "zundo";
import { invoke } from "@tauri-apps/api/core";
import { computeFitViewport, getNodesBounds } from "../lib/canvasGeometry";
import { viewportController, clampZoom } from "../lib/viewportController";

const HISTORY_LIMIT = 100;

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

export type TerminalContextMode = "isolated" | "memory-aware";

// A fact manually attached to a terminal node via the "Attach .aimem Fact" HUD button,
// as opposed to one supplied live by a cabled MemoryNode (tracked by attachedMemoryIds).
export interface AttachedFact {
  id: string;
  content: string;
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
    contextMode?: TerminalContextMode;
    attachedMemoryIds?: string[];
    attachedFacts?: AttachedFact[];
    minimized?: boolean;
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
    if (handleId === "context") {
      // Left-middle socket dedicated to MemoryNode context cables.
      return { x: node.x, y: node.y + node.height / 2 };
    }
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

// Given the set of explicitly-dragged/selected node ids, resolves the full set of node ids
// that should actually move together: a node whose parent is also in `nodesToMove` is left
// alone (its parent's own move already accounts for it), while a node that isn't explicitly
// moved but whose parent is gets carried along. Shared by updateNodePosition and
// nodeDragController so both agree on exactly which nodes a drag gesture affects.
export function resolveMovingIds(nodesToMove: string[], allNodes: CanvasNode[]): Set<string> {
  const toMoveSet = new Set(nodesToMove);
  const moving = new Set<string>();
  for (const n of allNodes) {
    if (toMoveSet.has(n.id)) {
      if (n.parentId && toMoveSet.has(n.parentId)) continue;
      moving.add(n.id);
    } else if (n.parentId && toMoveSet.has(n.parentId)) {
      moving.add(n.id);
    }
  }
  return moving;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

// Starting graph handed to hydrateFromProject() when a brand-new project is created (see
// HomeView's "New Project" flow). Not a permanent boot state — the store itself boots empty
// since the app now lands on the Home view, not directly into a canvas.
export const NEW_PROJECT_TEMPLATE: { nodes: CanvasNode[]; edges: CanvasEdge[]; viewport: Viewport } = {
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
  viewport: { x: 0, y: 0, zoom: 1 },
};

interface CanvasState {
  viewport: Viewport;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  // Id of the project currently persisted to disk; null until a project has been opened
  // (e.g. still on the Home view). Drives the autosave subscribe below.
  activeProjectId: string | null;
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
  zoomToFit: (nodeIds?: string[]) => void;
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

  // Persistence
  hydrateFromProject: (
    projectId: string,
    graph: { nodes: CanvasNode[]; edges: CanvasEdge[]; viewport: Viewport }
  ) => void;

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

  // Figma-style alignment guide lines shown while dragging a node; null when not dragging.
  dragGuides: { vertical: number[]; horizontal: number[] } | null;
  setDragGuides: (guides: { vertical: number[]; horizontal: number[] } | null) => void;
}

export const useCanvasStore = create<CanvasState>()(
  temporal(
    (set, get) => ({
  selectedNodeIds: [],
  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

  dragGuides: null,
  setDragGuides: (guides) => set({ dragGuides: guides }),

  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
  activeProjectId: null,
  activeTool: "select",
  draggingEdge: null,
  pointerCanvasPosition: null,
  edgeExecState: {},
  cableDiffStats: {},
  isPipelineRunning: false,

  // Viewport mutations are delegated to viewportController, which owns the "live" value and
  // writes the transformed DOM node directly every frame (see InfiniteCanvas.tsx); `state
  // .viewport` here is just a trailing-debounced mirror of that for reactive consumers
  // (Minimap, zoom% readouts) that don't need per-frame precision. See viewportController.ts.
  setViewport: (vp) => {
    const current = viewportController.getViewport();
    viewportController.setInstant({ ...current, ...vp });
  },

  panViewport: (dx, dy) => {
    const current = viewportController.getViewport();
    viewportController.setInstant({ ...current, x: current.x + dx, y: current.y + dy });
  },

  // Called both by the wheel handler (ctrl+wheel/pinch — always passes a mouse focal point
  // and must track it 1:1, no easing) and by the Toolbar/Topbar +/- buttons (no focal point
  // — eases into the new zoom level like Figma's toolbar zoom).
  zoomViewport: (factor, mouseX, mouseY) => {
    const current = viewportController.getViewport();
    const zoom = clampZoom(current.zoom * factor);
    if (mouseX !== undefined && mouseY !== undefined) {
      const dx = mouseX - current.x;
      const dy = mouseY - current.y;
      viewportController.setInstant({
        zoom,
        x: mouseX - dx * (zoom / current.zoom),
        y: mouseY - dy * (zoom / current.zoom),
      });
    } else {
      viewportController.animateTo({ ...current, zoom });
    }
  },

  // Frames the given nodes (or every node when nodeIds is omitted/empty) in the visible
  // canvas area. Reads the live container rect rather than tracked dimensions state so it
  // works from anywhere (Toolbar, Topbar, keyboard shortcuts) without prop-drilling.
  zoomToFit: (nodeIds) => {
    const state = get();
    const targets =
      nodeIds && nodeIds.length > 0 ? state.nodes.filter((n) => nodeIds.includes(n.id)) : state.nodes;
    const bounds = getNodesBounds(targets);
    if (!bounds) return;

    const container = document.getElementById("canvas-container");
    const rect = container?.getBoundingClientRect();
    const width = rect?.width ?? window.innerWidth;
    const height = rect?.height ?? window.innerHeight;

    viewportController.animateTo(computeFitViewport(bounds, width, height));
  },

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

    beginHistoryBatch();
    set((state) => ({
      nodes: [...state.nodes, newNode],
    }));
    endHistoryBatch();

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
      const moving = resolveMovingIds(nodesToMove, state.nodes);

      return {
        nodes: state.nodes.map((n) => (moving.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
      };
    }),

  updateNodeDimensions: (id, width, height) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, width, height } : n
      ),
    })),

  // Not wrapped in a history batch itself: this is called both for direct user edits (title
  // renames, toggles) and for automatic system-driven updates (PTY status, streaming output,
  // minimize state) that fire continuously and aren't meaningful undo steps. Call sites that
  // represent a real user action wrap themselves in beginHistoryBatch()/endHistoryBatch().
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

  deleteNode: (id) => {
    beginHistoryBatch();
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== id).map((n) => n.parentId === id ? { ...n, parentId: undefined } : n),
      edges: state.edges.filter((e) => e.source !== id && e.target !== id),
    }));
    endHistoryBatch();
  },

  attachMcpTool: (nodeId, tool) => {
    beginHistoryBatch();
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const existing = n.data.attachedTools || [];
        if (existing.some((t) => t.serverId === tool.serverId && t.toolName === tool.toolName)) return n;
        return { ...n, data: { ...n.data, attachedTools: [...existing, tool] } };
      }),
    }));
    endHistoryBatch();
  },

  detachMcpTool: (nodeId, tool) => {
    beginHistoryBatch();
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
    }));
    endHistoryBatch();
  },

  ephemeralArchive: [],
  archiveEphemeralRun: (entry) =>
    set((state) => ({
      ephemeralArchive: [entry, ...state.ephemeralArchive].slice(0, 30),
    })),

  addEdge: (sourceId, sourceHandle, targetId, targetHandle) => {
    beginHistoryBatch();
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

      // Dragging a cable from a MemoryNode into a terminal's dedicated "context" socket
      // attaches that memory record to the node, so its facts can prefix future commands.
      const sourceNode = state.nodes.find((n) => n.id === sourceId);
      const targetNode = state.nodes.find((n) => n.id === targetId);
      const isMemoryContextLink =
        sourceNode?.type === "memoryNode" &&
        targetNode?.type === "terminalNode" &&
        targetHandle === "context";

      const nodes = isMemoryContextLink
        ? state.nodes.map((n) => {
            if (n.id !== targetId) return n;
            const existingIds = n.data.attachedMemoryIds || [];
            if (existingIds.includes(sourceId)) return n;
            return { ...n, data: { ...n.data, attachedMemoryIds: [...existingIds, sourceId] } };
          })
        : state.nodes;

      return {
        nodes,
        edges: [...state.edges, newEdge],
      };
    });
    endHistoryBatch();
  },

  deleteEdge: (id) => {
    beginHistoryBatch();
    set((state) => {
      const removed = state.edges.find((e) => e.id === id);
      const nodes =
        removed && removed.targetHandle === "context"
          ? state.nodes.map((n) =>
              n.id === removed.target
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      attachedMemoryIds: (n.data.attachedMemoryIds || []).filter(
                        (memId) => memId !== removed.source
                      ),
                    },
                  }
                : n
            )
          : state.nodes;

      return {
        nodes,
        edges: state.edges.filter((e) => e.id !== id),
      };
    });
    endHistoryBatch();
  },

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

  // Replaces the entire canvas with a persisted project's graph (called by Phase 3c's
  // openProject flow). Resets all transient/derived state so nothing from the previously
  // open project (selection, in-flight drags, execution status) leaks into the new one, and
  // clears undo history since past states referred to the old project's nodes/edges.
  hydrateFromProject: (projectId, graph) => {
    viewportController.setInstant(graph.viewport);
    set({
      activeProjectId: projectId,
      nodes: graph.nodes,
      edges: graph.edges,
      viewport: graph.viewport,
      selectedNodeIds: [],
      draggingEdge: null,
      pointerCanvasPosition: null,
      edgeExecState: {},
      cableDiffStats: {},
      isPipelineRunning: false,
      ephemeralArchive: [],
      activeTool: "select",
      dragGuides: null,
    });
    useCanvasStore.temporal.getState().clear();
  },

  loadPreset: (presetName) => {
    beginHistoryBatch();
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
    endHistoryBatch();
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
    }),
    {
      // Only nodes/edges are undoable — viewport, selection, drag state, and execution
      // status are transient/derived and would just add noise to the history stack.
      partialize: (state) => ({ nodes: state.nodes, edges: state.edges }),
      limit: HISTORY_LIMIT,
    }
  )
);

// viewportController owns the live viewport; this makes `state.viewport` a trailing-debounced
// mirror of it, kept in sync via setState (bypassing zundo's undo tracking entirely — the
// temporal middleware only sees nodes/edges via partialize above, so this never touches it).
viewportController.init(useCanvasStore.getState().viewport, (vp) =>
  useCanvasStore.setState({ viewport: vp })
);

const AUTOSAVE_DEBOUNCE_MS = 2000;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

async function persistActiveProject() {
  const { activeProjectId, nodes, edges, viewport } = useCanvasStore.getState();
  if (!activeProjectId) return;
  try {
    await invoke("save_project_graph", {
      projectId: activeProjectId,
      graph: { nodes, edges, viewport },
    });
  } catch (err) {
    console.error("Failed to autosave project:", err);
  }
}

// Debounced autosave: any nodes/edges mutation while a project is open schedules a write to
// that project's graph.json ~2s after the last change, coalescing bursts (drags, streaming
// node updates) into a single save.
useCanvasStore.subscribe((state, prevState) => {
  if (!state.activeProjectId) return;
  if (state.nodes === prevState.nodes && state.edges === prevState.edges) return;

  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void persistActiveProject();
  }, AUTOSAVE_DEBOUNCE_MS);
});

// zundo's automatic per-set() tracking is deliberately disabled here (see below) — every
// action in this store rebuilds `nodes`/`edges` via .map()/spread even when nothing
// relevant actually changed (e.g. a no-op reparent), so array-reference equality can't
// reliably distinguish "real change" from "no-op" at that layer. Instead, every store
// action that should be undoable explicitly wraps its mutation in
// beginHistoryBatch()/endHistoryBatch(), which snapshots nodes/edges before and after and
// pushes exactly one manual history entry if — and only if — they actually differ. This
// also naturally collapses a whole drag/resize gesture (many intermediate updates) into a
// single undo step instead of one entry per pointer-move.
useCanvasStore.temporal.getState().pause();

let pendingBatchSnapshot: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null = null;
let batchDepth = 0;

export function beginHistoryBatch() {
  // Nested calls (e.g. an action that itself calls another undoable action) collapse into
  // the outermost batch instead of overwriting its snapshot or double-pushing on exit.
  if (batchDepth === 0) {
    const { nodes, edges } = useCanvasStore.getState();
    pendingBatchSnapshot = { nodes, edges };
  }
  batchDepth++;
}

export function endHistoryBatch() {
  batchDepth = Math.max(0, batchDepth - 1);
  if (batchDepth > 0) return;

  const pre = pendingBatchSnapshot;
  pendingBatchSnapshot = null;
  if (!pre) return;

  const { nodes, edges } = useCanvasStore.getState();
  if (pre.nodes === nodes && pre.edges === edges) return; // nothing actually changed

  useCanvasStore.temporal.setState((s) => ({
    pastStates: [...s.pastStates, pre].slice(-HISTORY_LIMIT),
    futureStates: [],
  }));
}
