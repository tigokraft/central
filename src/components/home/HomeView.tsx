import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Folder, Plus, X, Check, Settings, FolderOpen } from "lucide-react";
import Panel from "../ui/Panel";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import NodeLayoutThumbnail from "../canvas/NodeLayoutThumbnail";
import WorkspaceSettingsModal from "../WorkspaceSettingsModal";
import { useAppViewStore } from "../../store/appViewStore";
import { useCanvasStore, NEW_PROJECT_TEMPLATE, type CanvasNode, type CanvasEdge, type Viewport } from "../../store/canvasStore";
import { PROJECT_TEMPLATES, type ProjectTemplate } from "../../lib/projectTemplates";
import { pickMostRecentPipeline, type PipelineMeta } from "../../lib/pipelines";

type WorkspaceKind = "managed" | "linked";

interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  lastModifiedAt: number;
  path: string;
  workspacePath: string;
  workspaceKind: WorkspaceKind;
}

interface ProjectGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
}

export default function HomeView() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    project: ProjectMeta;
  } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  const openContextMenu = (e: ReactMouseEvent, project: ProjectMeta) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, project });
  };

  const getRevealLabel = () => {
    const ua = navigator.userAgent;
    if (ua.includes("Mac")) return "Reveal in Finder";
    if (ua.includes("Windows")) return "Reveal in File Explorer";
    return "Reveal in File Manager";
  };

  const revealProject = async (project: ProjectMeta) => {
    try {
      await invoke("show_in_folder", { projectId: project.id, path: "" });
    } catch (err) {
      console.error("Failed to reveal project in explorer:", err);
    }
  };
  const [thumbnailNodes, setThumbnailNodes] = useState<Record<string, CanvasNode[]>>({});
  const [loading, setLoading] = useState(true);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showWorkspaceSettings, setShowWorkspaceSettings] = useState(false);
  const openProject = useAppViewStore((state) => state.openProject);

  useEffect(() => {
    void refreshProjects();
  }, []);

  const refreshProjects = async () => {
    try {
      const list = await invoke<ProjectMeta[]>("list_projects");
      const sorted = [...list].sort((a, b) => b.lastModifiedAt - a.lastModifiedAt);
      setProjects(sorted);
      void loadThumbnails(sorted);
    } catch (err) {
      console.error("Failed to list projects:", err);
    } finally {
      setLoading(false);
    }
  };

  // A project's thumbnail reflects whichever pipeline was worked on most recently, not
  // necessarily the one that opens first.
  const loadThumbnails = async (list: ProjectMeta[]) => {
    const entries = await Promise.all(
      list.map(async (project): Promise<[string, CanvasNode[]]> => {
        try {
          const pipelines = await invoke<PipelineMeta[]>("list_pipelines", { projectId: project.id });
          const target = pickMostRecentPipeline(pipelines);
          if (!target) return [project.id, []];
          const graph = await invoke<ProjectGraph | null>("load_pipeline_graph", {
            projectId: project.id,
            pipelineId: target.id,
          });
          return [project.id, graph?.nodes ?? []];
        } catch (err) {
          console.error(`Failed to load graph for thumbnail (${project.id}):`, err);
          return [project.id, []];
        }
      })
    );
    setThumbnailNodes(Object.fromEntries(entries));
  };

  const handleOpenProject = async (projectId: string) => {
    try {
      const meta = await invoke<ProjectMeta>("ensure_project_workspace", { projectId });
      await invoke("set_active_project_path", { path: meta.workspacePath });
      const pipelines = await invoke<PipelineMeta[]>("list_pipelines", { projectId });
      const target = pickMostRecentPipeline(pipelines);
      const graph = target
        ? await invoke<ProjectGraph | null>("load_pipeline_graph", { projectId, pipelineId: target.id })
        : null;
      useCanvasStore
        .getState()
        .hydratePipeline(projectId, target?.id ?? "", graph ?? NEW_PROJECT_TEMPLATE);
      openProject(projectId);
    } catch (err) {
      console.error("Failed to open project:", err);
    }
  };

  const handleCreateProject = async (
    name: string,
    template: ProjectTemplate,
    workspaceKind: WorkspaceKind,
    linkedPath: string | null
  ) => {
    try {
      const meta = await invoke<ProjectMeta>("create_project", {
        name,
        workspaceKind,
        linkedPath,
      });
      await invoke("set_active_project_path", { path: meta.workspacePath });
      const pipelines = await invoke<PipelineMeta[]>("list_pipelines", { projectId: meta.id });
      const mainPipeline = pipelines[0];
      const graph = template.build();
      await invoke("save_pipeline_graph", { projectId: meta.id, pipelineId: mainPipeline.id, graph });
      useCanvasStore.getState().hydratePipeline(meta.id, mainPipeline.id, graph);
      openProject(meta.id);
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      setShowNewProject(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-10 py-10">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-lg font-semibold text-slate-100">Projects</h1>
            <p className="text-xs text-slate-500 mt-1">Pick up where you left off, or start something new.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="md" onClick={() => setShowWorkspaceSettings(true)} title="Workspace Settings">
              <Settings size={13} />
            </Button>
            <Button variant="primary" size="md" onClick={() => setShowNewProject(true)}>
              <Plus size={13} />
              New Project
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="text-xs text-slate-500">Loading projects…</div>
        ) : projects.length === 0 ? (
          <Panel className="p-8 text-center">
            <Folder className="mx-auto text-slate-700 mb-3" size={28} />
            <p className="text-sm text-slate-400">No projects yet.</p>
            <p className="text-xs text-slate-600 mt-1">Create your first project to open the canvas.</p>
          </Panel>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <Panel
                key={project.id}
                className="p-4 text-left cursor-pointer hover:border-emerald-500/40 transition-colors"
                onClick={() => void handleOpenProject(project.id)}
                onContextMenu={(e) => openContextMenu(e, project)}
              >
                <NodeLayoutThumbnail
                  nodes={thumbnailNodes[project.id] ?? []}
                  className="w-full h-20 mb-3 rounded bg-slate-950/60 border border-slate-800/60"
                />
                <div className="flex items-center gap-2 mb-2">
                  <Folder size={14} className="text-emerald-500 shrink-0" />
                  <span className="text-sm font-medium text-slate-200 truncate">{project.name}</span>
                </div>
                <div className="text-[10px] text-slate-500">
                  Updated {new Date(project.lastModifiedAt).toLocaleString()}
                </div>
                {project.workspacePath && (
                  <div className="flex items-center gap-1 text-[10px] text-slate-600 mt-1 truncate">
                    <FolderOpen size={10} className="shrink-0" />
                    <span className="truncate">{project.workspacePath}</span>
                  </div>
                )}
              </Panel>
            ))}
          </div>
        )}
      </div>

      {showNewProject && (
        <NewProjectModal onClose={() => setShowNewProject(false)} onCreate={handleCreateProject} />
      )}
      {showWorkspaceSettings && <WorkspaceSettingsModal onClose={() => setShowWorkspaceSettings(false)} />}

      {contextMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y }}
          className="w-48 bg-slate-900 border border-slate-800 rounded-lg shadow-overlay py-1 z-50"
        >
          <button
            onClick={() => {
              void revealProject(contextMenu.project);
              setContextMenu(null);
            }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100 cursor-pointer text-left"
          >
            <FolderOpen size={12} className="text-slate-400" />
            {getRevealLabel()}
          </button>
        </div>
      )}
    </div>
  );
}

function NewProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (
    name: string,
    template: ProjectTemplate,
    workspaceKind: WorkspaceKind,
    linkedPath: string | null
  ) => void;
}) {
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(PROJECT_TEMPLATES[0].id);
  const [workspaceKind, setWorkspaceKind] = useState<WorkspaceKind>("managed");
  const [linkedPath, setLinkedPath] = useState<string | null>(null);

  const chooseLinkedFolder = async () => {
    try {
      const picked = await invoke<string | null>("pick_folder");
      if (picked) setLinkedPath(picked);
    } catch (err) {
      console.error("Failed to pick a folder:", err);
    }
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (workspaceKind === "linked" && !linkedPath) return;
    const template = PROJECT_TEMPLATES.find((t) => t.id === templateId) ?? PROJECT_TEMPLATES[0];
    onCreate(trimmed, template, workspaceKind, linkedPath);
  };

  return (
    <Modal onClose={onClose} width={440}>
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800">
        <span className="text-xs font-semibold text-slate-200 uppercase tracking-wide">New Project</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors cursor-pointer">
          <X size={16} />
        </button>
      </div>

      <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Project Name</label>
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="My Project"
        className="w-full mt-1 bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50"
      />

      <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mt-4 block">
        Starting Point
      </label>
      <div className="mt-1.5 space-y-1.5">
        {PROJECT_TEMPLATES.map((template) => {
          const selected = template.id === templateId;
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => setTemplateId(template.id)}
              className={`w-full text-left px-2.5 py-2 rounded border transition-colors cursor-pointer ${
                selected
                  ? "border-emerald-500/50 bg-emerald-500/5"
                  : "border-slate-800 bg-slate-900 hover:border-slate-700"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-slate-200">{template.name}</span>
                {selected && <Check size={12} className="text-emerald-400 shrink-0" />}
              </div>
              <p className="text-[10px] text-slate-500 mt-0.5">{template.description}</p>
            </button>
          );
        })}
      </div>

      <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mt-4 block">
        Workspace Folder
      </label>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={() => setWorkspaceKind("managed")}
          className={`text-left px-2.5 py-2 rounded border transition-colors cursor-pointer ${
            workspaceKind === "managed"
              ? "border-emerald-500/50 bg-emerald-500/5"
              : "border-slate-800 bg-slate-900 hover:border-slate-700"
          }`}
        >
          <span className="text-[11px] font-medium text-slate-200">New folder</span>
          <p className="text-[10px] text-slate-500 mt-0.5">Created for you in your default projects location.</p>
        </button>
        <button
          type="button"
          onClick={() => setWorkspaceKind("linked")}
          className={`text-left px-2.5 py-2 rounded border transition-colors cursor-pointer ${
            workspaceKind === "linked"
              ? "border-emerald-500/50 bg-emerald-500/5"
              : "border-slate-800 bg-slate-900 hover:border-slate-700"
          }`}
        >
          <span className="text-[11px] font-medium text-slate-200">Existing folder</span>
          <p className="text-[10px] text-slate-500 mt-0.5">Link a folder already on disk.</p>
        </button>
      </div>

      {workspaceKind === "linked" && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <div className="flex-1 bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-400 truncate">
            {linkedPath ?? "No folder chosen"}
          </div>
          <Button variant="secondary" size="sm" onClick={() => void chooseLinkedFolder()}>
            Choose…
          </Button>
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={!name.trim() || (workspaceKind === "linked" && !linkedPath)}
        >
          Create
        </Button>
      </div>
    </Modal>
  );
}
