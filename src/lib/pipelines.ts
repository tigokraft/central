export interface PipelineMeta {
  id: string;
  name: string;
  createdAt: number;
  lastModifiedAt: number;
}

// Used to decide which pipeline tab a project opens to, and which one's nodes back its Home
// page thumbnail: whichever tab was worked on most recently.
export function pickMostRecentPipeline(pipelines: PipelineMeta[]): PipelineMeta | null {
  if (pipelines.length === 0) return null;
  return pipelines.reduce((latest, p) => (p.lastModifiedAt > latest.lastModifiedAt ? p : latest));
}
