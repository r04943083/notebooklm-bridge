import { Quote } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useCitationViewer, useSourceLookup } from "@/lib/chat-context";

/**
 * Renders the modal that opens when a CitationChip is clicked. Reads the
 * currently active citation from CitationViewerContext and joins it against the
 * notebook's source list (via SourcesContext) to recover the human-readable
 * source title — `ChatReference` from notebooklm-py 0.4.x does not carry the
 * title itself.
 */
export function CitationModal() {
  const { active, close } = useCitationViewer();
  const lookupSource = useSourceLookup();

  const source = active ? lookupSource(active.source_id) : undefined;
  const isOpen = active !== null;

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2 pr-8 text-base">
            <Quote className="mt-1 size-4 shrink-0 text-accent" />
            <span className="leading-snug">
              {source?.title || active?.source_id || "引用"}
            </span>
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            {active && (
              <Badge variant="soft">引用 {active.page ?? "?"}</Badge>
            )}
            {source?.kind && <Badge variant="outline">{source.kind}</Badge>}
            <span className="text-xs">来自此问题答案的引文</span>
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
      </DialogContent>
    </Dialog>
  );
}
