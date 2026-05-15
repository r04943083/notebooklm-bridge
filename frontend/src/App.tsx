// Top-level composition: UserPrompt → NotebookPicker → ChatPane + History.
// No router (single page). State is the user_id + selected notebook + the
// rolling history list; everything else lives in child components.

import { useEffect, useState } from "react";
import { getUserId } from "./api";
import ChatPane from "./components/ChatPane";
import ConversationHistory from "./components/ConversationHistory";
import NotebookPicker from "./components/NotebookPicker";
import UserPrompt from "./components/UserPrompt";
import type { ChatTurn, HistoryEntry } from "./types";

const HISTORY_KEY = "nblm_history";
const NOTEBOOK_KEY = "nblm_notebook_id";
const HISTORY_LIMIT = 20;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(-HISTORY_LIMIT)));
}

export default function App() {
  const [userId, setUserIdState] = useState(getUserId());
  const [notebookId, setNotebookId] = useState(
    () => localStorage.getItem(NOTEBOOK_KEY) ?? ""
  );
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);

  useEffect(() => {
    if (notebookId) localStorage.setItem(NOTEBOOK_KEY, notebookId);
  }, [notebookId]);

  if (!userId) {
    return <UserPrompt onSubmit={setUserIdState} />;
  }

  const handleTurn = (turn: ChatTurn) => {
    // Promote (or insert) this conversation as the most recent entry for the
    // notebook. The first question is the "title" shown in the sidebar.
    const cid = turn.response.conversation_id;
    if (!cid) return;
    const existing = history.find((h) => h.conversation_id === cid);
    let next: HistoryEntry[];
    if (existing) {
      next = history.map((h) =>
        h.conversation_id === cid ? { ...h, ts: Date.now() } : h
      );
    } else {
      next = [
        ...history,
        {
          notebook_id: notebookId,
          conversation_id: cid,
          first_question: turn.question,
          ts: Date.now(),
        },
      ];
    }
    setHistory(next);
    saveHistory(next);
  };

  return (
    <div className="app">
      <header>
        <h1>NotebookLM Bridge</h1>
        <div className="user-chip">已登记:{userId}</div>
      </header>
      <div className="banner">
        ⚠ 问答内容会发送到 NotebookLM(Google)服务器。请勿粘贴敏感数据。
      </div>
      <main>
        <ConversationHistory
          entries={history}
          selectedNotebook={notebookId}
          onSelect={() => {
            /* future: load conversation_id into ChatPane */
          }}
        />
        <section className="main-pane">
          <NotebookPicker selectedId={notebookId} onChange={setNotebookId} />
          {notebookId && <ChatPane notebookId={notebookId} onTurn={handleTurn} />}
        </section>
      </main>
    </div>
  );
}
