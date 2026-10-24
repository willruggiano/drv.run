export const commands = [
  { name: "sessions", description: "Open sessions" },
  { name: "new", description: "Create a session with the selected target/model" },
  { name: "settings", description: "Session settings" },
  { name: "model", description: "Choose a model" },
  { name: "cd", description: "Change working directory · defaults to home" },
  { name: "rename", description: "Rename session · empty name clears it" },
  { name: "fork", description: "Open branches" },
  { name: "review", description: "Review in a fresh conversation · optional scope" },
  { name: "endreview", description: "End the review and return to the original conversation" },
  { name: "compact", description: "Compact context · optional instructions" },
  { name: "reset", description: "Reset context · optional handoff (asks for confirmation)" },
  { name: "stop", description: "Stop the current run" },
  { name: "resume", description: "Resume interrupted work" },
  { name: "export", description: "Export conversation JSON" },
  { name: "search", description: "Find in conversation" },
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
