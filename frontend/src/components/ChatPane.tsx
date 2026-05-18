import { AlertCircle, MessageSquareText, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/api";
import { CitationModal } from "@/components/CitationModal";
import { ChatComposer } from "@/components/ChatComposer";
import { ChatTurn } from "@/components/ChatTurn";
import { CitationViewerProvider } from "@/lib/chat-context";
import type { ChatRequest, ChatResponse, ChatTurn as ChatTurnType } from "@/types";

/**
 * api.ask with bounded exponential backoff on 504 (gateway timeout). 504 is
 * the only retryable status we get from the bridge — 503 always means either
 * "client not initialised" or "circuit open" / "upstream errored", none of
 * which clear within sub-second retries. 4xx / 429 are user-side errors and
 * must bubble immediately so the user sees the actual message.
 */
const RETRY_DELAYS_MS = [500, 1500] as const;
async function askWithRetry(req: ChatRequest): Promise<ChatResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.ask(req);
    } catch (e) {
      const retryable =
        e instanceof ApiError &&
        e.status === 504 &&
        attempt < RETRY_DELAYS_MS.length;
      if (!retryable) throw e;
      // eslint-disable-next-line no-console
      console.warn(
        `chat.ask 504 — retrying in ${RETRY_DELAYS_MS[attempt]}ms (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

interface ChatPaneProps {
  notebookId: string;
  notebookTitle?: string;
  onTurn: (turn: ChatTurnType) => void;
}

/**
 * Central conversation pane. Holds local turn state, calls /api/chat / reset,
 * scrolls to the newest message after each turn, and renders the per-chat
 * CitationModal under its own provider so chip clicks anywhere in the turn
 * stream open the same modal.
 *
 * State only lives in memory — closing the tab loses turns; rebuilding from
 * the backend store would require an /api/chat/history endpoint that we don't
 * have yet. The TopBar history popover bridges the gap by letting users see
 * past conversation IDs.
 */
export function ChatPane({ notebookId, notebookTitle, onTurn }: ChatPaneProps) {
  const [turns, setTurns] = useState<ChatTurnType[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lastNotebook = useRef(notebookId);

  // Switching notebooks resets the local conversation — backend Store still
  // keeps the (user, notebook) → conversation_id pair so the next ask resumes.
  useEffect(() => {
    if (lastNotebook.current !== notebookId) {
      setTurns([]);
      setError(null);
      lastNotebook.current = notebookId;
    }
  }, [notebookId]);

  // Pin scroll to bottom after each new turn.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  }, [turns.length, loading]);

  const submit = async (question: string) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await askWithRetry({ notebook_id: notebookId, question });
      const turn: ChatTurnType = { question, response: resp };
      setTurns((prev) => [...prev, turn]);
      onTurn(turn);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const newConversation = async () => {
    if (!notebookId) return;
    setError(null);
    try {
      await api.resetChat(notebookId);
      setTurns([]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <CitationViewerProvider>
      <div className="flex h-full min-h-0 flex-col">
        <div
          ref={scrollerRef}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div
            role="log"
            aria-live="polite"
            aria-atomic="false"
            aria-label="对话历史"
            className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6"
          >
            {turns.length === 0 && !loading && (
              <EmptyState notebookTitle={notebookTitle} />
            )}

            {turns.map((t, i) => (
              <ChatTurn key={i} turn={t} />
            ))}

            {loading && <ThinkingIndicator />}

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
            )}
          </div>
        </div>

        <ChatComposer
          onSubmit={submit}
          onNewConversation={newConversation}
          loading={loading}
          disabled={!notebookId}
          hasTurns={turns.length > 0}
        />

        <CitationModal />
      </div>
    </CitationViewerProvider>
  );
}

function EmptyState({ notebookTitle }: { notebookTitle?: string }) {
  return (
    <div className="mt-16 flex flex-col items-center gap-3 text-center">
      <div className="rounded-full bg-accent-soft p-3 text-accent">
        <Sparkles className="size-6" />
      </div>
      <h3 className="text-base font-semibold">
        {notebookTitle ? `开始向 ${notebookTitle} 提问` : "开始一段新对话"}
      </h3>
      <p className="max-w-sm text-sm text-muted-foreground">
        输入问题,NotebookLM 会基于你这个 notebook 里的所有来源回答,并标注引用。
      </p>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <MessageSquareText className="size-4" />
      <span className="inline-flex items-center gap-1">
        正在思考
        <span className="inline-flex">
          <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
          <span className="mx-0.5 h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
          <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground" />
        </span>
      </span>
    </div>
  );
}
