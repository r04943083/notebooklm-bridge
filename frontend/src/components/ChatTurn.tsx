import { Sparkles } from "lucide-react";
import { MarkdownAnswer } from "@/components/MarkdownAnswer";
import { UserAvatar } from "@/components/UserAvatar";
import { useUser } from "@/lib/chat-context";
import type { ChatTurn as ChatTurnType } from "@/types";

interface ChatTurnProps {
  turn: ChatTurnType;
}

/**
 * Renders a single question-answer pair. User message on the right (bubble),
 * assistant response on the left (card with markdown body). Inline citation
 * chips inside the markdown are clickable — we deliberately do NOT render a
 * separate numbered list at the bottom (NotebookLM's UI doesn't either).
 */
export function ChatTurn({ turn }: ChatTurnProps) {
  const { question, response } = turn;
  const userId = useUser();

  return (
    <div className="space-y-3">
      {/* User question */}
      <div className="flex justify-end">
        <div className="flex max-w-[80%] items-start gap-2">
          <div className="rounded-2xl rounded-tr-md bg-accent px-4 py-2.5 text-sm text-accent-foreground shadow-sm">
            <p className="whitespace-pre-wrap">{question}</p>
          </div>
          <div className="mt-0.5">
            <UserAvatar id={userId} size="sm" />
          </div>
        </div>
      </div>

      {/* Assistant answer */}
      <div className="flex justify-start">
        <div className="flex w-full max-w-full items-start gap-2">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Sparkles className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3 text-card-foreground shadow-sm">
            <MarkdownAnswer
              text={response.answer}
              citations={response.citations}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
