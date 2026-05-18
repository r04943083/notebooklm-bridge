import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  Quote,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useCitationViewer, useNotebookId, useSourceLookup } from "@/lib/chat-context";
import { cn } from "@/lib/utils";
import type { Citation, SourceFulltext } from "@/types";

/**
 * Right-side, non-modal Drawer for inspecting one citation in context.
 *
 * Design choices worth knowing:
 *  - `modal={false}` on Radix Dialog so the rest of the page stays interactive
 *    while the drawer is open. The original NotebookLM behaves the same way.
 *  - We bypass our `ui/dialog.tsx` DialogContent because that one centers and
 *    paints an overlay; here we want side-attached and no dim.
 *  - Fulltext is fetched per source_id with a tiny in-component cache so
 *    stepping between citations of the same source is instant.
 *  - Highlight uses substring search (`content.indexOf(cited.slice(0,40))`),
 *    mirroring upstream `SourceFulltext.find_citation_context`. `start_char` /
 *    `end_char` from the upstream are NOT positions in this fulltext per the
 *    library's own docstring, so we cannot slice with them.
 */
export function CitationDrawer() {
  const { active, close, prev, next } = useCitationViewer();
  const lookupSource = useSourceLookup();
  const notebookId = useNotebookId();

  const open = active !== null;
  const citation: Citation | undefined =
    active?.citations[active.index] ?? undefined;
  const total = active?.citations.length ?? 0;
  const source = citation ? lookupSource(citation.source_id) : undefined;
  const title = source?.title || citation?.source_id || "引用";

  // ---- fulltext: per source_id cache, refetch on source switch -------------
  const [fulltextBySource, setFulltextBySource] = useState<
    Record<string, SourceFulltext>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFulltext = useCallback(async () => {
    if (!notebookId || !citation) return;
    if (fulltextBySource[citation.source_id]) return;
    setLoading(true);
    setError(null);
    try {
      const ft = await api.getSourceFulltext(notebookId, citation.source_id);
      setFulltextBySource((cur) => ({ ...cur, [citation.source_id]: ft }));
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : (e as Error)?.message ?? String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [notebookId, citation, fulltextBySource]);

  useEffect(() => {
    if (!open || !citation) return;
    void loadFulltext();
  }, [open, citation, loadFulltext]);

  // ---- scroll highlight into view on every index change -------------------
  const markRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const el = markRef.current;
    if (!el) return;
    // requestAnimationFrame so the <mark> is in the DOM after the slice render
    requestAnimationFrame(() =>
      el.scrollIntoView({ block: "center", behavior: "smooth" })
    );
  }, [open, citation, fulltextBySource]);

  // ---- keyboard nav (← / →) — Radix already wires ESC=close ---------------
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, prev, next]);

  if (!active || !citation) return null;

  const fulltext = fulltextBySource[citation.source_id];
  const slices = sliceContent(fulltext?.content ?? "", citation.text);

  const copyCited = async () => {
    try {
      await navigator.clipboard.writeText(citation.text ?? "");
    } catch {
      // Clipboard may be blocked in some browsers; silent — user can select & copy manually
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && close()} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          // Right-side drawer; no overlay → main stays usable
          // pointer-events-auto on the panel; the parent <Portal> doesn't
          // dim because we omit DialogOverlay altogether.
          onInteractOutside={(e) => {
            // Stay open on outside clicks — close is X / ESC only,
            // matches the "modal=false but pinned" pattern.
            e.preventDefault();
          }}
          className={cn(
            "fixed inset-y-0 right-0 z-40 flex w-full max-w-[440px] flex-col",
            "border-l border-border bg-card shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right"
          )}
          aria-labelledby="citation-drawer-title"
        >
          <DrawerHeader
            index={active.index}
            total={total}
            onPrev={prev}
            onNext={next}
            onClose={close}
            kind={source?.kind ?? fulltext?.kind ?? undefined}
          />

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 px-4 py-4">
              <SourceHeader
                title={title}
                url={source?.url ?? fulltext?.url ?? null}
              />

              <CitedTextCard
                page={citation.page ?? null}
                text={citation.text ?? ""}
                onCopy={copyCited}
              />

              <Separator />

              <FulltextSection
                loading={loading}
                error={error}
                hasFulltext={!!fulltext}
                charCount={fulltext?.char_count}
                slices={slices}
                markRef={markRef}
                onRetry={loadFulltext}
                citedText={citation.text}
              />
            </div>
          </ScrollArea>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DrawerHeader({
  index,
  total,
  onPrev,
  onNext,
  onClose,
  kind,
}: {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  kind?: string;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-3 py-2">
      <Button
        variant="ghost"
        size="icon"
        onClick={onPrev}
        disabled={total <= 1 || index <= 0}
        aria-label="上一条引用(←)"
        className="size-7"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="min-w-[3rem] text-center text-xs font-medium text-muted-foreground">
        {index + 1} / {total}
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={onNext}
        disabled={total <= 1 || index >= total - 1}
        aria-label="下一条引用(→)"
        className="size-7"
      >
        <ChevronRight className="size-4" />
      </Button>
      {kind && (
        <Badge variant="soft" className="ml-2">
          {kind}
        </Badge>
      )}
      <DialogPrimitive.Close asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭"
          onClick={onClose}
          className="ml-auto size-7"
        >
          <X className="size-4" />
        </Button>
      </DialogPrimitive.Close>
    </div>
  );
}

function SourceHeader({ title, url }: { title: string; url: string | null }) {
  return (
    <div className="flex items-start gap-2">
      <Quote className="mt-1 size-4 shrink-0 text-accent" />
      <h2
        id="citation-drawer-title"
        className="flex-1 text-base font-semibold leading-snug"
        title={title}
      >
        {title}
      </h2>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`在新标签页打开原链接:${title}`}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ExternalLink className="size-4" />
        </a>
      )}
    </div>
  );
}

function CitedTextCard({
  page,
  text,
  onCopy,
}: {
  page: number | null;
  text: string;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant="soft">引用 {page ?? "?"}</Badge>
        <span className="text-xs text-muted-foreground">来自此问题答案</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCopy}
          disabled={!text}
          aria-label="复制引文"
          className="ml-auto h-7 gap-1.5 px-2 text-xs"
        >
          <Copy className="size-3.5" />
          复制
        </Button>
      </div>
      {text ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {text}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          这条引用没有附带可显示的原文段落。
        </p>
      )}
    </div>
  );
}

function FulltextSection({
  loading,
  error,
  hasFulltext,
  charCount,
  slices,
  markRef,
  onRetry,
  citedText,
}: {
  loading: boolean;
  error: string | null;
  hasFulltext: boolean;
  charCount: number | undefined;
  slices: ReturnType<typeof sliceContent>;
  markRef: React.MutableRefObject<HTMLElement | null>;
  onRetry: () => void;
  citedText: string | undefined;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold">源全文</h3>
        {hasFulltext && charCount != null && (
          <span className="text-[11px] text-muted-foreground">
            {charCount.toLocaleString("zh-CN")} 字符
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在拉取源全文…
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-col items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <div className="flex gap-2">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
          <Button variant="outline" size="sm" onClick={onRetry}>
            重试
          </Button>
        </div>
      )}

      {hasFulltext && !loading && !error && (
        <>
          <pre className="max-h-[55vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 p-3 font-sans text-sm leading-relaxed text-foreground">
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
              slices.pre
            )}
          </pre>
          {!slices.found && citedText && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              未在源全文中找到对应段落 — NotebookLM 在索引时可能截取或重新格式化了该引文,无法直接定位高亮位置。
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Highlight slicing — first 40 chars probe, mirroring upstream heuristic
// ---------------------------------------------------------------------------
function sliceContent(content: string, cited: string | undefined) {
  if (!content || !cited) {
    return { found: false, pre: content, mid: "", post: "" };
  }
  const probe = cited.slice(0, Math.min(40, cited.length));
  const idx = content.indexOf(probe);
  if (idx < 0) {
    return { found: false, pre: content, mid: "", post: "" };
  }
  const end = Math.min(content.length, idx + cited.length);
  return {
    found: true,
    pre: content.slice(0, idx),
    mid: content.slice(idx, end),
    post: content.slice(end),
  };
}
