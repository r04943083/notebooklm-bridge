import { RotateCcw, Send, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChatComposerProps {
  onSubmit: (question: string) => void;
  onNewConversation: () => void;
  /** Called when the user clicks "终止". Required because the submit button
   *  swaps to a stop button while loading. */
  onAbort: () => void;
  loading: boolean;
  disabled: boolean;
  /** Disables the new-conversation button when there's nothing to clear. */
  hasTurns: boolean;
  /** When non-empty AND loading just went false (e.g. after an abort), the
   *  composer restores `restoreDraft` into the textarea so the user can edit
   *  and re-send. ChatPane clears this via `onDraftRestored` once consumed. */
  restoreDraft?: string;
  onDraftRestored?: () => void;
}

const MAX_HEIGHT_PX = 220;

/**
 * Sticky bottom composer. Auto-grows the textarea up to `MAX_HEIGHT_PX` then
 * starts scrolling internally; plain Enter submits, Shift/Ctrl/Cmd+Enter
 * inserts a newline (matches what NotebookLM, ChatGPT, Claude all do).
 *
 * IME safety: when a Chinese/Japanese IME is composing, Enter selects a
 * candidate. `e.nativeEvent.isComposing` is the cross-browser way to tell —
 * older Safari sometimes still reports `e.key === "Enter"` during composition,
 * so we bail on `isComposing` even though most browsers also surface
 * `e.key === "Process"`.
 *
 * Abort UX: while a request is in flight the send button becomes a "终止"
 * button (Square icon). On abort, ChatPane hands back the original question
 * via `restoreDraft` so we can repopulate the textarea — the user can tweak
 * it and re-send instead of retyping.
 */
export function ChatComposer({
  onSubmit,
  onNewConversation,
  onAbort,
  loading,
  disabled,
  hasTurns,
  restoreDraft,
  onDraftRestored,
}: ChatComposerProps) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Tracks the previous `loading` so we only fire the restore effect on a
   *  true → false transition (abort or completion), not on initial mount. */
  const prevLoadingRef = useRef(loading);

  // Auto-resize: reset height then size to scrollHeight (capped).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [draft]);

  // After loading completes, if ChatPane has a `restoreDraft` queued (meaning
  // the last submit was aborted), put the original question back so the user
  // can edit and re-send.
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (wasLoading && !loading && restoreDraft) {
      setDraft(restoreDraft);
      onDraftRestored?.();
      // Refocus the textarea so the user can keep typing.
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [loading, restoreDraft, onDraftRestored]);

  const submit = useCallback(() => {
    const q = draft.trim();
    if (!q || loading || disabled) return;
    onSubmit(q);
    setDraft("");
  }, [draft, loading, disabled, onSubmit]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    if (e.nativeEvent.isComposing) return; // IME composition — don't intercept
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return; // newline
    e.preventDefault();
    submit();
  };

  const canSubmit = !!draft.trim() && !loading && !disabled;

  return (
    <div className="border-t border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div
        className={cn(
          "mx-auto flex max-w-5xl flex-col gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm transition-shadow",
          "focus-within:border-accent/40 focus-within:shadow-md"
        )}
      >
        <label htmlFor="chat-composer-textarea" className="sr-only">
          提问内容
        </label>
        <textarea
          ref={textareaRef}
          id="chat-composer-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={
            disabled
              ? "请先选择一个 notebook"
              : "问问 NotebookLM…(Enter 发送,Shift/Ctrl+Enter 换行)"
          }
          disabled={disabled}
          className={cn(
            "w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-60",
            "min-h-[2.25rem]"
          )}
          style={{ maxHeight: MAX_HEIGHT_PX }}
        />
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onNewConversation}
            disabled={loading || !hasTurns}
            aria-label="开始新对话(清空当前会话)"
            className="gap-1.5"
          >
            <RotateCcw className="size-3.5" />
            新对话
          </Button>
          {loading ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAbort}
              aria-label="终止当前请求"
              className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/5 hover:text-destructive"
            >
              <Square className="size-3.5 fill-current" />
              终止
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={submit}
              disabled={!canSubmit}
              aria-label="发送(Enter)"
              className="gap-1.5"
            >
              <Send className="size-3.5" />
              发送
            </Button>
          )}
        </div>
      </div>
      <p className="mx-auto mt-2 max-w-5xl text-center text-[11px] text-muted-foreground">
        问答内容会发送到 NotebookLM(Google)服务器,请勿粘贴敏感数据。
        <span className="mx-1.5 opacity-50">·</span>
        <span className="opacity-70">
          notebooklm-bridge v{__APP_VERSION__} · built by luyh
        </span>
      </p>
    </div>
  );
}
