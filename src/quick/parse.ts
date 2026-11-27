// Quick panel input: first line = title, the rest = description. Inline tokens in the title:
//   #label          → a label (letters, digits, - _ / .)
//   !urgent !high !medium (!med) !low, or !1 … !4 (1 = urgent) → priority
// Tokens are removed from the title. A "#" or "!" not followed by a known word stays as text.

export interface ParsedTask {
  title: string;
  description: string;
  labels: string[];
  priority: string | null;
}

const PRIORITY: Record<string, string> = {
  urgent: "urgent", u: "urgent", "1": "urgent",
  high: "high", h: "high", "2": "high",
  medium: "medium", med: "medium", m: "medium", "3": "medium",
  low: "low", l: "low", "4": "low",
};

export function parseQuickInput(text: string): ParsedTask {
  const nl = text.indexOf("\n");
  const first = nl < 0 ? text : text.slice(0, nl);
  const description = nl < 0 ? "" : text.slice(nl + 1).trim();
  const labels: string[] = [];
  let priority: string | null = null;
  const words = first.split(/(\s+)/).filter((w) => {
    const label = /^#([\p{L}\p{N}][\p{L}\p{N}_\-/.]*)$/u.exec(w);
    if (label) {
      if (!labels.includes(label[1])) labels.push(label[1]);
      return false;
    }
    const prio = /^!([a-z0-9]+)$/i.exec(w);
    if (prio && PRIORITY[prio[1].toLowerCase()]) {
      priority = PRIORITY[prio[1].toLowerCase()];
      return false;
    }
    return true;
  });
  const title = words.join("").replace(/\s+/g, " ").trim();
  return { title, description, labels, priority };
}
