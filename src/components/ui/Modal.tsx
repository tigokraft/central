import { type HTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

export interface ModalProps extends HTMLAttributes<HTMLDivElement> {
  onClose: () => void;
  width?: number;
  children: ReactNode;
}

export default function Modal({ onClose, width = 420, className, children, ...props }: ModalProps) {
  const stop = (e: MouseEvent) => e.stopPropagation();

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className={cn(
          "max-h-[80vh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-xl shadow-overlay p-4",
          className
        )}
        style={{ width }}
        onClick={stop}
        {...props}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
