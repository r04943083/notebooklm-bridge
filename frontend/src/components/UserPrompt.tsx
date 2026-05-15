// Blocking modal that captures the user's name on first visit and stores it in
// localStorage["nblm_user_id"]. From that point onwards every API request is
// sent with header X-User-Id.
//
// We intentionally don't validate format on the client — the backend's auth
// dependency is the source of truth (max 64 chars, no '|', no control chars).

import { useState } from "react";
import { setUserId } from "../api";

interface Props {
  onSubmit: (userId: string) => void;
}

export default function UserPrompt({ onSubmit }: Props) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    const v = name.trim();
    if (!v) {
      setErr("请填写名字或工号");
      return;
    }
    if (v.length > 64 || v.includes("|") || /[\r\n\t]/.test(v)) {
      setErr("名字过长或包含禁止字符");
      return;
    }
    setUserId(v);
    onSubmit(v);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>欢迎使用 NotebookLM Bridge</h2>
        <p>请输入你的名字或工号(仅用于会话隔离,不发送给 Google):</p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
          maxLength={64}
          placeholder="如 zhangsan / 12345"
        />
        {err && <p className="error">{err}</p>}
        <button onClick={submit}>开始使用</button>
      </div>
    </div>
  );
}
