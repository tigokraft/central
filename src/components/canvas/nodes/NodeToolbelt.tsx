import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Wrench, X, Check } from "lucide-react";
import { useCanvasStore, AttachedMcpTool } from "../../../store/canvasStore";
import { useMcpStore } from "../../../store/mcpStore";
import { useProviderStore, PROVIDER_LABELS, PROVIDER_MODELS, ProviderId } from "../../../store/providerStore";

interface NodeToolbeltProps {
  nodeId: string;
}

// Stable reference so the zustand selector below never returns a fresh array when a node has
// no attached tools yet (a `|| []` fallback would return a new array every read and trip
// useSyncExternalStore's "getSnapshot should be cached" loop guard).
const EMPTY_ATTACHED_TOOLS: AttachedMcpTool[] = [];

// Compact per-node control: pick which provider/model powers this node, and attach specific
// MCP tools from any currently connected server directly to it. The panel is portaled to
// <body> and positioned from the trigger button's real screen rect, since every node card
// clips its contents with overflow-hidden for its rounded corners.
export default function NodeToolbelt({ nodeId }: NodeToolbeltProps) {
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const trigger = triggerRef.current;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      const PANEL_WIDTH = 224;
      setPanelPos({
        top: rect.bottom + 4,
        left: Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8),
      });
    }

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const attachedTools = useCanvasStore(
    (state) => state.nodes.find((n) => n.id === nodeId)?.data.attachedTools ?? EMPTY_ATTACHED_TOOLS
  );
  const attachMcpTool = useCanvasStore((state) => state.attachMcpTool);
  const detachMcpTool = useCanvasStore((state) => state.detachMcpTool);

  const servers = useMcpStore((state) => state.servers);
  const connectedServers = Object.values(servers).filter((s) => s.status === "connected");

  const nodeProviders = useProviderStore((state) => state.nodeProviders);
  const defaultProvider = useProviderStore((state) => state.defaultProvider);
  const defaultModel = useProviderStore((state) => state.defaultModel);
  const setNodeProvider = useProviderStore((state) => state.setNodeProvider);

  const assignment = nodeProviders[nodeId] || { provider: defaultProvider, model: defaultModel };

  const isAttached = (tool: AttachedMcpTool) =>
    attachedTools.some((t) => t.serverId === tool.serverId && t.toolName === tool.toolName);

  const toggleTool = (tool: AttachedMcpTool) => {
    if (isAttached(tool)) detachMcpTool(nodeId, tool);
    else attachMcpTool(nodeId, tool);
  };

  return (
    <div className="relative" data-nodrag>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 p-0.5 hover:bg-slate-800 rounded text-slate-400 hover:text-indigo-400 transition-colors cursor-pointer shrink-0"
        title="Attach MCP tools & choose provider"
      >
        <Wrench size={11} />
        {attachedTools.length > 0 && <span className="text-[8px] font-mono text-indigo-400">{attachedTools.length}</span>}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: "fixed", top: panelPos.top, left: panelPos.left }}
            className="w-56 bg-slate-950 border border-slate-800 rounded-lg shadow-2xl p-2 z-50 space-y-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide">Node Config</span>
              <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-200 cursor-pointer">
                <X size={10} />
              </button>
            </div>

            <div className="space-y-1">
              <div className="text-[8px] text-slate-500 uppercase tracking-wide">Provider</div>
              <select
                value={assignment.provider}
                onChange={(e) => {
                  const provider = e.target.value as ProviderId;
                  setNodeProvider(nodeId, provider, PROVIDER_MODELS[provider][0].id);
                }}
                className="w-full bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-[9px] text-slate-200 focus:outline-none cursor-pointer"
              >
                {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => (
                  <option key={id} value={id}>
                    {PROVIDER_LABELS[id]}
                  </option>
                ))}
              </select>
              <select
                value={assignment.model}
                onChange={(e) => setNodeProvider(nodeId, assignment.provider, e.target.value)}
                className="w-full bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-[9px] text-slate-200 focus:outline-none cursor-pointer"
              >
                {PROVIDER_MODELS[assignment.provider].map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <div className="text-[8px] text-slate-500 uppercase tracking-wide">MCP Tools</div>
              {connectedServers.length === 0 ? (
                <div className="text-[9px] text-slate-600 italic">No MCP servers connected.</div>
              ) : (
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {connectedServers.map((server) =>
                    server.tools.map((tool) => {
                      const attached = isAttached({ serverId: server.serverId, toolName: tool.name });
                      return (
                        <button
                          key={`${server.serverId}-${tool.name}`}
                          onClick={() => toggleTool({ serverId: server.serverId, toolName: tool.name })}
                          className={`w-full flex items-center justify-between gap-1 text-left px-1.5 py-1 rounded text-[9px] font-mono transition-colors cursor-pointer ${
                            attached
                              ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/40"
                              : "bg-slate-900 text-slate-400 border border-slate-800 hover:border-slate-700"
                          }`}
                        >
                          <span className="truncate">
                            {server.serverId}/{tool.name}
                          </span>
                          {attached && <Check size={9} className="shrink-0" />}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
