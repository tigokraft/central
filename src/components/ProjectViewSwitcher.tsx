import { LayoutGrid, Users, GitMerge } from "lucide-react";
import { useAppViewStore, type ProjectView } from "../store/appViewStore";

// Segmented toggle between a project's pipeline canvas, its team workbench, and its
// orchestrator runs. Shared by every workspace shell's header so switching is available no
// matter which one is showing.
export default function ProjectViewSwitcher() {
  const projectView = useAppViewStore((state) => state.projectView);
  const setProjectView = useAppViewStore((state) => state.setProjectView);

  const options: { value: ProjectView; label: string; icon: typeof LayoutGrid }[] = [
    { value: "canvas", label: "Canvas", icon: LayoutGrid },
    { value: "workbench", label: "Workbench", icon: Users },
    { value: "runs", label: "Runs", icon: GitMerge },
  ];

  return (
    <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          onClick={() => setProjectView(value)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
            projectView === value
              ? "bg-emerald-500/10 text-emerald-400"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Icon size={13} />
          {label}
        </button>
      ))}
    </div>
  );
}
