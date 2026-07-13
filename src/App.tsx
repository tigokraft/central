import React, { useState, useCallback, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  ReactFlowProvider,
  BackgroundVariant,
  useReactFlow
} from "@xyflow/react";
import Topbar from "./components/Topbar";
import Sidebar from "./components/Sidebar";
import TerminalNode from "./components/TerminalNode";
import ActionContainerNode from "./components/ActionContainerNode";
import PromptNode from "./components/PromptNode";
import MemoryGraphNote from "./components/MemoryGraphNote";
import { Terminal, Box, MessageSquare, Brain } from "lucide-react";

// Register custom node types
const nodeTypes = {
  terminalNode: TerminalNode,
  actionContainerNode: ActionContainerNode,
  promptNode: PromptNode,
  memoryGraphNote: MemoryGraphNote,
};

const initialNodes: Node[] = [
  {
    id: "prompt-1",
    type: "promptNode",
    data: {
      label: "Prompt Input",
      prompt: "Refactor terminal rendering to support dynamic dimensions and automatic fit resizing.",
    },
    position: { x: 100, y: 200 },
  },
  {
    id: "action-1",
    type: "actionContainerNode",
    data: {
      label: "Action Container Pipeline",
      description: "Validation check and source formatting process pipeline.",
      actions: ["npm run lint", "npm run format", "pnpm test"],
    },
    position: { x: 500, y: 150 },
  },
  {
    id: "terminal-1",
    type: "terminalNode",
    data: {
      label: "Tauri Compiler Console",
      command: "pnpm tauri dev",
      isRunning: false,
    },
    position: { x: 920, y: 170 },
  },
];

const initialEdges: Edge[] = [
  {
    id: "e-prompt-action",
    source: "prompt-1",
    sourceHandle: "output",
    target: "action-1",
    targetHandle: "input",
    animated: true,
    style: { stroke: "#10b981", strokeWidth: 2 },
  },
  {
    id: "e-action-terminal",
    source: "action-1",
    sourceHandle: "output",
    target: "terminal-1",
    targetHandle: "trigger",
    animated: true,
    style: { stroke: "#10b981", strokeWidth: 2 },
  },
];

export default function App() {
  const [activeProcesses, setActiveProcesses] = useState<{ id: string; label: string; isRunning: boolean }[]>([]);
  const [onLoadPreset, setOnLoadPreset] = useState<(preset: string) => void>(() => () => {});

  const handleRegisterOnLoadPreset = useCallback((callback: (presetName: string) => void) => {
    setOnLoadPreset(() => callback);
  }, []);

  return (
    <ReactFlowProvider>
      <div className="flex h-screen w-screen bg-slate-950 text-slate-50 font-sans overflow-hidden">
        <Sidebar
          onLoadPreset={onLoadPreset}
          activeProcesses={activeProcesses}
        />
        <FlowWrapper
          setActiveProcesses={setActiveProcesses}
          registerOnLoadPreset={handleRegisterOnLoadPreset}
        />
      </div>
    </ReactFlowProvider>
  );
}

interface FlowWrapperProps {
  setActiveProcesses: React.Dispatch<React.SetStateAction<{ id: string; label: string; isRunning: boolean }[]>>;
  registerOnLoadPreset: (cb: (presetName: string) => void) => void;
}

function FlowWrapper({ setActiveProcesses, registerOnLoadPreset }: FlowWrapperProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [showMinimap, setShowMinimap] = useState(true);
  const { screenToFlowPosition } = useReactFlow();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Close context menu when user clicks anywhere in the window
  useEffect(() => {
    const handleClose = () => setContextMenu(null);
    window.addEventListener("click", handleClose);
    return () => window.removeEventListener("click", handleClose);
  }, []);

  const handleAddNode = useCallback(
    (type: "terminalNode" | "actionContainerNode" | "promptNode" | "memoryGraphNote") => {
      if (!contextMenu) return;

      const position = screenToFlowPosition({
        x: contextMenu.x,
        y: contextMenu.y,
      });

      let label = "";
      let data: any = {};

      switch (type) {
        case "terminalNode":
          label = "Terminal Console";
          data = { label, command: "echo hello", isRunning: false };
          break;
        case "actionContainerNode":
          label = "Pipeline Container";
          data = {
            label,
            description: "Custom pipeline tasks.",
            actions: ["npm run lint", "pnpm test"],
          };
          break;
        case "promptNode":
          label = "Prompt Input";
          data = { label, prompt: "Enter instructions here..." };
          break;
        case "memoryGraphNote":
          label = "Memory Graph Note";
          data = { label, note: "Key recollections and records..." };
          break;
      }

      const newNode: Node = {
        id: `${type}-${Date.now()}`,
        type,
        position,
        data,
      };

      setNodes((nds) => [...nds, newNode]);
      setContextMenu(null);
    },
    [contextMenu, screenToFlowPosition, setNodes]
  );

  // Sync active processes with Sidebar
  React.useEffect(() => {
    const list = nodes
      .filter((n) => n.type === "terminalNode")
      .map((n) => ({
        id: n.id,
        label: n.data.label as string,
        isRunning: !!n.data.isRunning,
      }));
    setActiveProcesses(list);
  }, [nodes, setActiveProcesses]);

  const onConnect = useCallback(
    (params: Connection) =>
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            animated: true,
            style: { stroke: "#10b981", strokeWidth: 2 },
          },
          eds
        )
      ),
    [setEdges]
  );

  const handleRunGraph = useCallback(() => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.type === "terminalNode") {
          return {
            ...node,
            data: { ...node.data, isRunning: true },
          };
        }
        return node;
      })
    );

    // Simulate completion
    setTimeout(() => {
      setNodes((nds) =>
        nds.map((node) => {
          if (node.type === "terminalNode") {
            return {
              ...node,
              data: { ...node.data, isRunning: false },
            };
          }
          return node;
        })
      );
    }, 4000);
  }, [setNodes]);

  const handleLoadPreset = useCallback(
    (presetName: string) => {
      if (presetName === "Code Loop") {
        const loopNodes: Node[] = [
          {
            id: "prompt-loop",
            type: "promptNode",
            data: {
              label: "Code Generation Prompt",
              prompt: "Create a loop utility class with exponential backoff algorithm in TypeScript.",
            },
            position: { x: 80, y: 220 },
          },
          {
            id: "action-loop",
            type: "actionContainerNode",
            data: {
              label: "Build & Verification Suite",
              description: "Runs code checks and verification script before committing.",
              actions: ["Format Code", "Lint Checks", "Run Unit Tests"],
            },
            position: { x: 480, y: 180 },
          },
          {
            id: "terminal-loop",
            type: "terminalNode",
            data: {
              label: "Tauri Compilation Target",
              command: "pnpm tauri dev",
              isRunning: false,
            },
            position: { x: 900, y: 200 },
          },
        ];

        const loopEdges: Edge[] = [
          {
            id: "e-prompt-action-loop",
            source: "prompt-loop",
            sourceHandle: "output",
            target: "action-loop",
            targetHandle: "input",
            animated: true,
            style: { stroke: "#10b981", strokeWidth: 2 },
          },
          {
            id: "e-action-terminal-loop",
            source: "action-loop",
            sourceHandle: "output",
            target: "terminal-loop",
            targetHandle: "trigger",
            animated: true,
            style: { stroke: "#10b981", strokeWidth: 2 },
          },
        ];

        setNodes(loopNodes);
        setEdges(loopEdges);
      } else if (presetName === "Review Pipeline") {
        const reviewNodes: Node[] = [
          {
            id: "prompt-review",
            type: "promptNode",
            data: {
              label: "Agent Review Guidelines",
              prompt: "Ensure the code adheres to clean architecture, has 90%+ test coverage and uses standard types.",
            },
            position: { x: 80, y: 150 },
          },
          {
            id: "action-review",
            type: "actionContainerNode",
            data: {
              label: "Verification Checks",
              description: "Linting, static analysis, and code quality controls.",
              actions: ["Check clean architecture rules", "Verify types and constraints"],
            },
            position: { x: 480, y: 120 },
          },
          {
            id: "terminal-review",
            type: "terminalNode",
            data: {
              label: "Static Analyzer Output",
              command: "cargo clippy",
              isRunning: false,
            },
            position: { x: 900, y: 140 },
          },
        ];

        const reviewEdges: Edge[] = [
          {
            id: "e-prompt-action-review",
            source: "prompt-review",
            sourceHandle: "output",
            target: "action-review",
            targetHandle: "input",
            animated: true,
            style: { stroke: "#10b981", strokeWidth: 2 },
          },
          {
            id: "e-action-terminal-review",
            source: "action-review",
            sourceHandle: "output",
            target: "terminal-review",
            targetHandle: "trigger",
            animated: true,
            style: { stroke: "#10b981", strokeWidth: 2 },
          },
        ];

        setNodes(reviewNodes);
        setEdges(reviewEdges);
      }
    },
    [setNodes, setEdges]
  );

  React.useEffect(() => {
    registerOnLoadPreset(handleLoadPreset);
  }, [handleLoadPreset, registerOnLoadPreset]);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-slate-900 relative">
      <Topbar
        showMinimap={showMinimap}
        setShowMinimap={setShowMinimap}
        onRunGraph={handleRunGraph}
      />
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          className="bg-slate-900"
          onPaneContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
          }}
          onPaneClick={() => setContextMenu(null)}
          onNodeDragStart={() => setContextMenu(null)}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#334155" />
          <Controls className="bg-slate-950 border border-slate-800 text-slate-200 fill-slate-200" style={{ left: 16 }} />
          {showMinimap && (
            <MiniMap
              className="bg-slate-950/80 border border-slate-800 rounded-lg overflow-hidden"
              nodeColor="#1e293b"
              maskColor="rgba(2, 6, 23, 0.7)"
              style={{ height: 100, width: 150 }}
            />
          )}
        </ReactFlow>
      </div>

      {contextMenu && (
        <div
          className="fixed z-50 bg-slate-950/95 backdrop-blur-md border border-slate-800 rounded-lg shadow-2xl py-1.5 w-52 select-none"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleAddNode("terminalNode")}
            className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
          >
            <Terminal size={12} className="text-emerald-500" />
            Add Terminal Node
          </button>
          <button
            onClick={() => handleAddNode("actionContainerNode")}
            className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
          >
            <Box size={12} className="text-blue-500" />
            Add Action Container
          </button>
          <button
            onClick={() => handleAddNode("promptNode")}
            className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
          >
            <MessageSquare size={12} className="text-purple-500" />
            Add Prompt Node
          </button>
          <button
            onClick={() => handleAddNode("memoryGraphNote")}
            className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition-colors flex items-center gap-2 cursor-pointer"
          >
            <Brain size={12} className="text-pink-500" />
            Add Memory Graph Note
          </button>
        </div>
      )}
      <div className="absolute top-20 right-6 pointer-events-none select-none z-0">
        <div className="text-[120px] font-bold text-slate-800/10 font-mono tracking-wider">
          CENTRAL
        </div>
      </div>
    </div>
  );
}
