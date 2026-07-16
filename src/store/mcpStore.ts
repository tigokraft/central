import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type McpServerStatus = "connecting" | "connected" | "error" | "disconnected";

export interface McpServerConnection {
  serverId: string;
  command: string;
  args: string[];
  name?: string;
  version?: string;
  tools: McpTool[];
  status: McpServerStatus;
  error?: string;
}

interface McpConnectResult {
  serverId: string;
  name?: string;
  version?: string;
  tools: McpTool[];
}

interface McpState {
  servers: Record<string, McpServerConnection>;
  connectServer: (
    serverId: string,
    command: string,
    args: string[],
    env?: Record<string, string>
  ) => Promise<void>;
  disconnectServer: (serverId: string) => Promise<void>;
  refreshTools: (serverId: string) => Promise<void>;
  callTool: (serverId: string, toolName: string, args?: unknown) => Promise<unknown>;
  setServerStatus: (serverId: string, status: McpServerStatus, error?: string) => void;
}

export const useMcpStore = create<McpState>((set) => ({
  servers: {},

  connectServer: async (serverId, command, args, env) => {
    set((state) => ({
      servers: {
        ...state.servers,
        [serverId]: { serverId, command, args, tools: [], status: "connecting" },
      },
    }));

    try {
      const result = await invoke<McpConnectResult>("mcp_connect_server", { serverId, command, args, env });
      set((state) => ({
        servers: {
          ...state.servers,
          [serverId]: {
            ...state.servers[serverId],
            name: result.name,
            version: result.version,
            tools: result.tools,
            status: "connected",
          },
        },
      }));
    } catch (err) {
      set((state) => ({
        servers: {
          ...state.servers,
          [serverId]: { ...state.servers[serverId], status: "error", error: String(err) },
        },
      }));
      throw err;
    }
  },

  disconnectServer: async (serverId) => {
    await invoke("mcp_disconnect_server", { serverId });
    set((state) => {
      const next = { ...state.servers };
      delete next[serverId];
      return { servers: next };
    });
  },

  refreshTools: async (serverId) => {
    const tools = await invoke<McpTool[]>("mcp_list_tools", { serverId });
    set((state) => ({
      servers: { ...state.servers, [serverId]: { ...state.servers[serverId], tools } },
    }));
  },

  callTool: async (serverId, toolName, args) => {
    return invoke("mcp_call_tool", { serverId, toolName, arguments: args });
  },

  setServerStatus: (serverId, status, error) =>
    set((state) => {
      const existing = state.servers[serverId];
      if (!existing) return state;
      return { servers: { ...state.servers, [serverId]: { ...existing, status, error } } };
    }),
}));
