"use client";

import { Bubble, toUIMessages } from "./Messages";
import type { StoredMessage } from "@/lib/challenges";

export function Transcript({ rows }: { rows: StoredMessage[] }) {
  return (
    <div className="space-y-4">
      {toUIMessages(rows).map((m) => (
        <Bubble key={m.id} message={m} pending={false} />
      ))}
    </div>
  );
}
