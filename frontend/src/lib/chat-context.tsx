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
// SourcesContext — read-only access to the current notebook's source list so
// CitationModal (and SourcesPanel, if it wants) can join by source_id without
// prop drilling through ChatPane / ChatTurn / MarkdownAnswer / CitationChip.
// ---------------------------------------------------------------------------

const SourcesContext = createContext<Source[]>([]);

export function SourcesProvider({
  sources,
  children,
}: {
  sources: Source[];
  children: ReactNode;
}) {
  return (
    <SourcesContext.Provider value={sources}>{children}</SourcesContext.Provider>
  );
}

export function useSources(): Source[] {
  return useContext(SourcesContext);
}

export function useSourceLookup(): (source_id: string) => Source | undefined {
  const sources = useSources();
  return useCallback(
    (sid: string) => sources.find((s) => s.id === sid),
    [sources]
  );
}

// ---------------------------------------------------------------------------
// CitationViewerContext — one active citation modal shared across all chips in
// the ChatPane. The provider holds `active` state; chips call `open(citation)`,
// CitationModal reads `active` to know what to show.
// ---------------------------------------------------------------------------

interface CitationViewerValue {
  active: Citation | null;
  open: (c: Citation) => void;
  close: () => void;
}

const CitationViewerContext = createContext<CitationViewerValue | null>(null);

export function CitationViewerProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Citation | null>(null);

  const value = useMemo<CitationViewerValue>(
    () => ({
      active,
      open: (c) => setActive(c),
      close: () => setActive(null),
    }),
    [active]
  );

  return (
    <CitationViewerContext.Provider value={value}>
      {children}
    </CitationViewerContext.Provider>
  );
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
