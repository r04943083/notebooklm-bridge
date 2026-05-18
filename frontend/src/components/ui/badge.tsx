import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Badge — small inline label. Used for source `kind` chips ("pdf"/"url"/...)
 * in the SourcesPanel and citation reference markers elsewhere.
 *
 * The `soft` variant is the in-between visual weight that pairs well with
 * the citation chips (subtle accent background, not full primary color).
 */
const badgeStyles = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-muted text-muted-foreground",
        soft:
          "border-transparent bg-accent-soft text-accent-soft-foreground",
        outline:
          "border-border bg-background text-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeStyles> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeStyles({ variant }), className)} {...props} />;
}

export { badgeStyles };
