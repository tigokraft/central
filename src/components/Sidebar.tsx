import { useState } from "react";
import {
  Folder,
  ChevronRight,
  ChevronDown,
  FileCode,
  Zap,
  Activity,
  ChevronLeft,
  Terminal as TerminalIcon,
  Rocket,
  Plug
} from "lucide-react";
import DeploymentsTracker from "./sidebar/DeploymentsTracker";
import McpServersPanel from "./sidebar/McpServersPanel";

interface SidebarProps {
  onLoadPreset: (presetName: string) => void;
  activeProcesses: { id: string; label: string; isRunning: boolean }[];
}

export default function Sidebar({ onLoadPreset, activeProcesses }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [projectOpen, setProjectOpen] = useState(true);
  const [presetsOpen, setPresetsOpen] = useState(true);
  const [monitorOpen, setMonitorOpen] = useState(true);
  const [deploymentsOpen, setDeploymentsOpen] = useState(true);
  const [mcpOpen, setMcpOpen] = useState(true);

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
          <span className="font-bold text-sm tracking-wider bg-gradient-to-r from-slate-100 to-slate-400 bg-clip-text text-transparent">
            NODECODE
          </span>
        )}
      </div>

      {/* Sections Container */}
      <div className="flex-1 overflow-y-auto py-4 px-2 space-y-4">
        {/* Project Explorer */}
        {isCollapsed ? (
          <div className="flex flex-col items-center gap-4 py-2 text-slate-500">
            <div title="Project Explorer"><Folder size={18} className="hover:text-emerald-400 cursor-pointer" /></div>
            <div title="Presets"><Zap size={18} className="hover:text-emerald-400 cursor-pointer" /></div>
            <div title="Process Monitor"><Activity size={18} className="hover:text-emerald-400 cursor-pointer" /></div>
            <div title="Deployments"><Rocket size={18} className="hover:text-emerald-400 cursor-pointer" /></div>
            <div title="MCP Servers"><Plug size={18} className="hover:text-emerald-400 cursor-pointer" /></div>
          </div>
        ) : (
          <>
            {/* Project Explorer Expanded */}
            <div className="space-y-1">
              <button
                onClick={() => setProjectOpen(!projectOpen)}
                className="w-full flex items-center justify-between text-xs font-semibold text-slate-400 hover:text-slate-200 px-2 py-1 cursor-pointer"
              >
                <span className="flex items-center gap-1.5 uppercase tracking-wider text-[10px]">
                  <Folder size={12} className="text-emerald-500" />
                  Project Explorer
                </span>
                {projectOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>

              {projectOpen && (
                <div className="pl-4 space-y-1 text-xs text-slate-400 font-mono py-1">
                  <div className="flex items-center gap-1.5 py-0.5 hover:text-slate-200 cursor-pointer">
                    <ChevronDown size={10} className="text-slate-600" />
                    <span>src</span>
                  </div>
                  <div className="pl-4 space-y-0.5 border-l border-slate-800/80 ml-1">
                    <div className="flex items-center gap-1.5 py-0.5 hover:text-slate-200 cursor-pointer">
                      <FileCode size={11} className="text-slate-500" />
                      <span>App.tsx</span>
                    </div>
                    <div className="flex items-center gap-1.5 py-0.5 hover:text-slate-200 cursor-pointer">
                      <FileCode size={11} className="text-slate-500" />
                      <span>main.tsx</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 py-0.5 hover:text-slate-200 cursor-pointer">
                    <ChevronRight size={10} className="text-slate-600" />
                    <span>src-tauri</span>
                  </div>
                  <div className="flex items-center gap-1.5 py-0.5 hover:text-slate-200 cursor-pointer pl-3">
                    <FileCode size={11} className="text-slate-500" />
                    <span>vite.config.ts</span>
                  </div>
                </div>
              )}
            </div>

            {/* Presets */}
            <div className="space-y-1">
              <button
                onClick={() => setPresetsOpen(!presetsOpen)}
                className="w-full flex items-center justify-between text-xs font-semibold text-slate-400 hover:text-slate-200 px-2 py-1 cursor-pointer"
              >
                <span className="flex items-center gap-1.5 uppercase tracking-wider text-[10px]">
                  <Zap size={12} className="text-emerald-500" />
                  Execution Presets
                </span>
                {presetsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>

              {presetsOpen && (
                <div className="space-y-1.5 py-1">
                  <button
                    onClick={() => onLoadPreset("Code Loop")}
                    className="w-full text-left bg-slate-900/60 hover:bg-emerald-500/10 border border-slate-800 hover:border-emerald-500/30 rounded-lg p-2 transition-all group cursor-pointer"
                  >
                    <div className="font-semibold text-xs text-slate-300 group-hover:text-emerald-400">Code Loop</div>
                    <div className="text-[10px] text-slate-500 group-hover:text-slate-400 mt-0.5 leading-normal">
                      Auto-generate, lint, format, and run unit tests.
                    </div>
                  </button>
                  <button
                    onClick={() => onLoadPreset("Review Pipeline")}
                    className="w-full text-left bg-slate-900/60 hover:bg-emerald-500/10 border border-slate-800 hover:border-emerald-500/30 rounded-lg p-2 transition-all group cursor-pointer"
                  >
                    <div className="font-semibold text-xs text-slate-300 group-hover:text-emerald-400">Review Pipeline</div>
                    <div className="text-[10px] text-slate-500 group-hover:text-slate-400 mt-0.5 leading-normal">
                      Scan diff, generate review commits, run verification.
                    </div>
                  </button>
                </div>
              )}
            </div>

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
