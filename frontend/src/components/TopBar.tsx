import { BookOpen, Check, ChevronDown, History, User } from "lucide-react";
import { BridgeLogo } from "@/components/BridgeLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { HistoryEntry, Notebook } from "@/types";

interface TopBarProps {
  notebooks: Notebook[];
  notebooksLoading: boolean;
  selectedNotebookId: string;
  onSelectNotebook: (id: string) => void;

  userId: string;

  history: HistoryEntry[];
  onSelectHistory: (entry: HistoryEntry) => void;
}

export function TopBar({
  notebooks,
  notebooksLoading,
  selectedNotebookId,
  onSelectNotebook,
  userId,
  history,
  onSelectHistory,
}: TopBarProps) {
  const selected = notebooks.find((n) => n.id === selectedNotebookId);
  const filteredHistory = selectedNotebookId
    ? history.filter((h) => h.notebook_id === selectedNotebookId)
    : history;

  return (
    <header className="col-span-3 flex h-14 items-center gap-3 border-b border-border bg-background px-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <BridgeLogo className="size-6" />
        <span>NotebookLM Bridge</span>
      </div>

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* Notebook picker */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="max-w-[260px] justify-between gap-2 font-medium"
            disabled={notebooksLoading}
          >
            <span className="flex min-w-0 items-center gap-2">
              <BookOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {notebooksLoading
                  ? "加载中…"
                  : selected
                    ? selected.title
                    : notebooks.length === 0
                      ? "暂无 notebook"
                      : "选择 notebook"}
              </span>
            </span>
            <ChevronDown className="size-4 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[260px] max-w-md">
          <DropdownMenuLabel>切换 notebook</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {notebooks.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              这个账号还没有 notebook。
            </div>
          )}
          {notebooks.map((nb) => (
            <DropdownMenuItem
              key={nb.id}
              onSelect={() => onSelectNotebook(nb.id)}
              className="gap-2"
            >
              <Check
                className={
                  nb.id === selectedNotebookId
                    ? "size-4 text-accent"
                    : "size-4 opacity-0"
                }
              />
              <span className="flex-1 truncate" title={nb.title}>
                {nb.title}
              </span>
              {typeof nb.sources_count === "number" && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {nb.sources_count} 源
                </span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex items-center gap-1">
        {/* History popover */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2"
              aria-label="历史会话"
              title="历史会话"
            >
              <History className="size-4" />
              <span className="hidden sm:inline">历史</span>
              {filteredHistory.length > 0 && (
                <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-soft px-1 text-xs font-medium text-accent-soft-foreground">
                  {filteredHistory.length}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              当前 notebook 历史会话(localStorage)
            </div>
            <ScrollArea className="max-h-72">
              {filteredHistory.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  暂无历史会话
                </div>
              ) : (
                <ul className="p-1">
                  {filteredHistory
                    .slice()
                    .sort((a, b) => b.ts - a.ts)
                    .map((entry) => (
                      <li key={entry.conversation_id}>
                        <button
                          type="button"
                          onClick={() => onSelectHistory(entry)}
                          className="w-full rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                        >
                          <div className="line-clamp-2 text-foreground">
                            {entry.first_question || "(空标题)"}
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {new Date(entry.ts).toLocaleString("zh-CN")}
                          </div>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </ScrollArea>
          </PopoverContent>
        </Popover>

        <ThemeToggle />

        {/* User chip */}
        <div className="ml-1 flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs">
          <User className="size-3.5 text-muted-foreground" />
          <span className="font-medium" title={`X-User-Id: ${userId}`}>
            {userId}
          </span>
        </div>
      </div>
    </header>
  );
}
