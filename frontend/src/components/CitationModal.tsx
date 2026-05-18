import { ExternalLink, Quote, ScrollText } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FulltextViewer } from "@/components/FulltextViewer";
import { useCitationViewer, useSourceLookup } from "@/lib/chat-context";

/**
 * Renders the modal that opens when a CitationChip is clicked. Reads the
 * currently active citation from CitationViewerContext and joins it against the
 * notebook's source list (via SourcesContext) to recover the human-readable
 * source title — `ChatReference` from notebooklm-py 0.4.x does not carry the
 * title itself.
 *
 * From here the user can either:
 *  - open the source's original URL in a new tab (web / YouTube only — the
 *    upstream library does not expose URLs for PDFs / Drive files); or
 *  - drill into the source full text via the nested FulltextViewer.
 */
export function CitationModal() {
  const { active, close } = useCitationViewer();
  const lookupSource = useSourceLookup();
  const [fulltextOpen, setFulltextOpen] = useState(false);

  const source = active ? lookupSource(active.source_id) : undefined;
  const isOpen = active !== null;
  const title = source?.title || active?.source_id || "引用";

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(o) => !o && close()}>
        <DialogContent
          className="sm:max-w-xl"
          aria-labelledby="citation-modal-title"
        >
          <DialogHeader>
            <DialogTitle
              id="citation-modal-title"
              className="flex items-start gap-2 pr-8 text-base"
            >
              <Quote className="mt-1 size-4 shrink-0 text-accent" />
              <span className="leading-snug">{title}</span>
              {source?.url && (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`在新标签页打开原链接:${title}`}
                  className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ExternalLink className="size-4" />
                </a>
              )}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex items-center gap-2">
                {active && (
                  <Badge variant="soft">引用 {active.page ?? "?"}</Badge>
                )}
                {source?.kind && <Badge variant="outline">{source.kind}</Badge>}
                <span className="text-xs">来自此问题答案的引文</span>
              </div>
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="-mx-1 max-h-[60vh] rounded-md border border-border bg-muted/40 px-4 py-3">
            {active?.text ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {active.text}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                这条引用没有附带可显示的原文段落。
              </p>
            )}
          </ScrollArea>

          {active && (
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFulltextOpen(true)}
                className="gap-1.5"
              >
                <ScrollText className="size-3.5" />
                查看源全文
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Nested: only mount when needed. CitationModal stays open underneath. */}
      {active && (
        <FulltextViewer
          open={fulltextOpen}
          onOpenChange={setFulltextOpen}
          sourceId={active.source_id}
          citedText={active.text}
          sourceTitle={source?.title}
        />
      )}
    </>
  );
}
