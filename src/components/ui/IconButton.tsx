import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const iconButtonVariants = cva(
  "inline-flex items-center justify-center rounded-md transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default: "text-slate-400 hover:text-slate-200 hover:bg-slate-800",
        active: "text-emerald-400 bg-emerald-500/10",
        danger: "text-slate-400 hover:text-error hover:bg-error/10",
      },
      size: {
        sm: "p-1",
        md: "p-1.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "sm",
    },
  }
);

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {}

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
IconButton.displayName = "IconButton";

export default IconButton;
