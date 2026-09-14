import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

const buttonVariants = cva(
  "control-interaction inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-normal tracking-normal [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 aria-invalid:ring-destructive-ring aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-button-primary text-button-primary-foreground hover:bg-button-primary/90 active:bg-button-primary/80",
        destructive:
          "bg-destructive-surface text-destructive-foreground font-medium hover:bg-destructive/90 active:bg-destructive/80 focus-visible:ring-destructive-ring",
        outline:
          "border border-border-strong bg-control-surface text-foreground hover:bg-control-surface-hover active:bg-control-surface-pressed",
        secondary:
          "bg-control-surface text-foreground hover:bg-control-surface-hover active:bg-control-surface-pressed",
        ghost: "hover:bg-control-hover hover:text-foreground active:bg-control-pressed",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        xs: "h-7 gap-1 px-2.5",
        sm: "h-8 gap-1.5 px-3",
        lg: "h-10 px-5",
        icon: "size-9",
        "icon-xs": "size-7",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean;
    }
>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
});

Button.displayName = "Button";

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

export { Button, buttonVariants };
export type { ButtonProps };
