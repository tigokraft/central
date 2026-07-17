import CustomTitleBar from "./components/CustomTitleBar";
import HomeView from "./components/home/HomeView";
import CanvasWorkspaceView from "./components/canvas/CanvasWorkspaceView";
import { useAppViewStore } from "./store/appViewStore";

export default function App() {
  const view = useAppViewStore((state) => state.view);

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-50 font-sans overflow-hidden">
      <CustomTitleBar />
      {view === "home" ? <HomeView /> : <CanvasWorkspaceView />}
    </div>
  );
}
