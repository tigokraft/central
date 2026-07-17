import { type HTMLAttributes, forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const panelVariants = cva("bg-slate-900 border border-slate-800 shadow-panel", {
  variants: {
    radius: {
      md: "rounded-lg",
      lg: "rounded-xl",
    },
    elevated: {
      true: "bg-slate-900/95 backdrop-blur-md",
      false: "",
    },
  },
  defaultVariants: {
    radius: "lg",
    elevated: false,
  },
});

export interface PanelProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof panelVariants> {}

const Panel = forwardRef<HTMLDivElement, PanelProps>(
  ({ className, radius, elevated, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(panelVariants({ radius, elevated }), className)}
      {...props}
    />
  )
);
Panel.displayName = "Panel";

export default Panel;
