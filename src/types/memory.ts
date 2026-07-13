export type MemoryType = 
  | "DECISION_RECORD"
  | "ARCHITECTURE_MAP"
  | "ENTITY_FACT"
  | "EPHEMERAL_LOG";

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  entity_ids: string[];
  confidence_score: number;
  supersedes?: string;
  created_at: string;
  content: string; // The Markdown body
}
