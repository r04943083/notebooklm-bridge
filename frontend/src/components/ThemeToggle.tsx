import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Sun ⇄ Moon icon button that flips the active theme.
 *
 * We render a stable empty placeholder until after the first mount tick so that
 * the icon doesn't briefly show the wrong state during hydration (next-themes
 * resolves the actual theme client-side).
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? "切换到浅色主题" : "切换到深色主题"}
      title={isDark ? "切换到浅色主题" : "切换到深色主题"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {mounted ? (
        isDark ? <Sun /> : <Moon />
      ) : (
        <span className="size-4" aria-hidden="true" />
      )}
    </Button>
  );
}
