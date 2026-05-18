import { Sparkles, UserCircle2 } from "lucide-react";
import { useState } from "react";
import { setUserId } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface UserPromptProps {
  /** Kept for compatibility but unused: we reload so all per-user state
   *  initialisers in App.tsx pick up the new userId from localStorage. */
  onSubmit?: (userId: string) => void;
}

/**
 * Hard-gate dialog shown on first visit (or after "switch user" / cleared
 * localStorage) to capture an internal name / 工号. This is purely for per-user
 * session isolation in the backend Store — never sent to Google.
 *
 * Non-dismissible: blocking the entire app behind this is the whole point.
 * Validation mirrors the backend `require_internal_user` rules (max 64, no
 * pipe, no control chars) so we fail fast in the browser.
 *
 * Submission strategy: we write to localStorage and trigger a full page
 * reload. That way the lazy `useState` initialisers in App.tsx (history,
 * activeConversationId, notebookId, initialTurns) read from `nblm_*:<userId>`
 * keys for the NEW userId — without a reload they'd stay frozen at whatever
 * userId mounted the component (typically the empty string).
 */
export function UserPrompt({ onSubmit }: UserPromptProps) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = () => {
    const v = name.trim();
    if (!v) {
      setErr("请填写名字或工号");
      return;
    }
    if (v.length > 64) {
      setErr("不能超过 64 个字符");
      return;
    }
    if (v.includes("|")) {
      setErr("不能包含 | 字符");
      return;
    }
    if (/[\r\n\t]/.test(v)) {
      setErr("不能包含换行 / 制表符");
      return;
    }
    setUserId(v);
    onSubmit?.(v);
    // Full reload so all per-user lazy initialisers (history, activeCid,
    // turns, notebookId) pick up `nblm_*:${v}` keys for the new identity.
    window.location.reload();
  };

  return (
    <Dialog open>
      <DialogContent
        hideCloseButton
        // Prevent ESC / overlay-click from dismissing — login is a hard gate.
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="size-5 text-accent" />
            <DialogTitle>欢迎使用 NotebookLM Bridge</DialogTitle>
          </div>
          <DialogDescription>
            请输入你的名字或工号(仅用于会话隔离,不会发给 Google)。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="relative">
            <UserCircle2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (err) setErr(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              autoFocus
              maxLength={64}
              placeholder="例如 zhangsan / 12345"
              aria-invalid={err ? "true" : undefined}
              aria-describedby={err ? "user-prompt-error" : undefined}
              className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-accent/40 focus:ring-2 focus:ring-ring/20"
            />
          </div>
          {err && (
            <p
              id="user-prompt-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {err}
            </p>
          )}
        </div>

        <Button type="button" onClick={handleSubmit} className="w-full">
          开始使用
        </Button>
      </DialogContent>
    </Dialog>
  );
}
