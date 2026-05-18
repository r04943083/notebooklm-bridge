import { Loader2, RotateCcw, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChatComposerProps {
  onSubmit: (question: string) => void;
  onNewConversation: () => void;
  loading: boolean;
  disabled: boolean;
  /** Disables the new-conversation button when there's nothing to clear. */
  hasTurns: boolean;
}

const MAX_HEIGHT_PX = 220;

/**
 * Sticky bottom composer. Auto-grows the textarea up to `MAX_HEIGHT_PX` then
 * starts scrolling internally; Ctrl/Cmd+Enter submits while a plain Enter
 * inserts a newline (matches what most LLM chat UIs do).
 */
export function ChatComposer({
  onSubmit,
  onNewConversation,
  loading,
  disabled,
  hasTurns,
}: ChatComposerProps) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize: reset height then size to scrollHeight (capped).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [draft]);

  const submit = useCallback(() => {
    const q = draft.trim();
    if (!q || loading || disabled) return;
    onSubmit(q);
    setDraft("");
  }, [draft, loading, disabled, onSubmit]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  const canSubmit = !!draft.trim() && !loading && !disabled;

  return (
    <div className="border-t border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div
        className={cn(
          "mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm transition-shadow",
          "focus-within:border-accent/40 focus-within:shadow-md"
        )}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={
            disabled
              ? "请先选择一个 notebook"
              : "问问 NotebookLM…(Cmd/Ctrl + Enter 发送)"
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
            className="gap-1.5"
          >
            <RotateCcw className="size-3.5" />
            新对话
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={!canSubmit}
            className="gap-1.5"
          >
            {loading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                生成中…
              </>
            ) : (
              <>
                <Send className="size-3.5" />
                发送
              </>
            )}
          </Button>
        </div>
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-muted-foreground">
        问答内容会发送到 NotebookLM(Google)服务器,请勿粘贴敏感数据。
      </p>
    </div>
  );
}
