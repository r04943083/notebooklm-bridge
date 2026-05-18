import { cn } from "@/lib/utils";

interface BridgeLogoProps {
  className?: string;
  title?: string;
}

/**
 * App mark — sky-gradient rounded square with a white BookOpen glyph. Kept
 * in sync with `frontend/public/favicon.svg`; if you change one, change both.
 *
 * Rendered inline (rather than `<img src="/favicon.svg">`) so it inherits
 * `currentColor` semantics if we ever want a monochrome variant, and so React
 * can swap the gradient stops via props if a future theme demands it.
 */
export function BridgeLogo({ className, title }: BridgeLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      role="img"
      aria-label={title ?? "notebooklm-bridge"}
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient id="bridgeLogoGradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0ea5e9" />
          <stop offset="100%" stopColor="#0369a1" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#bridgeLogoGradient)" />
      <g
        transform="translate(12 12) scale(1.67)"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </g>
    </svg>
  );
}
