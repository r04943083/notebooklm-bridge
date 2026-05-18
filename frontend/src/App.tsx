import { ThemeProvider } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { api, getUserId } from "@/api";
import { AppShell } from "@/components/AppShell";
import { ChatPane } from "@/components/ChatPane";
import { SourcesPanel } from "@/components/SourcesPanel";
import { StudioStub } from "@/components/StudioStub";
import { TopBar } from "@/components/TopBar";
import { UserPrompt } from "@/components/UserPrompt";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SourcesProvider } from "@/lib/chat-context";
import type { ChatTurn, HistoryEntry, Notebook, Source } from "@/types";

const HISTORY_KEY = "nblm_history";
const NOTEBOOK_KEY = "nblm_notebook_id";
const HISTORY_LIMIT = 20;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(entries.slice(-HISTORY_LIMIT))
  );
}

export default function App() {
  const [userId, setUserIdState] = useState(getUserId());

  // notebooks list (top-level so TopBar's picker and ChatPane's empty state
  // can both see the title of the current selection)
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebooksLoading, setNotebooksLoading] = useState(false);
  const [notebooksError, setNotebooksError] = useState<string | null>(null);

  const [notebookId, setNotebookId] = useState<string>(
    () => localStorage.getItem(NOTEBOOK_KEY) ?? ""
  );

  // sources for the current notebook — lifted here so SourcesPanel,
  // CitationChip's tooltip, and CitationModal share one fetch.
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState<string | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);

  // Pull the notebook list as soon as we know who the user is.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setNotebooksLoading(true);
    setNotebooksError(null);
    api
      .listNotebooks()
      .then((nbs) => {
        if (!alive) return;
        setNotebooks(nbs);
        // Auto-select first notebook if none persisted or stale.
        if (!notebookId || !nbs.some((n) => n.id === notebookId)) {
          if (nbs.length > 0) setNotebookId(nbs[0].id);
        }
      })
      .catch((e: Error) => alive && setNotebooksError(e.message))
      .finally(() => alive && setNotebooksLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Fetch sources whenever the selected notebook changes.
  useEffect(() => {
    if (!notebookId) {
      setSources([]);
      return;
    }
    localStorage.setItem(NOTEBOOK_KEY, notebookId);
    let alive = true;
    setSourcesLoading(true);
    setSourcesError(null);
    api
      .listSources(notebookId)
      .then((s) => alive && setSources(s))
      .catch((e: Error) => alive && setSourcesError(e.message))
      .finally(() => alive && setSourcesLoading(false));
    return () => {
      alive = false;
    };
  }, [notebookId]);

  const handleTurn = useCallback(
    (turn: ChatTurn) => {
      const cid = turn.response.conversation_id;
      if (!cid) return;
      setHistory((prev) => {
        const existing = prev.find((h) => h.conversation_id === cid);
        const next = existing
          ? prev.map((h) =>
              h.conversation_id === cid ? { ...h, ts: Date.now() } : h
            )
          : [
              ...prev,
              {
                notebook_id: notebookId,
                conversation_id: cid,
                first_question: turn.question,
                ts: Date.now(),
              },
            ];
        saveHistory(next);
        return next;
      });
    },
    [notebookId]
  );

  const handleSelectHistory = useCallback((entry: HistoryEntry) => {
    // For now, all we can do is switch to the entry's notebook — restoring an
    // older conversation_id into the backend store would need a dedicated
    // endpoint (out of scope for this round).
    if (entry.notebook_id) setNotebookId(entry.notebook_id);
  }, []);

  // Render the name-capture modal before anything else. Wrapping it under
  // ThemeProvider keeps the modal's dark mode in sync if the user has the
  // system on dark already.
  if (!userId) {
    return (
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <TooltipProvider delayDuration={200}>
          <UserPrompt onSubmit={setUserIdState} />
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  const selectedNotebook = notebooks.find((n) => n.id === notebookId);
  const sourcesPanelError = notebooksError ?? sourcesError;

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TooltipProvider delayDuration={200}>
        <SourcesProvider sources={sources}>
          <AppShell
            topBar={
              <TopBar
                notebooks={notebooks}
                notebooksLoading={notebooksLoading}
                selectedNotebookId={notebookId}
                onSelectNotebook={setNotebookId}
                userId={userId}
                history={history}
                onSelectHistory={handleSelectHistory}
              />
            }
            sidebar={
              <SourcesPanel
                sources={sources}
                loading={sourcesLoading}
                error={sourcesPanelError}
                notebookTitle={selectedNotebook?.title}
              />
            }
            studio={<StudioStub />}
          >
            {notebookId ? (
              <ChatPane
                notebookId={notebookId}
                notebookTitle={selectedNotebook?.title}
                onTurn={handleTurn}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {notebooks.length === 0 && !notebooksLoading
                  ? "这个 Google 账号还没有 notebook,先去 NotebookLM 网页里新建一个。"
                  : "请在顶栏选择一个 notebook。"}
              </div>
            )}
          </AppShell>
        </SourcesProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
