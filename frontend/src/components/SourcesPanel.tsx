import {
  AlertCircle,
  ExternalLink,
  File,
  FileText,
  Globe,
  Layers,
  Loader2,
  Youtube,
} from "lucide-react";
import type { ComponentType } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useCitationViewer } from "@/lib/chat-context";
import { cn } from "@/lib/utils";
import type { Source } from "@/types";

interface SourcesPanelProps {
  sources: Source[];
  loading: boolean;
  error: string | null;
  notebookTitle?: string;
}

/** Map source kind → icon. Unknown kinds fall back to a generic file icon. */
const KIND_ICON: Record<string, ComponentType<{ className?: string }>> = {
  pdf: FileText,
  url: Globe,
  web_page: Globe,
  youtube: Youtube,
  video: Youtube,
  text: File,
  drive: File,
};

/**
 * Render an upstream ISO datetime as a short Chinese relative-time string.
 * Stays inline (no dayjs / date-fns) because the formatting is dead simple.
 */
function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12) return `${diffMon} 个月前`;
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function SourcesPanel({
  sources,
  loading,
  error,
  notebookTitle,
}: SourcesPanelProps) {
  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2 px-4 py-3">
        <Layers className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">来源</h2>
        {sources.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            {sources.length} 项
          </span>
        )}
      </div>
      {notebookTitle && (
        <div className="line-clamp-2 px-4 pb-2 text-xs text-muted-foreground" title={notebookTitle}>
          {notebookTitle}
        </div>
      )}
      <Separator />

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {loading && (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              加载来源…
            </div>
          )}
          {error && (
            <div className="m-1 flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              <AlertCircle className="size-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}
          {!loading && !error && sources.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              这个 notebook 暂时没有来源,先去 NotebookLM 网页里上传。
            </div>
          )}
          {!loading && !error && sources.length > 0 && (
            <ul className="space-y-1">
              {sources.map((src) => (
                <li key={src.id}>
                  <SourceRow source={src} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}

/**
 * One row in the sources list.
 *   - web / YouTube (has `source.url`) → `<a>` opening in a new tab
 *   - everything else (PDF / Drive / text) → `<button>` opening the
 *     CitationDrawer in source-mode, which shows the source's fulltext.
 *     Upstream `notebooklm-py 0.4.1` doesn't return the original binary or
 *     embedded images, so the Drawer shows OCR'd / extracted text only and
 *     includes a note pointing the user to the NotebookLM web app for figures.
 */
function SourceRow({ source: src }: { source: Source }) {
  const Icon = (src.kind && KIND_ICON[src.kind.toLowerCase()]) || File;
  const relTime = formatRelativeTime(src.created_at);
  const isLink = !!src.url;
  const { openSource } = useCitationViewer();

  const inner = (
    <>
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1.5">
          <div
            className="line-clamp-2 flex-1 text-sm leading-snug"
            title={src.title}
          >
            {src.title || src.id}
          </div>
          {isLink && (
            <ExternalLink
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-accent"
              aria-hidden="true"
            />
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {src.kind && <Badge variant="soft">{src.kind}</Badge>}
          {src.status === "processing" && (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              处理中
            </Badge>
          )}
          {src.status === "error" && (
            <Badge variant="destructive" className="gap-1">
              <AlertCircle className="size-3" />
              失败
            </Badge>
          )}
          {relTime && (
            <span className="text-[10px] text-muted-foreground/80">
              {relTime}
            </span>
          )}
        </div>
      </div>
    </>
  );

  const baseCls =
    "group flex w-full items-start gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  if (isLink) {
    return (
      <a
        href={src.url ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(baseCls)}
        title={`在新标签页打开:${src.url}`}
      >
        {inner}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => openSource(src.id)}
      className={cn(baseCls, "cursor-pointer")}
      title={`查看《${src.title || src.id}》的全文`}
    >
      {inner}
    </button>
  );
}
