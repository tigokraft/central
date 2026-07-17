import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none select-none",
  {
    variants: {
      variant: {
        primary:
          "bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950",
        secondary:
          "bg-slate-900 hover:bg-slate-800 active:bg-slate-800 text-slate-200 border border-slate-800",
        ghost:
          "bg-transparent hover:bg-slate-800/60 text-slate-400 hover:text-slate-200",
      },
      size: {
        sm: "px-2.5 py-1.5 text-xs",
        md: "px-4 py-1.5 text-xs tracking-wide",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "sm",
    },
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
Button.displayName = "Button";

export default Button;
