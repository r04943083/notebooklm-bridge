// Sidebar of the last 20 conversations the user started, keyed by notebook.
// History is local-only (localStorage) — the backend Store is the source of
// truth for the actual conversation_id mapping; this list only helps the user
// remember "what did I ask about earlier".

import type { HistoryEntry } from "../types";

interface Props {
  entries: HistoryEntry[];
  selectedNotebook: string;
  onSelect: (entry: HistoryEntry) => void;
}

export default function ConversationHistory({
  entries,
  selectedNotebook,
  onSelect,
}: Props) {
  const filtered = entries.filter((e) => e.notebook_id === selectedNotebook);
  if (filtered.length === 0) {
    return (
      <aside className="history">
        <h3>历史</h3>
        <p className="hint">当前 notebook 暂无历史会话。</p>
      </aside>
    );
  }
  return (
    <aside className="history">
      <h3>历史(最近 {filtered.length} 条)</h3>
      <ul>
        {filtered.map((e) => (
          <li key={e.conversation_id}>
            <button type="button" onClick={() => onSelect(e)}>
              <span className="ts">{new Date(e.ts).toLocaleString("zh-CN")}</span>
              <span className="q">{e.first_question.slice(0, 40)}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
