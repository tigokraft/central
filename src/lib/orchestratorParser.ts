import type { AgentRole } from "../store/canvasStore";

export interface OrchestratorPlanNode {
  role: AgentRole;
  label: string;
  description: string;
  actions?: string[];
  prompt?: string;
}

export interface BuildPlan {
  kind: "build";
  frameLabel: string;
  nodes: OrchestratorPlanNode[];
}

export interface EphemeralPlan {
  kind: "ephemeral";
  label: string;
  command: string;
}

export type OrchestratorPlan = BuildPlan | EphemeralPlan;

const EPHEMERAL_PREFIX = /^(check|verify|scan|ping|confirm)\b/i;
const BUILD_HINT = /\b(build|create|add|implement|generate|write|scaffold)\b/i;
const TEST_HINT = /\b(unit[\s-]?test|tests?|testing|test\s*runner|coverage)\b/i;
const REVIEW_HINT = /\b(review|reviewer|security|audit|vulnerab|secrets?)\b/i;
const PORT_HINT = /port\s+(\d{2,5})/i;

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function titleCase(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 48) return trimmed;
  return `${trimmed.slice(0, 45)}...`;
}

// Rule-based, offline goal parser: no network/LLM call is made. It recognizes a small set of
// intents ("check/verify ..." => a disposable one-off probe, everything else => a build plan)
// and derives a deterministic, editable node graph from keyword hints in the goal text.
export function parseOrchestratorGoal(goal: string): OrchestratorPlan {
  const trimmed = goal.trim();

  if (EPHEMERAL_PREFIX.test(trimmed) && !BUILD_HINT.test(trimmed)) {
    const portMatch = trimmed.match(PORT_HINT);
    const command = portMatch
      ? `lsof -nP -iTCP:${portMatch[1]} -sTCP:LISTEN || echo "Port ${portMatch[1]} is free"`
      : `echo ${shellSingleQuote(`Ad-hoc check: ${trimmed}`)}`;

    return { kind: "ephemeral", label: titleCase(trimmed), command };
  }

  const nodes: OrchestratorPlanNode[] = [
    {
      role: "coder",
      label: "Coder",
      description: "Generates the implementation for the goal.",
      prompt: trimmed,
    },
  ];

  if (TEST_HINT.test(trimmed)) {
    nodes.push({
      role: "test-runner",
      label: "Test Runner",
      description: "Runs the unit test suite against the generated change.",
      actions: ["Run unit test suite", "Report coverage summary"],
    });
  }

  if (REVIEW_HINT.test(trimmed)) {
    nodes.push({
      role: "reviewer",
      label: "Security Reviewer",
      description: "Reviews the change for security and correctness issues.",
      actions: ["Scan for security vulnerabilities", "Review auth boundary checks"],
    });
  }

  return { kind: "build", frameLabel: titleCase(trimmed), nodes };
}
