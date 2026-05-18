import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names with Tailwind-aware deduplication.
 *
 * `clsx` collapses falsy values and arrays into a flat string; `twMerge` then
 * resolves Tailwind conflicts (e.g. `px-2` vs `px-4` → keeps the later one).
 * Use everywhere we compose className with conditional or override semantics.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
