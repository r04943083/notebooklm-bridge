import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface BridgeLogoProps {
  className?: string;
  title?: string;
}

/**
 * App mark — matches the rounded "spark" badge used in ChatPane's empty
 * state, so the same visual identity reads from favicon → top bar → first-run
 * affordance. Inherits the `accent-soft` / `accent` theme tokens so it tracks
 * light/dark mode automatically.
 *
 * Kept in sync with `frontend/public/favicon.svg` — the favicon hardcodes
 * sky-100 / sky-600 hex values because static `<link rel="icon">` can't read
 * Tailwind tokens. If you change the visual here, mirror it there.
 */
export function BridgeLogo({ className, title }: BridgeLogoProps) {
  return (
    <span
      role="img"
      aria-label={title ?? "notebooklm-bridge"}
      className={cn(
        "inline-flex aspect-square shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent",
        className,
      )}
    >
      <Sparkles className="h-3/5 w-3/5" />
    </span>
  );
}
