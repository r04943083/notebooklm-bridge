// Fetches /api/notebooks once on mount and renders a <select>.
// Selected id is persisted to localStorage so reloads keep the user where they were.

import { useEffect, useState } from "react";
import { api } from "../api";
import type { Notebook } from "../types";

interface Props {
  selectedId: string;
  onChange: (id: string) => void;
}

export default function NotebookPicker({ selectedId, onChange }: Props) {
  const [items, setItems] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listNotebooks()
      .then((nbs) => {
        if (!alive) return;
        setItems(nbs);
        if (!selectedId && nbs.length > 0) onChange(nbs[0].id);
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div>加载 notebook 列表 …</div>;
  if (err) return <div className="error">无法加载 notebooks:{err}</div>;
  if (items.length === 0) return <div>当前账号没有 notebook</div>;

  return (
    <div className="picker">
      <label htmlFor="nb-select">Notebook:</label>
      <select
        id="nb-select"
        value={selectedId}
        onChange={(e) => onChange(e.target.value)}
      >
        {items.map((nb) => (
          <option key={nb.id} value={nb.id}>
            {nb.title || nb.id}
          </option>
        ))}
      </select>
    </div>
  );
}
