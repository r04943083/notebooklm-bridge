import { AlertCircle, RotateCw } from "lucide-react";
import { ThemeProvider } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { api, getUserId } from "@/api";
import { AppShell } from "@/components/AppShell";
import { ChatPane } from "@/components/ChatPane";
import { SourcesPanel } from "@/components/SourcesPanel";
import { StudioStub } from "@/components/StudioStub";
import { TopBar } from "@/components/TopBar";
import { UserPrompt } from "@/components/UserPrompt";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SourcesProvider } from "@/lib/chat-context";
import type { ChatTurn, HistoryEntry, Notebook, Source } from "@/types";

const HISTORY_KEY = "nblm_history";
const NOTEBOOK_KEY = "nblm_notebook_id";
const HISTORY_LIMIT = 20;
const TURNS_KEY_PREFIX = "nblm_turns:";

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

/** localStorage roundtrip for chat turns, keyed by conversation_id so the same
 *  conversation looks the same across notebook switches and page reloads. */
function loadTurns(conversationId: string): ChatTurn[] {
  try {
    const raw = localStorage.getItem(TURNS_KEY_PREFIX + conversationId);
    return raw ? (JSON.parse(raw) as ChatTurn[]) : [];
  } catch {
    return [];
  }
}

function appendTurn(conversationId: string, turn: ChatTurn): void {
  const cur = loadTurns(conversationId);
  cur.push(turn);
  try {
    localStorage.setItem(TURNS_KEY_PREFIX + conversationId, JSON.stringify(cur));
  } catch {
    // QuotaExceededError or storage disabled — drop silently; the user still
    // sees the turn in memory for this session.
  }
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

  // The currently active conversation. `null` means "fresh, no resumed state";
  // a string means "we are continuing / restoring this conversation_id". Used
  // (a) as part of the ChatPane key so a history-restore re-mounts it cleanly
  // with the right initial turns, and (b) when "new conversation" is clicked.
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null
  );
  const [initialTurns, setInitialTurns] = useState<ChatTurn[]>([]);

  // Load notebooks list. Extracted into a callback so the retry button on the
  // error UI can call it directly. The effect below kicks it on userId changes.
  const loadNotebooks = useCallback(() => {
    if (!userId) return () => {};
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
    // notebookId is read but intentionally not in deps — we only want this to
    // refire on userId change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    return loadNotebooks();
  }, [loadNotebooks]);

  // Fetch sources whenever the selected notebook changes. Also resets any
  // restored conversation — a different notebook's conversation_id is
  // meaningless here and would only confuse the next ask.
  useEffect(() => {
    if (!notebookId) {
      setSources([]);
      return;
    }
    localStorage.setItem(NOTEBOOK_KEY, notebookId);
    setActiveConversationId(null);
    setInitialTurns([]);
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
      // Persist the actual conversation content so that a future history-click
      // can rehydrate the turns list, not just the notebook.
      appendTurn(cid, turn);
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

  const handleSelectHistory = useCallback(async (entry: HistoryEntry) => {
    if (!entry.notebook_id || !entry.conversation_id) return;
    // Tell the backend to resume this conversation on the next ask — without
    // this, the next /api/chat call would use the (user, nb) → cid mapping
    // from the last active conversation, breaking the resume illusion.
    try {
      await api.selectConversation(entry.notebook_id, entry.conversation_id);
    } catch (e) {
      // Don't block the UI restore on backend errors; the user can still see
      // the turns. They'll get a real error on the next ask if needed.
      // eslint-disable-next-line no-console
      console.warn("selectConversation failed:", (e as Error).message);
    }
    const restored = loadTurns(entry.conversation_id);
    setNotebookId(entry.notebook_id);
    setActiveConversationId(entry.conversation_id);
    setInitialTurns(restored);
  }, []);

  const handleNewConversation = useCallback(async () => {
    if (!notebookId) return;
    try {
      await api.resetChat(notebookId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("resetChat failed:", (e as Error).message);
    }
    setActiveConversationId(null);
    setInitialTurns([]);
  }, [notebookId]);

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
        <SourcesProvider notebookId={notebookId || null} sources={sources}>
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
                key={`${notebookId}|${activeConversationId ?? "fresh"}`}
                notebookId={notebookId}
                notebookTitle={selectedNotebook?.title}
                initialTurns={initialTurns}
                onTurn={handleTurn}
                onNewConversation={handleNewConversation}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm">
                {notebooksError ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="flex items-center gap-2 text-destructive">
                      <AlertCircle className="size-4 shrink-0" />
                      <span>无法加载 notebooks:{notebooksError}</span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadNotebooks}
                      disabled={notebooksLoading}
                      className="gap-1.5"
                    >
                      <RotateCw className="size-3.5" />
                      重试
                    </Button>
                  </div>
                ) : notebooks.length === 0 && !notebooksLoading ? (
                  <span className="text-muted-foreground">
                    这个 Google 账号还没有 notebook,先去 NotebookLM 网页里新建一个。
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    请在顶栏选择一个 notebook。
                  </span>
                )}
              </div>
            )}
          </AppShell>
        </SourcesProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
