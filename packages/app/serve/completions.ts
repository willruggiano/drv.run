export const commands = [
  { name: "cd", description: "Change the current working directory" },
  { name: "compact", description: "Compact context" },
  { name: "endreview", description: "End the review and return to the original conversation" },
  { name: "export", description: "Export conversation JSON" },
  { name: "fork", description: "Open conversation tree" },
  { name: "model", description: "Choose a model" },
  { name: "new", description: "Start a new session with the same settings" },
  { name: "rename", description: "Rename session" },
  { name: "reset", description: "Reset context" },
  { name: "resume", description: "Resume interrupted work" },
  { name: "review", description: "Review in a fresh conversation" },
  { name: "search", description: "Find in conversation" },
  { name: "sessions", description: "Open sessions" },
  { name: "settings", description: "Session settings" },
  { name: "stop", description: "Stop the current run" },
  { name: "tree", description: "Open session tree" },
] as const;

export type CompletionToken = {
  kind: "path" | "directory" | "command";
  query: string;
  start: number;
  end: number;
};
export type Completion = { label: string; description?: string; value: string };

export function completionToken(text: string, caret: number): CompletionToken | undefined {
  const before = text.slice(0, caret);
  if (/^\/[a-z-]*$/i.test(before)) {
    const rest = text.slice(caret).match(/^[a-z-]*/i)![0];
    return { kind: "command", query: before.slice(1), start: 0, end: caret + rest.length };
  }
  const directory = /^\/cd[ \t]+(.*)$/.exec(before);
  if (directory)
    return {
      kind: "directory",
      query: directory[1],
      start: caret - directory[1].length,
      end: text.length,
    };
  const match = /(?:^|\s)@("(?:\\.|[^"\\])*|[^\s"@]*)$/.exec(before);
  if (!match) return;
  const raw = match[1];
  let query = raw;
  let rest: string;
  if (raw.startsWith('"')) {
    try {
      query = JSON.parse(`${raw}"`) as string;
    } catch {
      return;
    }
    rest = text.slice(caret).match(/^(?:\\.|[^"\\])*(?:"|\\?$)/)![0];
  } else rest = text.slice(caret).match(/^[^\s"]*/)![0];
  return { kind: "path", query, start: caret - raw.length - 1, end: caret + rest.length };
}

export function pathCompletion(path: string): Completion {
  const quoted = /[\s"@\\]/.test(path);
  const directory = path.endsWith("/");
  const encoded = quoted ? JSON.stringify(path) : path;
  return {
    label: `@${path}`,
    value: `@${directory && quoted ? encoded.slice(0, -1) : encoded}${directory ? "" : " "}`,
  };
}

export function directoryCompletion(path: string): Completion {
  return { label: path, value: path };
}

export function commandCompletions(query: string, isReview = false): Completion[] {
  return commands
    .filter((command) => command.name !== "endreview" || isReview)
    .filter((command) => command.name.startsWith(query.toLowerCase()))
    .map((command) => ({
      label: `/${command.name}`,
      description: command.description,
      value: `/${command.name} `,
    }));
}
