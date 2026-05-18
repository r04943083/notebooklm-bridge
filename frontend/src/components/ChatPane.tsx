import { AlertCircle, MessageSquareText, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/api";
import { CitationDrawer } from "@/components/CitationDrawer";
import { ChatComposer } from "@/components/ChatComposer";
import { ChatTurn } from "@/components/ChatTurn";
import { CitationViewerProvider } from "@/lib/chat-context";
import type { ChatRequest, ChatResponse, ChatTurn as ChatTurnType } from "@/types";

const EMPTY_TURNS: ChatTurnType[] = [];

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
  /** Turns to display when the pane mounts — used by App.tsx to rehydrate a
   *  conversation picked from the history popover. ChatPane remounts (via a
   *  `key` change in App.tsx) whenever the active conversation switches, so we
   *  only seed `turns` here in the initialiser, not in a follow-up effect. */
  initialTurns?: ChatTurnType[];
  onTurn: (turn: ChatTurnType) => void;
  /** Click of "new conversation". App.tsx owns the backend /chat/reset call
   *  and the activeConversationId reset so this pane is purely a view layer. */
  onNewConversation: () => void;
}

/**
 * Central conversation pane. Renders turns, drives /api/chat through
 * askWithRetry, and hosts the CitationDrawer.
 *
 * Conversation lifecycle is owned by App.tsx: switching notebooks or restoring
 * a history entry causes a key change on this component, which remounts it
 * with the new `initialTurns`. That keeps the resume / reset logic in one place
 * and avoids the "effect resets the turn that just arrived" footgun.
 */
export function ChatPane({
  notebookId,
  notebookTitle,
  initialTurns = EMPTY_TURNS,
  onTurn,
  onNewConversation,
}: ChatPaneProps) {
  const [turns, setTurns] = useState<ChatTurnType[]>(initialTurns);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

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
          onNewConversation={onNewConversation}
          loading={loading}
          disabled={!notebookId}
          hasTurns={turns.length > 0}
        />

        <CitationDrawer />
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
