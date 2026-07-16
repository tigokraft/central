import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Plug, Plus, Unplug, Wrench, Loader2, AlertTriangle } from "lucide-react";
import { useMcpStore } from "../../store/mcpStore";

interface McpPreset {
  label: string;
  serverId: string;
  command: string;
  args: string;
}

const PRESETS: McpPreset[] = [
  { label: "Filesystem", serverId: "filesystem", command: "npx", args: "-y @modelcontextprotocol/server-filesystem ." },
  { label: "GitHub", serverId: "github", command: "npx", args: "-y @modelcontextprotocol/server-github" },
  { label: "PostgreSQL", serverId: "postgres", command: "npx", args: "-y @modelcontextprotocol/server-postgres" },
];

export default function McpServersPanel() {
  const servers = useMcpStore((state) => state.servers);
  const connectServer = useMcpStore((state) => state.connectServer);
  const disconnectServer = useMcpStore((state) => state.disconnectServer);
  const setServerStatus = useMcpStore((state) => state.setServerStatus);

  const [serverId, setServerId] = useState("");
  const [command, setCommand] = useState("npx");
  const [args, setArgs] = useState("");

  useEffect(() => {
    const unlistenFns: Array<() => void> = [];
    const setup = async () => {
      unlistenFns.push(
        await listen<{ serverId: string; message?: string }>("mcp-server-exit", (e) => {
          setServerStatus(e.payload.serverId, "disconnected", e.payload.message);
        })
      );
    };
    setup();
    return () => unlistenFns.forEach((fn) => fn());
  }, [setServerStatus]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serverId.trim() || !command.trim()) return;
    const argList = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
    try {
      await connectServer(serverId.trim(), command.trim(), argList);
      setServerId("");
      setArgs("");
    } catch (err) {
      console.error("Failed to connect MCP server:", err);
    }
  };

  const applyPreset = (preset: McpPreset) => {
    setServerId(preset.serverId);
    setCommand(preset.command);
    setArgs(preset.args);
  };

  const serverList = Object.values(servers);

  return (
    <div className="space-y-2 py-1">
      {/* Preset quick-fills for common local MCP servers */}
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.serverId}
            onClick={() => applyPreset(preset)}
            className="text-[9px] font-mono text-slate-400 hover:text-emerald-400 bg-slate-900/60 hover:bg-slate-800 border border-slate-800 rounded px-1.5 py-0.5 transition-colors cursor-pointer"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Connect form */}
      <form onSubmit={handleConnect} className="space-y-1" data-nodrag>
        <input
          type="text"
          value={serverId}
          onChange={(e) => setServerId(e.target.value)}
          placeholder="server id (e.g. filesystem)"
          className="w-full bg-slate-950/80 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-300 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 font-mono"
        />
        <div className="flex gap-1">
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="command"
            className="w-20 shrink-0 bg-slate-950/80 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-300 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 font-mono"
          />
          <input
            type="text"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="args (space separated)"
            className="flex-1 min-w-0 bg-slate-950/80 border border-slate-800 rounded px-2 py-1 text-[10px] text-slate-300 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 font-mono"
          />
        </div>
        <button
          type="submit"
          className="w-full flex items-center justify-center gap-1 text-[9px] font-semibold uppercase tracking-wide bg-slate-800 hover:bg-emerald-500/20 hover:text-emerald-400 text-slate-400 rounded px-2 py-1 transition-colors cursor-pointer"
        >
          <Plus size={9} />
          Connect Server
        </button>
      </form>

      {/* Connected servers */}
      <div className="space-y-1.5">
        {serverList.length === 0 ? (
          <div className="text-[10px] text-slate-600 italic px-1">No MCP servers connected.</div>
        ) : (
          serverList.map((server) => (
            <div key={server.serverId} className="bg-slate-900/60 border border-slate-800 rounded-lg p-2 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[10px] font-mono text-slate-200 truncate">
                  {server.status === "connecting" && <Loader2 size={10} className="animate-spin text-slate-500 shrink-0" />}
                  {server.status === "connected" && <Plug size={10} className="text-emerald-500 shrink-0" />}
                  {(server.status === "error" || server.status === "disconnected") && (
                    <AlertTriangle size={10} className="text-red-400 shrink-0" />
                  )}
                  {server.serverId}
                </span>
                <button
                  onClick={() => disconnectServer(server.serverId)}
                  className="text-slate-500 hover:text-red-400 transition-colors cursor-pointer shrink-0"
                  title="Disconnect"
                >
                  <Unplug size={11} />
                </button>
              </div>
              {server.status === "connected" && (
                <div className="flex items-center gap-1 text-[9px] text-slate-500">
                  <Wrench size={9} />
                  {server.tools.length} tool{server.tools.length === 1 ? "" : "s"}
                </div>
              )}
              {server.error && <div className="text-[9px] text-red-400 truncate" title={server.error}>{server.error}</div>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
