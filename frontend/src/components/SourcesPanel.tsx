import {
  AlertCircle,
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
  youtube: Youtube,
  video: Youtube,
  text: File,
  drive: File,
};

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
              {sources.map((src) => {
                const Icon =
                  (src.kind && KIND_ICON[src.kind.toLowerCase()]) || File;
                return (
                  <li key={src.id}>
                    <div className="group flex items-start gap-2.5 rounded-md p-2 transition-colors hover:bg-muted">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div
                          className="line-clamp-2 text-sm leading-snug"
                          title={src.title}
                        >
                          {src.title || src.id}
                        </div>
                        {src.kind && (
                          <Badge variant="soft" className="mt-1.5">
                            {src.kind}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
