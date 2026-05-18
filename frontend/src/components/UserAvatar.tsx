import { cn } from "@/lib/utils";

interface UserAvatarProps {
  id: string;
  /** sm = size-7 (chat bubble), md = size-8 (top bar). */
  size?: "sm" | "md";
  className?: string;
}

/**
 * Hash the id into an HSL hue. djb2-ish — small, stable, no deps. Fixed
 * saturation / lightness so the yellow band doesn't blow out the white text.
 */
function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function UserAvatar({ id, size = "sm", className }: UserAvatarProps) {
  const initial = (id.trim()[0] ?? "?").toUpperCase();
  const hue = hashHue(id);
  return (
    <div
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white",
        size === "sm" ? "size-7 text-[11px]" : "size-8 text-xs",
        className
      )}
      style={{ backgroundColor: `hsl(${hue} 55% 45%)` }}
      aria-label={id}
      title={id}
    >
      {initial}
    </div>
  );
}
