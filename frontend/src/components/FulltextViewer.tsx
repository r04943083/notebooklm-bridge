import { AlertCircle, ExternalLink, Loader2, ScrollText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNotebookId } from "@/lib/chat-context";
import type { SourceFulltext } from "@/types";

interface FulltextViewerProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sourceId: string;
  /** Optional substring to locate and highlight in the fulltext. */
  citedText?: string;
  /** Fallback title used until the API call resolves. */
  sourceTitle?: string;
}

/**
 * Drill-down modal that shows the indexed full text of one source. Triggered
 * from CitationModal's "查看源全文" button; renders as a nested Radix Dialog so
 * closing it returns focus to the CitationModal cleanly.
 *
 * Highlighting strategy: `ChatReference.start_char/end_char` from the upstream
 * library reference NotebookLM's internal chunked index, *not* positions in
 * this fulltext (per upstream docstring). We mirror the upstream
 * `find_citation_context` heuristic instead — take the first 40 chars of the
 * cited text and `indexOf` against the content. If the upstream chunked the
 * citation differently we may miss; in that case we surface a small
 * explanatory note rather than guessing.
 */
export function FulltextViewer({
  open,
  onOpenChange,
  sourceId,
  citedText,
  sourceTitle,
}: FulltextViewerProps) {
  const notebookId = useNotebookId();
  const [data, setData] = useState<SourceFulltext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    if (!notebookId || !sourceId) return;
    setLoading(true);
    setError(null);
    try {
      const ft = await api.getSourceFulltext(notebookId, sourceId);
      setData(ft);
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : (e as Error)?.message ?? String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [notebookId, sourceId]);

  // Refetch every time the dialog opens for a new source (cheap and avoids a
  // stale view if the upstream content changed since last open). On close we
  // intentionally hold onto `data` for one render to avoid a jarring layout
  // shift while the close animation plays.
  useEffect(() => {
    if (!open) return;
    setData(null);
    void load();
  }, [open, load]);

  // Scroll the highlighted span into view once it mounts. Using a layout
  // effect would flash; smooth scroll on next frame feels right.
  useEffect(() => {
    if (data && markRef.current) {
      const el = markRef.current;
      requestAnimationFrame(() =>
        el.scrollIntoView({ block: "center", behavior: "smooth" })
      );
    }
  }, [data]);

  // Compute highlight slices. Empty `mid` means no match — render plain text.
  const slices = sliceContent(data?.content ?? "", citedText);

  const displayTitle = data?.title || sourceTitle || sourceId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl"
        aria-labelledby="fulltext-modal-title"
      >
        <DialogHeader>
          <DialogTitle
            id="fulltext-modal-title"
            className="flex items-center gap-2 pr-8 text-base"
          >
            <ScrollText className="size-4 shrink-0 text-accent" />
            <span className="line-clamp-1">{displayTitle}</span>
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-2">
              {data?.kind && <Badge variant="soft">{data.kind}</Badge>}
              {data?.char_count != null && (
                <span className="text-xs">
                  {data.char_count.toLocaleString("zh-CN")} 字符
                </span>
              )}
              {data?.url && (
                <a
                  href={data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  <ExternalLink className="size-3" />
                  打开原链接
                </a>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在拉取源全文…
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <div className="flex gap-2">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        )}

        {data && !loading && !error && (
          <ScrollArea className="max-h-[60vh] rounded-md border border-border bg-muted/40 px-4 py-3">
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">
              {slices.found ? (
                <>
                  {slices.pre}
                  <mark
                    ref={markRef}
                    className="rounded bg-amber-200/60 px-0.5 text-amber-950 dark:bg-amber-300/30 dark:text-amber-50"
                  >
                    {slices.mid}
                  </mark>
                  {slices.post}
                </>
              ) : (
                data.content
              )}
            </pre>
            {!slices.found && citedText && (
              <p className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
                未在源全文中找到对应段落 — NotebookLM 在索引时可能截取或重新格式化了该引文,无法直接定位高亮位置。
              </p>
            )}
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Substring search using the first 40 chars of `cited` as a probe — matches
 * the heuristic upstream uses in ``SourceFulltext.find_citation_context``.
 * Returns the three slices and a `found` flag for highlight rendering.
 */
function sliceContent(content: string, cited: string | undefined) {
  if (!content || !cited) {
    return { found: false, pre: content, mid: "", post: "" };
  }
  const probe = cited.slice(0, Math.min(40, cited.length));
  const idx = content.indexOf(probe);
  if (idx < 0) {
    return { found: false, pre: content, mid: "", post: "" };
  }
  // Highlight the full cited length where possible (or until end of content).
  const end = Math.min(content.length, idx + cited.length);
  return {
    found: true,
    pre: content.slice(0, idx),
    mid: content.slice(idx, end),
    post: content.slice(end),
  };
}
