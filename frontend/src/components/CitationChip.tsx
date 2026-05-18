import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCitationViewer, useSourceLookup } from "@/lib/chat-context";
import type { Citation } from "@/types";

interface CitationChipProps {
  n: number;
  citation: Citation | undefined;
  className?: string;
}

/**
 * Inline [n] citation marker rendered inside the answer text. Clicking it opens
 * the CitationModal with the corresponding excerpt. Tooltip on hover previews
 * the source title (joined from SourcesContext when available).
 *
 * Falls back to a dimmed unclickable chip if the answer references a citation
 * number that the upstream didn't include in `references` — defensive against
 * mid-stream upstream weirdness.
 */
export function CitationChip({ n, citation, className }: CitationChipProps) {
  const { open } = useCitationViewer();
  const lookup = useSourceLookup();

  const sourceTitle = citation ? lookup(citation.source_id)?.title : undefined;
  const tooltipLabel = sourceTitle || citation?.source_id || `引用 ${n}`;

  if (!citation) {
    return (
      <span
        aria-label={`引用 ${n}(无元数据)`}
        className="mx-0.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded px-1 text-[11px] font-medium text-muted-foreground/70 ring-1 ring-inset ring-border"
      >
        {n}
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => open(citation)}
          aria-label={`查看引用 ${n}:${tooltipLabel}`}
          className={cn(
            "mx-0.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded px-1 text-[11px] font-medium transition-colors",
            "bg-accent-soft text-accent-soft-foreground ring-1 ring-inset ring-accent/15",
            "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className
          )}
        >
          {n}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <span className="line-clamp-3 text-xs">{tooltipLabel}</span>
      </TooltipContent>
    </Tooltip>
  );
}
