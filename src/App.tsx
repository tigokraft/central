import React, { useState, useCallback } from "react";
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
  BackgroundVariant
} from "@xyflow/react";
import Topbar from "./components/Topbar";
import Sidebar from "./components/Sidebar";
import TerminalNode from "./components/TerminalNode";
import ActionContainerNode from "./components/ActionContainerNode";
import PromptNode from "./components/PromptNode";

// Register custom node types
const nodeTypes = {
  terminalNode: TerminalNode,
  actionContainerNode: ActionContainerNode,
  promptNode: PromptNode,
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
      <div className="absolute top-20 right-6 pointer-events-none select-none z-0">
        <div className="text-[120px] font-bold text-slate-800/10 font-mono tracking-wider">
          CENTRAL
        </div>
      </div>
    </div>
  );
}
