import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, FolderCog } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";

interface WorkspaceSettingsModalProps {
  onClose: () => void;
}

export default function WorkspaceSettingsModal({ onClose }: WorkspaceSettingsModalProps) {
  const [location, setLocation] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<string>("get_default_projects_location")
      .then(setLocation)
      .catch((err) => console.error("Failed to load default projects location:", err));
  }, []);

  const chooseFolder = async () => {
    try {
      const picked = await invoke<string | null>("pick_folder");
      if (picked) setLocation(picked);
    } catch (err) {
      console.error("Failed to pick a folder:", err);
    }
  };

  const save = async () => {
    try {
      await invoke("set_default_projects_location", { path: location });
      setSaved(true);
    } catch (err) {
      console.error("Failed to save default projects location:", err);
    }
  };

  return (
    <Modal onClose={onClose} width={440}>
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <FolderCog size={14} className="text-emerald-400" />
          <span className="text-xs font-semibold text-slate-200 uppercase tracking-wide">Workspace Settings</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors cursor-pointer">
          <X size={16} />
        </button>
      </div>

      <p className="text-[10px] text-slate-500 mb-3 leading-relaxed">
        New projects create a folder here by default. Existing projects aren't affected.
      </p>

      <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
        Default Projects Location
      </label>
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          type="text"
          value={location}
          onChange={(e) => {
            setLocation(e.target.value);
            setSaved(false);
          }}
          className="flex-1 bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500/50 font-mono"
        />
        <Button variant="secondary" size="sm" onClick={() => void chooseFolder()}>
          Choose…
        </Button>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={!location.trim()}>
          {saved ? "Saved" : "Save"}
        </Button>
      </div>
    </Modal>
  );
}
