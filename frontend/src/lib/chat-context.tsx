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
// its id) so CitationModal / FulltextViewer / SourcesPanel can join by
// source_id and fetch fulltext without prop drilling through ChatPane /
// ChatTurn / MarkdownAnswer / CitationChip.
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
// CitationViewerContext — one active citation Drawer shared across all chips
// in the ChatPane. The provider holds `(citations, index)` so the Drawer can
// render the cited text, fetch fulltext, and let the user step between
// citations from the same answer turn with prev() / next().
// ---------------------------------------------------------------------------

interface CitationViewerValue {
  active: { citations: Citation[]; index: number } | null;
  open: (citations: Citation[], index: number) => void;
  close: () => void;
  prev: () => void;
  next: () => void;
}

const CitationViewerContext = createContext<CitationViewerValue | null>(null);

export function CitationViewerProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<{
    citations: Citation[];
    index: number;
  } | null>(null);

  const value = useMemo<CitationViewerValue>(
    () => ({
      active,
      open: (citations, index) =>
        setActive({ citations, index: clampIndex(index, citations.length) }),
      close: () => setActive(null),
      prev: () =>
        setActive((cur) =>
          cur === null
            ? cur
            : { ...cur, index: clampIndex(cur.index - 1, cur.citations.length) }
        ),
      next: () =>
        setActive((cur) =>
          cur === null
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
