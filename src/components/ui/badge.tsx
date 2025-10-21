import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/shared/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 backdrop-blur-sm",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary/20 text-primary hover:bg-primary/30",
        secondary:
          "border-transparent bg-secondary/20 text-secondary-foreground hover:bg-secondary/30",
        destructive:
          "border-transparent bg-destructive/20 text-destructive hover:bg-destructive/30",
        outline: "text-foreground border-border/40",
        // Custom variants for our app
        ready:
          "border-transparent bg-success/10 text-success hover:bg-success/20",
        working:
          "border-transparent bg-primary/10 text-primary hover:bg-primary/20 animate-pulse motion-reduce:animate-none",
        error:
          "border-transparent bg-destructive/10 text-destructive hover:bg-destructive/20",
        warning:
          "border-transparent bg-warning/10 text-warning hover:bg-warning/20",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
