import type { ReactNode } from "react";

interface AppShellProps {
  topBar: ReactNode;
  sidebar: ReactNode;
  studio?: ReactNode;
  children: ReactNode;
}

/**
 * Three-column app layout.
 *
 *   ┌──────────────────────── topBar (full width) ──────────────────────┐
 *   │ sidebar   │             children (main chat pane)     │  studio  │
 *   │           │                                            │          │
 *   └───────────┴────────────────────────────────────────────┴──────────┘
 *
 * Right rail collapses below `xl` (typical 13" laptop) since Studio is a
 * Phase-4 stub and not load-bearing yet. Sidebar collapses below `md`.
 *
 * All children manage their own scrolling — the shell itself is overflow-hidden
 * to keep the header fixed and avoid a double-scroll situation.
 */
export function AppShell({ topBar, sidebar, studio, children }: AppShellProps) {
  const cols = studio
    ? "md:grid-cols-[260px_1fr] xl:grid-cols-[280px_1fr_320px]"
    : "md:grid-cols-[260px_1fr]";

  return (
    <div
      className={`grid h-screen w-screen grid-rows-[3.5rem_1fr] overflow-hidden bg-background text-foreground ${cols}`}
      style={{ fontFamily: "var(--font-sans)" }}
    >
      {topBar}
      <div className="hidden h-full min-h-0 overflow-hidden md:block">
        {sidebar}
      </div>
      <main className="h-full min-h-0 overflow-hidden">{children}</main>
      {studio && (
        <div className="hidden h-full min-h-0 overflow-hidden xl:block">
          {studio}
        </div>
      )}
    </div>
  );
}
