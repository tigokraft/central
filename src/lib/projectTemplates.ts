import type { CanvasEdge, CanvasNode, Viewport } from "../store/canvasStore";

// Unique id per instantiation (not module load) — a template can be picked more than once
// across the app's lifetime, so ids must not collide with each other or with nodes the
// canvas store creates itself via its own nodeSeq counter.
function templateNodeId(prefix: string): string {
  return `${prefix}-tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  build: () => { nodes: CanvasNode[]; edges: CanvasEdge[]; viewport: Viewport };
}

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

// Curated starting points offered by the Home page's "New Project" flow. Every template is
// an empty scaffold — unfilled prompts, placeholder checklist items, idle terminals — never
// pre-filled fake output, so a new project never looks like it's mid-run.
export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    description: "An empty canvas. Start from scratch.",
    build: () => ({ nodes: [], edges: [], viewport: DEFAULT_VIEWPORT }),
  },
  {
    id: "code-review-pipeline",
    name: "Code Review Pipeline",
    description: "A prompt feeding a checklist of review gates.",
    build: () => {
      const promptId = templateNodeId("promptNode");
      const containerId = templateNodeId("actionContainerNode");

      const nodes: CanvasNode[] = [
        {
          id: promptId,
          type: "promptNode",
          x: 80,
          y: 140,
          width: 320,
          height: 150,
          data: { label: "Review Instructions", prompt: "" },
        },
        {
          id: containerId,
          type: "actionContainerNode",
          x: 480,
          y: 100,
          width: 340,
          height: 240,
          data: {
            label: "Review Checks",
            description: "Automated checks that run before this PR merges.",
            actions: ["Add your first check..."],
          },
        },
      ];

      const edges: CanvasEdge[] = [
        {
          id: templateNodeId("edge"),
          source: promptId,
          sourceHandle: "output",
          target: containerId,
          targetHandle: "input",
        },
      ];

      return { nodes, edges, viewport: DEFAULT_VIEWPORT };
    },
  },
  {
    id: "feature-build-squad",
    name: "Feature Build Squad",
    description: "A spec prompt driving a coder, reviewer, and test-runner in sequence.",
    build: () => {
      const promptId = templateNodeId("promptNode");
      const frameId = templateNodeId("actionFrameNode");
      const coderId = templateNodeId("terminalNode");
      const reviewerId = templateNodeId("terminalNode");
      const testRunnerId = templateNodeId("terminalNode");

      const nodes: CanvasNode[] = [
        {
          id: promptId,
          type: "promptNode",
          x: 60,
          y: 190,
          width: 320,
          height: 150,
          data: { label: "Feature Spec", prompt: "" },
        },
        {
          id: frameId,
          type: "actionFrameNode",
          x: 460,
          y: 40,
          width: 700,
          height: 280,
          data: { label: "Build Squad", description: "Coder, reviewer, and test-runner working together." },
        },
        {
          id: coderId,
          type: "terminalNode",
          x: 500,
          y: 110,
          width: 200,
          height: 190,
          parentId: frameId,
          data: { label: "Coder", command: "", isRunning: false, status: "idle", role: "coder", displayMode: "quiet" },
        },
        {
          id: reviewerId,
          type: "terminalNode",
          x: 720,
          y: 110,
          width: 200,
          height: 190,
          parentId: frameId,
          data: { label: "Reviewer", command: "", isRunning: false, status: "idle", role: "reviewer", displayMode: "quiet" },
        },
        {
          id: testRunnerId,
          type: "terminalNode",
          x: 940,
          y: 110,
          width: 200,
          height: 190,
          parentId: frameId,
          data: {
            label: "Test Runner",
            command: "",
            isRunning: false,
            status: "idle",
            role: "test-runner",
            displayMode: "quiet",
          },
        },
      ];

      const edges: CanvasEdge[] = [
        { id: templateNodeId("edge"), source: promptId, sourceHandle: "output", target: coderId, targetHandle: "trigger" },
        { id: templateNodeId("edge"), source: coderId, sourceHandle: "done", target: reviewerId, targetHandle: "trigger" },
        { id: templateNodeId("edge"), source: reviewerId, sourceHandle: "done", target: testRunnerId, targetHandle: "trigger" },
      ];

      return { nodes, edges, viewport: DEFAULT_VIEWPORT };
    },
  },
];
