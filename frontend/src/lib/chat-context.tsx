import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Citation, Source } from "@/types";

// ---------------------------------------------------------------------------
// SourcesContext — read-only access to the current notebook's source list (and
// its id) so CitationDrawer / SourcesPanel can join by source_id and fetch
// fulltext without prop drilling through ChatPane / ChatTurn / MarkdownAnswer
// / CitationChip.
// ---------------------------------------------------------------------------

interface SourcesContextValue {
  notebookId: string | null;
  sources: Source[];
}

const SourcesContext = createContext<SourcesContextValue>({
  notebookId: null,
  sources: [],
});

export function SourcesProvider({
  notebookId,
  sources,
  children,
}: {
  notebookId: string | null;
  sources: Source[];
  children: ReactNode;
}) {
  const value = useMemo<SourcesContextValue>(
    () => ({ notebookId, sources }),
    [notebookId, sources]
  );
  return (
    <SourcesContext.Provider value={value}>{children}</SourcesContext.Provider>
  );
}

export function useSources(): Source[] {
  return useContext(SourcesContext).sources;
}

export function useNotebookId(): string | null {
  return useContext(SourcesContext).notebookId;
}

export function useSourceLookup(): (source_id: string) => Source | undefined {
  const sources = useSources();
  return useCallback(
    (sid: string) => sources.find((s) => s.id === sid),
    [sources]
  );
}

// ---------------------------------------------------------------------------
// UserContext — lightweight access to the current X-User-Id. Lets ChatTurn
// render a UserAvatar without prop-drilling userId through ChatPane.
// ---------------------------------------------------------------------------

const UserContext = createContext<string>("");

export function UserProvider({ userId, children }: { userId: string; children: ReactNode }) {
  return <UserContext.Provider value={userId}>{children}</UserContext.Provider>;
}

export function useUser(): string {
  return useContext(UserContext);
}

// ---------------------------------------------------------------------------
// CitationViewerContext — one active Drawer shared across all chips and the
// SourcesPanel. The Drawer has two modes:
//   - "citation": opened from a chip; carries the full citations[] for a turn
//     so the user can step between [1], [2], [3] of the same answer with
//     prev() / next().
//   - "source":   opened from a PDF / Drive row in SourcesPanel; carries only
//     a source_id so the Drawer can render its title + fulltext (no cited
//     snippet, no prev/next).
// ---------------------------------------------------------------------------

export type DrawerState =
  | { mode: "citation"; citations: Citation[]; index: number }
  | { mode: "source"; sourceId: string };

interface CitationViewerValue {
  active: DrawerState | null;
  openCitation: (citations: Citation[], index: number) => void;
  openSource: (sourceId: string) => void;
  close: () => void;
  prev: () => void;
  next: () => void;
}

const CitationViewerContext = createContext<CitationViewerValue | null>(null);

export function CitationViewerProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<DrawerState | null>(null);

  const value = useMemo<CitationViewerValue>(
    () => ({
      active,
      openCitation: (citations, index) =>
        setActive({
          mode: "citation",
          citations,
          index: clampIndex(index, citations.length),
        }),
      openSource: (sourceId) => setActive({ mode: "source", sourceId }),
      close: () => setActive(null),
      // prev / next are no-ops in source mode — there is no "next source" to
      // step to (the user can click another row in SourcesPanel).
      prev: () =>
        setActive((cur) =>
          cur === null || cur.mode !== "citation"
            ? cur
            : { ...cur, index: clampIndex(cur.index - 1, cur.citations.length) }
        ),
      next: () =>
        setActive((cur) =>
          cur === null || cur.mode !== "citation"
            ? cur
            : { ...cur, index: clampIndex(cur.index + 1, cur.citations.length) }
        ),
    }),
    [active]
  );

  return (
    <CitationViewerContext.Provider value={value}>
      {children}
    </CitationViewerContext.Provider>
  );
}

function clampIndex(idx: number, len: number): number {
  if (len <= 0) return 0;
  if (idx < 0) return 0;
  if (idx >= len) return len - 1;
  return idx;
}

export function useCitationViewer(): CitationViewerValue {
  const ctx = useContext(CitationViewerContext);
  if (!ctx) {
    throw new Error(
      "useCitationViewer must be used inside a <CitationViewerProvider>"
    );
  }
  return ctx;
}
