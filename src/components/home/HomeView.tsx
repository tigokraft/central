import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Folder, Plus, X, Check } from "lucide-react";
import Panel from "../ui/Panel";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import { useAppViewStore } from "../../store/appViewStore";
import { useCanvasStore, NEW_PROJECT_TEMPLATE, type CanvasNode, type CanvasEdge, type Viewport } from "../../store/canvasStore";
import { PROJECT_TEMPLATES, type ProjectTemplate } from "../../lib/projectTemplates";

interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  lastModifiedAt: number;
  path: string;
}

interface ProjectGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
}

export default function HomeView() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewProject, setShowNewProject] = useState(false);
  const openProject = useAppViewStore((state) => state.openProject);

  useEffect(() => {
    void refreshProjects();
  }, []);

  const refreshProjects = async () => {
    try {
      const list = await invoke<ProjectMeta[]>("list_projects");
      setProjects([...list].sort((a, b) => b.lastModifiedAt - a.lastModifiedAt));
    } catch (err) {
      console.error("Failed to list projects:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenProject = async (projectId: string) => {
    try {
      const graph = await invoke<ProjectGraph | null>("load_project_graph", { projectId });
      useCanvasStore.getState().hydrateFromProject(projectId, graph ?? NEW_PROJECT_TEMPLATE);
      openProject(projectId);
    } catch (err) {
      console.error("Failed to open project:", err);
    }
  };

  const handleCreateProject = async (name: string, template: ProjectTemplate) => {
    try {
      const meta = await invoke<ProjectMeta>("create_project", { name });
      const graph = template.build();
      await invoke("save_project_graph", { projectId: meta.id, graph });
      useCanvasStore.getState().hydrateFromProject(meta.id, graph);
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
          <Button variant="primary" size="md" onClick={() => setShowNewProject(true)}>
            <Plus size={13} />
            New Project
          </Button>
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
              >
                <div className="flex items-center gap-2 mb-2">
                  <Folder size={14} className="text-emerald-500 shrink-0" />
                  <span className="text-sm font-medium text-slate-200 truncate">{project.name}</span>
                </div>
                <div className="text-[10px] text-slate-500">
                  Updated {new Date(project.lastModifiedAt).toLocaleString()}
                </div>
              </Panel>
            ))}
          </div>
        )}
      </div>

      {showNewProject && (
        <NewProjectModal onClose={() => setShowNewProject(false)} onCreate={handleCreateProject} />
      )}
    </div>
  );
}

function NewProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, template: ProjectTemplate) => void;
}) {
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(PROJECT_TEMPLATES[0].id);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const template = PROJECT_TEMPLATES.find((t) => t.id === templateId) ?? PROJECT_TEMPLATES[0];
    onCreate(trimmed, template);
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

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={!name.trim()}>
          Create
        </Button>
      </div>
    </Modal>
  );
}
