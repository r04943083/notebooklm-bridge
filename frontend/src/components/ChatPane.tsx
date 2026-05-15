// The main Q&A pane. Owns the in-memory conversation (turns) for the currently
// selected notebook. Server keeps the authoritative conversation_id; we only
// resend it implicitly by including X-User-Id (the backend's Store maps
// (user_id, notebook_id) → conversation_id).

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ChatTurn, HistoryEntry } from "../types";

interface Props {
  notebookId: string;
  onTurn: (turn: ChatTurn) => void;
}

export default function ChatPane({ notebookId, onTurn }: Props) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lastNotebook = useRef(notebookId);

  // Clear local view when the notebook changes — server-side context still lives
  // in the backend Store keyed on (user, notebook).
  useEffect(() => {
    if (lastNotebook.current !== notebookId) {
      setTurns([]);
      setErr(null);
      lastNotebook.current = notebookId;
    }
  }, [notebookId]);

  const submit = async (reset = false) => {
    const q = question.trim();
    if (!q || !notebookId || loading) return;
    setLoading(true);
    setErr(null);
    try {
      const resp = await api.ask({ notebook_id: notebookId, question: q, reset });
      const turn: ChatTurn = { question: q, response: resp };
      setTurns((prev) => [...prev, turn]);
      onTurn(turn);
      setQuestion("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const newConversation = async () => {
    if (!notebookId) return;
    try {
      await api.resetChat(notebookId);
      setTurns([]);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="chat-pane">
      <div className="chat-history">
        {turns.length === 0 && (
          <div className="hint">尚无对话。提问下方的输入框开始。</div>
        )}
        {turns.map((t, i) => (
          <ChatTurnView key={i} turn={t} />
        ))}
        {loading && <div className="loading">等待 NotebookLM 回复 …</div>}
        {err && <div className="error">错误:{err}</div>}
      </div>
      <div className="chat-input">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
          }}
          placeholder="输入问题(Ctrl/Cmd+Enter 发送)"
          rows={3}
          disabled={loading}
        />
        <div className="chat-buttons">
          <button onClick={() => submit()} disabled={loading || !question.trim()}>
            发送
          </button>
          <button onClick={newConversation} disabled={loading}>
            新对话
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatTurnView({ turn }: { turn: ChatTurn }) {
  return (
    <div className="turn">
      <div className="q">
        <strong>问:</strong>
        <span>{turn.question}</span>
      </div>
      <div className="a">
        <strong>答:</strong>
        <p>{renderAnswerWithCitations(turn.response.answer)}</p>
      </div>
      {turn.response.citations.length > 0 && (
        <ol className="citations">
          {turn.response.citations.map((c, i) => (
            <li key={i}>
              <strong>[{i + 1}]</strong> {c.source_title}
              {c.page != null && ` p.${c.page}`}
              {c.text && <span className="snippet"> — {c.text}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function renderAnswerWithCitations(answer: string): string {
  // NotebookLM returns citation markers inline as [n] in the answer text already.
  // We render the string verbatim; the numbered list below provides the lookup.
  return answer;
}

// HistoryEntry is exported via types.ts; we don't construct it here directly,
// but ChatTurn → HistoryEntry conversion lives in App.tsx where onTurn fires.
export type { HistoryEntry };
