// Strict, defensive parsing of the Decomposer stage's output: an LLM CLI's stdout, expected to
// be a JSON array of tasks but never trusted to actually be one. Pure — no Tauri/store deps —
// so its correctness rides on TypeScript's own checking plus manual verification (this repo has
// no TS test runner; see package.json).

export interface OrchestratorTask {
  id: string;
  title: string;
  prompt: string;
  fileScopes: string[];
  dependsOn: string[];
}

export type TaskListParseResult =
  | { ok: true; tasks: OrchestratorTask[] }
  | { ok: false; error: string };

// Pulls a fenced ```json ... ``` block out of surrounding prose if present, else returns the
// input unchanged so a bare JSON response still works.
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

// Second-chance extraction for a response that still has leading/trailing commentary outside
// any code fence (e.g. "Here is the task list:\n[...]\nLet me know if..."): takes the outermost
// bracket pair rather than trusting the whole string to be valid JSON on its own.
function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function parseTaskListJson(raw: string): TaskListParseResult {
  const stripped = stripCodeFence(raw);
  const candidate = extractJsonArray(stripped) ?? stripped;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      error: `Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: "Expected a JSON array of tasks." };
  }
  if (parsed.length === 0) {
    return { ok: false, error: "Task list was empty." };
  }

  const tasks: OrchestratorTask[] = [];
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: `Task at index ${index} is not an object.` };
    }
    const obj = entry as Record<string, unknown>;

    if (typeof obj.id !== "string" || !obj.id.trim()) {
      return { ok: false, error: `Task at index ${index} is missing a non-empty "id".` };
    }
    if (typeof obj.title !== "string" || !obj.title.trim()) {
      return { ok: false, error: `Task "${obj.id}" is missing a non-empty "title".` };
    }
    if (typeof obj.prompt !== "string" || !obj.prompt.trim()) {
      return { ok: false, error: `Task "${obj.id}" is missing a non-empty "prompt".` };
    }

    const fileScopes = obj.fileScopes ?? [];
    if (!isStringArray(fileScopes)) {
      return { ok: false, error: `Task "${obj.id}" has a non-string-array "fileScopes".` };
    }
    const dependsOn = obj.dependsOn ?? [];
    if (!isStringArray(dependsOn)) {
      return { ok: false, error: `Task "${obj.id}" has a non-string-array "dependsOn".` };
    }

    tasks.push({
      id: obj.id.trim(),
      title: obj.title.trim(),
      prompt: obj.prompt,
      fileScopes,
      dependsOn,
    });
  }

  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) {
    return { ok: false, error: "Task ids must be unique." };
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        return { ok: false, error: `Task "${task.id}" cannot depend on itself.` };
      }
      if (!ids.has(dep)) {
        return { ok: false, error: `Task "${task.id}" depends on unknown task id "${dep}".` };
      }
    }
  }

  const cycleError = findDependencyCycle(tasks);
  if (cycleError) {
    return { ok: false, error: cycleError };
  }

  return { ok: true, tasks };
}

// DFS-based cycle detection over dependsOn edges. Returns a human-readable error naming a task
// on the cycle, or null when the dependency graph is a valid DAG.
function findDependencyCycle(tasks: OrchestratorTask[]): string | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, "visiting" | "done">();

  function visit(id: string): string | null {
    const status = state.get(id);
    if (status === "done") return null;
    if (status === "visiting") return `Dependency cycle detected at task "${id}".`;

    state.set(id, "visiting");
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    state.set(id, "done");
    return null;
  }

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return null;
}
