import { Headphones, Sparkles } from "lucide-react";
import { Separator } from "@/components/ui/separator";

/**
 * Right-rail placeholder for the future Studio panel (Phase 4 — podcast / video
 * / report / quiz generation). Renders a friendly empty state so the layout
 * doesn't look broken in the meantime.
 */
export function StudioStub() {
  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border bg-card">
      <div className="flex items-center gap-2 px-4 py-3">
        <Sparkles className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Studio</h2>
      </div>
      <Separator />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <div className="rounded-full bg-muted p-3">
          <Headphones className="size-6" />
        </div>
        <p className="text-sm font-medium text-foreground">敬请期待</p>
        <p className="text-xs leading-relaxed">
          播客、视频、报告、问答测验等生成式内容将出现在这里 (Phase 4)。
        </p>
      </div>
    </aside>
  );
}
