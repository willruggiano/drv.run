import * as fs from "node:fs";
import * as path from "node:path";
import {
  isToolCallEventType,
  parseFrontmatter,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const RULES_PATH = path.join(".agents", "rules");
const MESSAGE_TYPE = "rules";
const MUTATING_TOOLS = new Set(["edit", "write"]);
const PATH_TOOLS = new Set(["read", "edit", "write"]);

type RuleFrontmatter = Record<string, unknown> & {
  paths?: unknown;
};

type Rule = {
  id: string;
  body: string;
  patterns?: string[];
  matchers?: RegExp[];
};

type Workspace = {
  root: string;
  rulesDirectory: string;
};

type GrepCall = {
  searchRoot: string;
  file?: string;
};

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isFile(value: string): boolean {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

function findWorkspace(cwd: string): Workspace | undefined {
  let current = path.resolve(cwd);

  while (true) {
    const rulesDirectory = path.join(current, RULES_PATH);
    if (isDirectory(rulesDirectory)) {
      return { root: current, rulesDirectory };
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findMarkdownFiles(directory: string): string[] {
  const files: string[] = [];
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(absolutePath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(absolutePath);
    }
  }

  return files;
}

function splitBraceAlternatives(value: string): string[] | undefined {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "{") depth++;
    else if (character === "}") depth--;
    else if (character === "," && depth === 0) {
      alternatives.push(value.slice(start, index));
      start = index + 1;
    }
  }

  if (alternatives.length === 0) return undefined;
  alternatives.push(value.slice(start));
  return alternatives;
}

function findExpandableBrace(
  value: string,
): { start: number; end: number; alternatives: string[] } | undefined {
  for (let start = 0; start < value.length; start++) {
    if (value[start] !== "{") continue;

    let depth = 0;
    for (let end = start; end < value.length; end++) {
      if (value[end] === "{") depth++;
      else if (value[end] === "}") {
        depth--;
        if (depth === 0) {
          const alternatives = splitBraceAlternatives(value.slice(start + 1, end));
          if (alternatives) return { start, end, alternatives };
          break;
        }
      }
    }
  }

  return undefined;
}

function expandBraces(value: string, limit = 64): string[] {
  const brace = findExpandableBrace(value);
  if (!brace) return [value];

  const prefix = value.slice(0, brace.start);
  const suffix = value.slice(brace.end + 1);
  const expanded: string[] = [];

  for (const alternative of brace.alternatives) {
    for (const result of expandBraces(`${prefix}${alternative}${suffix}`, limit)) {
      expanded.push(result);
      if (expanded.length >= limit) return expanded;
    }
  }

  return expanded;
}

function escapeRegex(character: string): string {
  return /[\\^$+?.()|{}]/.test(character) ? `\\${character}` : character;
}

function globSource(glob: string): string {
  let source = "";

  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];

    if (character === "*") {
      if (glob[index + 1] === "*") {
        while (glob[index + 1] === "*") index++;
        if (glob[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (character === "?") {
      source += "[^/]";
      continue;
    }

    if (character === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end !== -1) {
        let body = glob.slice(index + 1, end).replaceAll("\\", "\\\\");
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        else if (body.startsWith("^")) body = `\\${body}`;
        source += `[${body}]`;
        index = end;
        continue;
      }
    }

    source += escapeRegex(character);
  }

  return source;
}

function compileGlob(pattern: string): RegExp[] {
  const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\//, "");
  if (!normalized) return [];

  const matchers: RegExp[] = [];
  for (const expanded of expandBraces(normalized)) {
    try {
      matchers.push(new RegExp(`^${globSource(expanded)}$`));
    } catch {
      // Invalid character classes and similar malformed globs are ignored.
    }
  }
  return matchers;
}

function loadRules(workspace: Workspace): {
  rules: Rule[];
  warnings: string[];
} {
  const rules: Rule[] = [];
  const warnings: string[] = [];

  for (const absolutePath of findMarkdownFiles(workspace.rulesDirectory)) {
    const id = path.relative(workspace.root, absolutePath).split(path.sep).join("/");

    try {
      const raw = fs.readFileSync(absolutePath, "utf8");
      const { frontmatter, body } = parseFrontmatter<RuleFrontmatter>(raw);

      if (!("paths" in frontmatter)) {
        rules.push({ id, body });
        continue;
      }

      const patterns =
        typeof frontmatter.paths === "string"
          ? [frontmatter.paths]
          : Array.isArray(frontmatter.paths)
            ? frontmatter.paths.filter((value): value is string => typeof value === "string")
            : [];
      const normalizedPatterns = patterns.map((value) => value.trim()).filter(Boolean);
      const matchers = normalizedPatterns.flatMap(compileGlob);

      if (normalizedPatterns.length === 0 || matchers.length === 0) {
        warnings.push(`${id}: paths must contain at least one valid glob`);
        continue;
      }

      rules.push({ id, body, patterns: normalizedPatterns, matchers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${id}: ${message}`);
    }
  }

  return { rules, warnings };
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  });
}

function pathsFromText(text: string): string[] {
  const paths: string[] = [];
  const fileTag = /<file\s+name=(['"])(.*?)\1/gs;
  for (const match of text.matchAll(fileTag)) paths.push(match[2]);

  const atReference = /(?:^|[\s([{'"`])@(?:"([^"]+)"|'([^']+)'|([^\s<>"'`]+))/g;
  for (const match of text.matchAll(atReference)) {
    const quoted = match[1] ?? match[2];
    const raw = quoted ?? match[3];
    if (!raw) continue;
    paths.push(quoted ? raw : raw.replace(/[),.;:!?]+$/, "").replaceAll("\\ ", " "));
  }

  return paths;
}

function projectRelativePath(rawPath: string, cwd: string, root: string): string | undefined {
  let value = rawPath.trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (!value) return undefined;

  const absolutePath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
  const relativePath = path.relative(root, absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return undefined;
  }

  return relativePath.split(path.sep).join("/");
}

function addProjectPath(paths: Set<string>, rawPath: unknown, cwd: string, root: string): void {
  if (typeof rawPath !== "string") return;
  const relativePath = projectRelativePath(rawPath, cwd, root);
  if (relativePath) paths.add(relativePath);
}

function collectContextPaths(
  messages: readonly unknown[],
  cwd: string,
  root: string,
  extraPaths: readonly string[],
): Set<string> {
  const paths = new Set<string>();
  const grepCalls = new Map<string, GrepCall>();

  for (const rawPath of extraPaths) addProjectPath(paths, rawPath, cwd, root);

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const candidate = message as {
      role?: unknown;
      content?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
    };

    if (candidate.role === "user" || candidate.role === "custom") {
      for (const text of textParts(candidate.content)) {
        for (const rawPath of pathsFromText(text)) addProjectPath(paths, rawPath, cwd, root);
      }
    }

    if (candidate.role === "assistant" && Array.isArray(candidate.content)) {
      for (const part of candidate.content) {
        if (!part || typeof part !== "object") continue;
        const toolCall = part as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (
          toolCall.type !== "toolCall" ||
          !toolCall.arguments ||
          typeof toolCall.arguments !== "object"
        ) {
          continue;
        }

        const args = toolCall.arguments as Record<string, unknown>;
        if (typeof toolCall.name === "string" && PATH_TOOLS.has(toolCall.name)) {
          addProjectPath(paths, args.path, cwd, root);
        }

        if (toolCall.name === "grep" && typeof toolCall.id === "string") {
          const searchPath = typeof args.path === "string" ? args.path : ".";
          const absoluteSearchPath = path.resolve(cwd, searchPath);
          const file = isFile(absoluteSearchPath) ? absoluteSearchPath : undefined;
          if (file) addProjectPath(paths, file, cwd, root);
          grepCalls.set(toolCall.id, {
            searchRoot: file ? path.dirname(file) : absoluteSearchPath,
            file,
          });
        }
      }
    }

    if (
      candidate.role === "toolResult" &&
      candidate.toolName === "grep" &&
      typeof candidate.toolCallId === "string"
    ) {
      const grepCall = grepCalls.get(candidate.toolCallId);
      if (!grepCall || grepCall.file) continue;

      for (const text of textParts(candidate.content)) {
        for (const line of text.split("\n")) {
          const match = line.match(/^(.+?)(?::\d+:|-\d+-)/);
          if (match) addProjectPath(paths, path.resolve(grepCall.searchRoot, match[1]), cwd, root);
        }
      }
    }
  }

  return paths;
}

function ruleMatchesPath(rule: Rule, relativePath: string): boolean {
  return rule.matchers?.some((matcher) => matcher.test(relativePath)) ?? false;
}

function applicableRules(rules: readonly Rule[], paths: ReadonlySet<string>): Rule[] {
  return rules.filter(
    (rule) =>
      !rule.patterns || [...paths].some((relativePath) => ruleMatchesPath(rule, relativePath)),
  );
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatRules(rules: readonly Rule[]): string {
  const blocks = rules.map((rule) => {
    const patterns = rule.patterns ? ` paths="${escapeAttribute(rule.patterns.join(", "))}"` : "";
    return `<project_rule source="${escapeAttribute(rule.id)}"${patterns}>\n${rule.body}\n</project_rule>`;
  });

  return `<project_rules>\nThe following project rules apply to files currently in context. Follow them while continuing the user's task.\n\n${blocks.join("\n\n")}\n</project_rules>`;
}

export default function pathRulesExtension(pi: ExtensionAPI) {
  let workspace: Workspace | undefined;
  let rules: Rule[] = [];
  let promptPaths: string[] = [];
  let visibleRuleIds = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    workspace = findWorkspace(ctx.cwd);
    rules = [];
    promptPaths = [];
    visibleRuleIds = new Set();
    if (!workspace) return;

    const loaded = loadRules(workspace);
    rules = loaded.rules;

    if (rules.length > 0) {
      const globalCount = rules.filter((rule) => !rule.patterns).length;
      ctx.ui.notify(
        `Loaded ${rules.length} rules from ${path.relative(ctx.cwd, workspace.rulesDirectory) || "."} (${globalCount} global, ${rules.length - globalCount} scoped)`,
        "info",
      );
    }
    if (loaded.warnings.length > 0) {
      ctx.ui.notify(
        `Skipped ${loaded.warnings.length} rule(s):\n${loaded.warnings.join("\n")}`,
        "warning",
      );
    }
  });

  pi.on("before_agent_start", (event) => {
    promptPaths = pathsFromText(event.prompt);
  });

  pi.on("context", (event, ctx) => {
    const baseMessages = event.messages.filter(
      (message) => !(message.role === "custom" && message.customType === MESSAGE_TYPE),
    );
    if (!workspace || rules.length === 0) {
      visibleRuleIds = new Set();
      if (baseMessages.length !== event.messages.length) return { messages: baseMessages };
      return;
    }

    const contextPaths = collectContextPaths(baseMessages, ctx.cwd, workspace.root, promptPaths);
    const activeRules = applicableRules(rules, contextPaths);
    visibleRuleIds = new Set(activeRules.map((rule) => rule.id));
    if (activeRules.length === 0) {
      if (baseMessages.length !== event.messages.length) return { messages: baseMessages };
      return;
    }

    return {
      messages: [
        ...baseMessages,
        {
          role: "custom" as const,
          customType: MESSAGE_TYPE,
          content: formatRules(activeRules),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("tool_call", (event, ctx) => {
    if (!workspace || !MUTATING_TOOLS.has(event.toolName)) return;
    if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;

    const relativePath = projectRelativePath(event.input.path, ctx.cwd, workspace.root);
    if (!relativePath) return;

    const newlyApplicable = rules.filter(
      (rule) =>
        rule.patterns && ruleMatchesPath(rule, relativePath) && !visibleRuleIds.has(rule.id),
    );
    if (newlyApplicable.length === 0) return;

    return {
      block: true,
      reason: `Blocked the first mutation of ${relativePath} so newly applicable rules can enter context (${newlyApplicable.map((rule) => rule.id).join(", ")}). Review them, then retry the ${event.toolName} call.`,
    };
  });
}
