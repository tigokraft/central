import CustomTitleBar from "./components/CustomTitleBar";
import HomeView from "./components/home/HomeView";
import CanvasWorkspaceView from "./components/canvas/CanvasWorkspaceView";
import WorkbenchWorkspaceView from "./components/workbench/WorkbenchWorkspaceView";
import { useAppViewStore } from "./store/appViewStore";

export default function App() {
  const view = useAppViewStore((state) => state.view);
  const projectView = useAppViewStore((state) => state.projectView);

  const projectContent = projectView === "workbench" ? <WorkbenchWorkspaceView /> : <CanvasWorkspaceView />;

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-50 font-sans overflow-hidden">
      <CustomTitleBar />
      {view === "home" ? <HomeView /> : projectContent}
    </div>
  );
}
