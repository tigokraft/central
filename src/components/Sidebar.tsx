import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Zap,
  Activity,
  ChevronLeft,
  Terminal as TerminalIcon,
  Rocket,
  Plug,
  Sparkles
} from "lucide-react";
import DeploymentsTracker from "./sidebar/DeploymentsTracker";
import McpServersPanel from "./sidebar/McpServersPanel";
import EphemeralRunsPanel from "./sidebar/EphemeralRunsPanel";

interface SidebarProps {
  activeProcesses: { id: string; label: string; isRunning: boolean }[];
}

export default function Sidebar({ activeProcesses }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(true);
  const [deploymentsOpen, setDeploymentsOpen] = useState(true);
  const [mcpOpen, setMcpOpen] = useState(true);
  const [ephemeralOpen, setEphemeralOpen] = useState(true);

  return (
    <div
      className={`bg-slate-950 border-r border-slate-800 flex flex-col h-full transition-all duration-300 relative select-none z-10 ${
        isCollapsed ? "w-14" : "w-64"
      }`}
    >
      {/* Collapse/Expand Toggle Button */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="absolute -right-3 top-4 bg-slate-900 border border-slate-700 hover:border-emerald-500 rounded-full p-1 text-slate-400 hover:text-slate-200 transition-colors z-20 cursor-pointer"
      >
        {isCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>

      {/* Sidebar Header */}
      <div className="h-14 border-b border-slate-800 flex items-center gap-2.5 px-4 shrink-0 overflow-hidden">
        <Zap className="text-emerald-500 shrink-0" size={18} />
        {!isCollapsed && (
          <span className="font-semibold text-sm tracking-wide text-slate-100">
            Central
          </span>
        )}
      </div>

      {/* Sections Container */}
      <div className="flex-1 overflow-y-auto py-4 px-2 space-y-4">
        {isCollapsed ? (
          <div className="flex flex-col items-center gap-4 py-2 text-slate-500">
            <div title="Process Monitor"><Activity size={18} className="hover:text-emerald-400 cursor-pointer" /></div>
            <div title="Deployments"><Rocket size={18} className="hover:text-emerald-400 cursor-pointer" /></div>
            <div title="MCP Servers"><Plug size={18} className="hover:text-emerald-400 cursor-pointer" /></div>
            <div title="Ephemeral Runs"><Sparkles size={18} className="hover:text-emerald-400 cursor-pointer" /></div>
          </div>
        ) : (
          <>
            {/* Process Monitor */}
            <div className="space-y-1">
              <button
                onClick={() => setMonitorOpen(!monitorOpen)}
                className="w-full flex items-center justify-between text-xs font-semibold text-slate-400 hover:text-slate-200 px-2 py-1 cursor-pointer"
              >
                <span className="flex items-center gap-1.5 uppercase tracking-wider text-[10px]">
                  <Activity size={12} className="text-emerald-500" />
                  Process Monitor
                </span>
                {monitorOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>

              {monitorOpen && (
                <div className="space-y-1.5 py-1 font-mono text-[10px]">
                  {activeProcesses.length === 0 ? (
                    <div className="text-slate-600 italic px-2">No active processes.</div>
                  ) : (
                    activeProcesses.map((proc) => (
                      <div
                        key={proc.id}
                        className="flex items-center justify-between bg-slate-900/40 border border-slate-800 rounded p-1.5"
                      >
                        <span className="flex items-center gap-1.5 text-slate-300">
                          <TerminalIcon size={10} className="text-slate-500" />
                          {proc.label}
                        </span>
                        <span className="flex items-center gap-1">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              proc.isRunning ? "bg-emerald-500 animate-pulse" : "bg-yellow-500"
                            }`}
                          />
                          <span className="text-[8px] text-slate-500 uppercase ml-1">
                            {proc.isRunning ? "running" : "idle"}
                          </span>
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Ephemeral Runs Archive */}
            <div className="space-y-1">
              <button
                onClick={() => setEphemeralOpen(!ephemeralOpen)}
                className="w-full flex items-center justify-between text-xs font-semibold text-slate-400 hover:text-slate-200 px-2 py-1 cursor-pointer"
              >
                <span className="flex items-center gap-1.5 uppercase tracking-wider text-[10px]">
                  <Sparkles size={12} className="text-emerald-500" />
                  Ephemeral Runs
                </span>
                {ephemeralOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>

              {ephemeralOpen && <EphemeralRunsPanel />}
            </div>

            {/* Deployments & Staging HUD */}
            <div className="space-y-1">
              <button
                onClick={() => setDeploymentsOpen(!deploymentsOpen)}
                className="w-full flex items-center justify-between text-xs font-semibold text-slate-400 hover:text-slate-200 px-2 py-1 cursor-pointer"
              >
                <span className="flex items-center gap-1.5 uppercase tracking-wider text-[10px]">
                  <Rocket size={12} className="text-emerald-500" />
                  Deployments
                </span>
                {deploymentsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>

              {deploymentsOpen && <DeploymentsTracker />}
            </div>

            {/* MCP Servers */}
            <div className="space-y-1">
              <button
                onClick={() => setMcpOpen(!mcpOpen)}
                className="w-full flex items-center justify-between text-xs font-semibold text-slate-400 hover:text-slate-200 px-2 py-1 cursor-pointer"
              >
                <span className="flex items-center gap-1.5 uppercase tracking-wider text-[10px]">
                  <Plug size={12} className="text-emerald-500" />
                  MCP Servers
                </span>
                {mcpOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>

              {mcpOpen && <McpServersPanel />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
