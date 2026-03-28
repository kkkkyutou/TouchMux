import fs from "node:fs";
import type { HistoryConversationSummary } from "../types/models.js";
import { config } from "../core/config.js";

interface HistoryRow {
  session_id?: string;
  ts?: number;
  text?: string;
}

export class CodexHistoryService {
  listHistory(): HistoryConversationSummary[] {
    if (!fs.existsSync(config.historyFile)) {
      return [];
    }

    const rows = fs.readFileSync(config.historyFile, "utf8").split("\n").filter(Boolean);
    const map = new Map<string, HistoryConversationSummary>();

    for (const line of rows) {
      try {
        const parsed = JSON.parse(line) as HistoryRow;
        if (!parsed.session_id || !parsed.ts) {
          continue;
        }
        const current = map.get(parsed.session_id);
        const snippet = (parsed.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (!current) {
          map.set(parsed.session_id, {
            sessionId: parsed.session_id,
            firstUpdatedAt: parsed.ts * 1000,
            lastUpdatedAt: parsed.ts * 1000,
            messageCount: 1,
            lastSnippet: snippet,
          });
          continue;
        }
        current.lastUpdatedAt = parsed.ts * 1000;
        current.messageCount += 1;
        if (snippet) {
          current.lastSnippet = snippet;
        }
      } catch {
        continue;
      }
    }

    return [...map.values()].sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt);
  }
}
