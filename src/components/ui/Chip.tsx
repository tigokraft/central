import { type HTMLAttributes, forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const chipVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "bg-slate-800/60 border-slate-700 text-slate-300",
        accent: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
        success: "bg-success/10 border-success/30 text-success",
        error: "bg-error/10 border-error/30 text-error",
        running: "bg-running/10 border-running/30 text-running",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  }
);

export interface ChipProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof chipVariants> {}

const Chip = forwardRef<HTMLSpanElement, ChipProps>(
  ({ className, tone, ...props }, ref) => (
    <span ref={ref} className={cn(chipVariants({ tone }), className)} {...props} />
  )
);
Chip.displayName = "Chip";

export default Chip;
