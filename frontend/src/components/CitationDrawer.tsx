import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Info,
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
 * Right-side, non-modal Drawer with two modes:
 *  - "citation": opened from a chip [n] inside an answer. Shows the cited
 *    snippet card on top, then the source's fulltext underneath with the
 *    cited segment highlighted (best-effort substring match).
 *  - "source":   opened from a PDF / Drive row in SourcesPanel. Shows the
 *    fulltext only, plus a footer note that upstream doesn't return
 *    embedded images / charts (NotebookLM's web UI does, we can't).
 *
 * Both modes share:
 *  - `modal={false}` on Radix Dialog so the main pane stays interactive.
 *  - Bypass our `ui/dialog.tsx` DialogContent (which centers and dims) and
 *    render DialogPrimitive.Content directly at the right edge.
 *  - Per-source_id fulltext cache, so stepping prev/next within the same
 *    source is instant.
 *  - Substring-based highlight (citation mode only). Upstream's
 *    `start_char` / `end_char` are NOT positions in the fulltext per the
 *    library's own docstring — they index NotebookLM's internal chunks.
 */
export function CitationDrawer() {
  const { active, close, prev, next } = useCitationViewer();
  const lookupSource = useSourceLookup();
  const notebookId = useNotebookId();

  const isCitation = active?.mode === "citation";
  const isSource = active?.mode === "source";

  const citation: Citation | undefined =
    active?.mode === "citation" ? active.citations[active.index] : undefined;
  const total = active?.mode === "citation" ? active.citations.length : 0;
  const sourceId =
    active?.mode === "citation"
      ? citation?.source_id
      : active?.mode === "source"
        ? active.sourceId
        : undefined;

  const source = sourceId ? lookupSource(sourceId) : undefined;
  const open = active !== null;

  // ---- fulltext: per source_id cache, refetch on source switch -------------
  const [fulltextBySource, setFulltextBySource] = useState<
    Record<string, SourceFulltext>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFulltext = useCallback(async () => {
    if (!notebookId || !sourceId) return;
    if (fulltextBySource[sourceId]) return;
    setLoading(true);
    setError(null);
    try {
      const ft = await api.getSourceFulltext(notebookId, sourceId);
      setFulltextBySource((cur) => ({ ...cur, [sourceId]: ft }));
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : (e as Error)?.message ?? String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [notebookId, sourceId, fulltextBySource]);

  useEffect(() => {
    if (!open || !sourceId) return;
    void loadFulltext();
  }, [open, sourceId, loadFulltext]);

  // ---- scroll highlight into view on every index change -------------------
  const markRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const el = markRef.current;
    if (!el) return;
    requestAnimationFrame(() =>
      el.scrollIntoView({ block: "center", behavior: "smooth" })
    );
  }, [open, citation, fulltextBySource]);

  // ---- keyboard nav (← / →) — citation mode only --------------------------
  useEffect(() => {
    if (!open || !isCitation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, isCitation, prev, next]);

  if (!active) return null;

  const fulltext = sourceId ? fulltextBySource[sourceId] : undefined;
  const title = source?.title || fulltext?.title || sourceId || "来源";
  // sliceContent is O(n) per fulltext (~150KB max); the few-ms cost per render
  // is well below the visual budget, so we don't bother memoising.
  const slices = isCitation
    ? sliceContent(fulltext?.content ?? "", citation?.text)
    : { found: false as const, pre: fulltext?.content ?? "", mid: "", post: "" };

  const copyCited = async () => {
    try {
      await navigator.clipboard.writeText(citation?.text ?? "");
    } catch {
      // Clipboard may be blocked — fall back to select-and-copy by hand
    }
  };

  const copyFulltext = async () => {
    try {
      await navigator.clipboard.writeText(fulltext?.content ?? "");
    } catch {
      // ditto
    }
  };

  // Build the NotebookLM web-app link for this notebook so the source-mode
  // footer can deep-link the user out for the "see the PDF with images" case.
  const notebookLmHref = notebookId
    ? `https://notebooklm.google.com/notebook/${notebookId}`
    : "https://notebooklm.google.com/";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && close()} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          onInteractOutside={(e) => {
            e.preventDefault();
          }}
          className={cn(
            "fixed inset-y-0 right-0 z-40 flex w-full max-w-[520px] flex-col",
            "border-l border-border bg-card shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right"
          )}
          aria-labelledby="citation-drawer-title"
        >
          <DrawerHeader
            mode={active.mode}
            index={isCitation && active.mode === "citation" ? active.index : 0}
            total={total}
            onPrev={prev}
            onNext={next}
            onClose={close}
            onCopyAll={isSource ? copyFulltext : undefined}
            kind={source?.kind ?? fulltext?.kind ?? undefined}
          />

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 px-4 py-4">
              <SourceHeader
                title={title}
                url={source?.url ?? fulltext?.url ?? null}
              />

              {isCitation && citation && (
                <>
                  <CitedTextCard
                    page={citation.page ?? null}
                    text={citation.text ?? ""}
                    onCopy={copyCited}
                  />
                  <Separator />
                </>
              )}

              <FulltextSection
                mode={active.mode}
                loading={loading}
                error={error}
                hasFulltext={!!fulltext}
                charCount={fulltext?.char_count}
                slices={slices}
                markRef={markRef}
                onRetry={loadFulltext}
                citedText={citation?.text}
              />
            </div>
          </ScrollArea>

          {isSource && (
            <div className="border-t border-border bg-muted/40 px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
              <div className="flex items-start gap-1.5">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">
                  上游 API 不返回 PDF 里的图像 / 图表,如需查看原文图请到{" "}
                  <a
                    href={notebookLmHref}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-accent"
                  >
                    NotebookLM 网页 ↗
                  </a>{" "}
                  打开。
                </span>
              </div>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DrawerHeader({
  mode,
  index,
  total,
  onPrev,
  onNext,
  onClose,
  onCopyAll,
  kind,
}: {
  mode: "citation" | "source";
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onCopyAll?: () => void;
  kind?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 border-b border-border px-3 py-2">
      {mode === "citation" ? (
        <>
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
        </>
      ) : (
        <span className="text-xs font-medium text-muted-foreground">
          来源全文
        </span>
      )}
      {kind && (
        <Badge variant="soft" className="ml-2 shrink-0">
          {kind}
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-1">
        {onCopyAll && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopyAll}
            aria-label="复制全文"
            className="h-7 gap-1.5 px-2 text-xs"
          >
            <Copy className="size-3.5" />
            复制全文
          </Button>
        )}
        <DialogPrimitive.Close asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭"
            onClick={onClose}
            className="size-7"
          >
            <X className="size-4" />
          </Button>
        </DialogPrimitive.Close>
      </div>
    </div>
  );
}

function SourceHeader({ title, url }: { title: string; url: string | null }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Quote className="mt-1 size-4 shrink-0 text-accent" />
      <h2
        id="citation-drawer-title"
        className="min-w-0 flex-1 break-words text-base font-semibold leading-snug"
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
      <div className="mb-2 flex flex-wrap items-center gap-2">
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
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
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
  mode,
  loading,
  error,
  hasFulltext,
  charCount,
  slices,
  markRef,
  onRetry,
  citedText,
}: {
  mode: "citation" | "source";
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
    <div className="min-w-0">
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
          <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/60 p-3 font-sans text-sm leading-relaxed text-foreground">
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
          {mode === "citation" && !slices.found && citedText && (
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
// Highlight slicing — 4-level fallback for citation mode
//
// Why so many levels: upstream's `cited_text` is the chunk NotebookLM picked
// for this citation, but the fulltext we get back from `get_fulltext()` is
// the source's *flat* text — they often differ in whitespace, line breaks,
// and small edits. A naive `indexOf(cited.slice(0, 40))` misses ~5-10% of
// cases. We retry with shorter probes and a whitespace-normalised match
// before giving up.
// ---------------------------------------------------------------------------

interface Slices {
  found: boolean;
  pre: string;
  mid: string;
  post: string;
}

function sliceContent(content: string, cited: string | undefined): Slices {
  if (!content || !cited) {
    return { found: false, pre: content, mid: "", post: "" };
  }

  // L1: original 40-char prefix (fast path, ~90% of citations)
  let idx = content.indexOf(cited.slice(0, Math.min(40, cited.length)));

  // L2: shorter 25-char prefix (some reformat affects beyond char 25)
  if (idx < 0 && cited.length >= 25) {
    idx = content.indexOf(cited.slice(0, 25));
  }

  // L3: whitespace-normalised match — collapses `\s+` to one space on both
  //     sides, runs indexOf, then maps the normalised offset back to the
  //     original content offset via a precomputed index map.
  if (idx < 0) {
    const probe = cited
      .slice(0, Math.min(40, cited.length))
      .replace(/\s+/g, " ")
      .trim();
    idx = findNormalized(content, probe);
  }

  // L4: 15-char fallback for very heavily reformatted citations
  if (idx < 0 && cited.length >= 15) {
    idx = content.indexOf(cited.slice(0, 15));
  }

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

/**
 * Walk `content`, collapse runs of whitespace to a single space, and remember
 * each normalised character's original index. Then `indexOf(probe)` against
 * the normalised string and translate back. O(n), fast enough for ~150KB
 * fulltexts on a typical chat thread.
 */
function findNormalized(content: string, probe: string): number {
  if (!probe) return -1;
  const norm: string[] = [];
  const map: number[] = [];
  let prevWs = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const isWs = c === " " || c === "\t" || c === "\n" || c === "\r";
    if (isWs) {
      if (!prevWs && norm.length > 0) {
        norm.push(" ");
        map.push(i);
      }
      prevWs = true;
    } else {
      norm.push(c);
      map.push(i);
      prevWs = false;
    }
  }
  const j = norm.join("").indexOf(probe);
  return j < 0 ? -1 : map[j];
}
