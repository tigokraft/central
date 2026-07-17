import React, { useState } from "react";
import { Brain, Search, Link as LinkIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore, CanvasNode, beginHistoryBatch, endHistoryBatch } from "../../../store/canvasStore";
import Port from "../Port";
import { MemoryRecord } from "../../../types/memory";

interface MemoryNodeProps {
  node: CanvasNode;
}

interface SearchResult {
  id: string;
  content: string;
  score: number;
}

export default function MemoryNode({ node }: MemoryNodeProps) {
  const { id, data } = node;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const activeFacts = data.facts || [];
  const entities = data.entities || [];

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    
    setIsSearching(true);
    try {
      const searchResults = await invoke<SearchResult[]>("query_memory_graph", { query });
      setResults(searchResults);
    } catch (error) {
      console.error("Failed to query memory graph:", error);
    } finally {
      setIsSearching(false);
    }
  };

  const handleCreateMemory = async () => {
    try {
      const record: MemoryRecord = {
        id: `mem_${Date.now()}`,
        type: "ENTITY_FACT",
        entity_ids: entities,
        confidence_score: 1.0,
        created_at: new Date().toISOString(),
        content: `New memory created from Canvas at ${new Date().toLocaleTimeString()}`,
      };
      
      await invoke("create_memory_record", { record });

      const updatedFacts = [...activeFacts, record.content];
      beginHistoryBatch();
      updateNodeData(id, { facts: updatedFacts });
      endHistoryBatch();

    } catch (error) {
      console.error("Failed to create memory record:", error);
    }
  };

  return (
    <div className="relative w-full h-full bg-slate-900 border border-slate-800 rounded-lg shadow-panel overflow-hidden p-3 flex flex-col transition-colors hover:border-emerald-500/50 select-none">
      {/* Input / Output Handles */}
      <Port
        nodeId={id}
        handleId="input"
        type="target"
        color="neutral"
        className="absolute -left-1.5 top-1/2 -translate-y-1/2"
      />
      <Port
        nodeId={id}
        handleId="output"
        type="source"
        color="neutral"
        className="absolute -right-1.5 top-1/2 -translate-y-1/2"
      />

      {/* Header */}
      <div className="flex items-center justify-between mb-3 border-b border-slate-800 pb-2 shrink-0">
        <div className="flex items-center gap-2 text-slate-300">
          <Brain size={14} />
          <span className="font-mono text-xs font-semibold tracking-wide">
            {data.label || "Memory"}
          </span>
        </div>
        <button
          onClick={handleCreateMemory}
          className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-[9px] px-2 py-0.5 rounded transition-colors"
          data-nodrag
        >
          Index Fact
        </button>
      </div>

      {/* Active Context */}
      <div className="flex-1 min-h-0 flex flex-col gap-2 overflow-y-auto" data-nodrag>
        
        {/* Facts & Entities section */}
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div className="bg-slate-800/50 rounded p-1.5 border border-slate-700/50">
            <h4 className="text-[9px] text-slate-400 font-mono mb-1">Active Facts</h4>
            {activeFacts.length === 0 ? (
              <div className="text-[9px] text-slate-600 italic">No facts yet</div>
            ) : (
              <ul className="text-[10px] text-slate-300 list-disc list-inside leading-tight space-y-0.5">
                {activeFacts.map((fact: string, i: number) => (
                  <li key={i} className="truncate" title={fact}>{fact}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="bg-slate-800/50 rounded p-1.5 border border-slate-700/50">
            <h4 className="text-[9px] text-slate-400 font-mono mb-1 flex items-center gap-1">
              <LinkIcon size={8} /> Entities
            </h4>
            {entities.length === 0 ? (
              <div className="text-[9px] text-slate-600 italic">No entities linked</div>
            ) : (
              <div className="flex flex-wrap gap-1 mt-1">
                {entities.map((ent: string, i: number) => (
                  <span key={i} className="text-[8px] bg-slate-700/60 text-slate-300 px-1 rounded border border-slate-600/60">
                    {ent}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Real-time Search */}
        <div className="mt-auto">
          <form onSubmit={handleSearch} className="relative flex items-center">
            <Search size={12} className="absolute left-2 text-slate-500" />
            <input 
              type="text" 
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Query memory graph..." 
              className="w-full bg-slate-950/80 border border-slate-700 rounded py-1.5 pl-6 pr-2 text-[10px] text-slate-200 focus:outline-none focus:border-emerald-500/50 font-mono"
            />
          </form>

          {/* Search Results */}
          {results.length > 0 && (
            <div className="mt-2 bg-slate-950 rounded border border-slate-800 p-1.5 max-h-[80px] overflow-y-auto">
              <div className="text-[8px] text-slate-400 mb-1">Results:</div>
              {results.map((res, i) => (
                <div key={i} className="text-[9px] text-slate-300 border-b border-slate-800/50 last:border-0 pb-1 mb-1">
                  <span className="text-slate-400 mr-1">[{res.id}]</span>
                  {res.content} <span className="text-emerald-400 ml-1">{(res.score * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
          {isSearching && (
            <div className="text-[9px] text-slate-500 mt-1 animate-pulse">Searching vector store...</div>
          )}
        </div>
      </div>
    </div>
  );
}
