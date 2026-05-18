import { Bot, User } from "lucide-react";
import { MarkdownAnswer } from "@/components/MarkdownAnswer";
import { CitationChip } from "@/components/CitationChip";
import { Separator } from "@/components/ui/separator";
import { useSourceLookup } from "@/lib/chat-context";
import type { ChatTurn as ChatTurnType } from "@/types";

interface ChatTurnProps {
  turn: ChatTurnType;
}

/**
 * Renders a single question-answer pair. User message on the right (bubble),
 * assistant response on the left (card with markdown body + numbered citation
 * list footer). The footer mirrors what NotebookLM's UI does — even though the
 * inline chips are clickable, surfacing the full list helps scan citations at
 * a glance.
 */
export function ChatTurn({ turn }: ChatTurnProps) {
  const { question, response } = turn;
  const lookup = useSourceLookup();

  return (
    <div className="space-y-3">
      {/* User question */}
      <div className="flex justify-end">
        <div className="flex max-w-[80%] items-start gap-2">
          <div className="rounded-2xl rounded-tr-md bg-accent px-4 py-2.5 text-sm text-accent-foreground shadow-sm">
            <p className="whitespace-pre-wrap">{question}</p>
          </div>
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <User className="size-3.5" />
          </div>
        </div>
      </div>

      {/* Assistant answer */}
      <div className="flex justify-start">
        <div className="flex max-w-[92%] items-start gap-2">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-soft-foreground">
            <Bot className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3 text-card-foreground shadow-sm">
            <MarkdownAnswer
              text={response.answer}
              citations={response.citations}
            />

            {response.citations.length > 0 && (
              <>
                <Separator className="my-3" />
                <ul className="space-y-1.5 text-xs">
                  {response.citations.map((c, i) => {
                    const src = lookup(c.source_id);
                    return (
                      <li key={i} className="flex gap-2">
                        <CitationChip n={i + 1} citation={c} />
                        <span className="min-w-0 flex-1">
                          <span
                            className="block truncate font-medium text-foreground"
                            title={src?.title || c.source_id}
                          >
                            {src?.title || c.source_id}
                          </span>
                          {c.text && (
                            <span className="block truncate text-muted-foreground">
                              {c.text}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
