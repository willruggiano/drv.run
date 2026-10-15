import * as fs from "node:fs";
import * as path from "node:path";
import {
  isToolCallEventType,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const RULES_PATH = path.join(".agents", "rules");
const MESSAGE_TYPE = "rules";
const ACTIVATION_TYPE = "path-rules-activation";

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

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
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

function ruleMatchesPath(rule: Rule, relativePath: string): boolean {
  return rule.matchers?.some((matcher) => matcher.test(relativePath)) ?? false;
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

  return `<project_rules>\nThe following project rules are active on this session branch. Follow them while continuing the user's task.\n\n${blocks.join("\n\n")}\n</project_rules>`;
}

export default function pathRulesExtension(pi: ExtensionAPI) {
  let workspace: Workspace | undefined;
  let rules: Rule[] = [];
  const activatedRuleIds = new Set<string>();
  const suppliedRuleIds = new Set<string>();

  function restoreActivations(ctx: ExtensionContext): void {
    activatedRuleIds.clear();
    suppliedRuleIds.clear();
    if (!workspace) return;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ACTIVATION_TYPE) continue;
      const data = entry.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("root" in data) ||
        data.root !== workspace.root ||
        !("ruleIds" in data) ||
        !Array.isArray(data.ruleIds)
      ) {
        continue;
      }
      for (const id of data.ruleIds) {
        if (typeof id === "string") activatedRuleIds.add(id);
      }
    }
  }

  function activatePath(rawPath: string, ctx: ExtensionContext): Rule[] {
    if (!workspace) return [];
    const root = workspace.root;
    const relativePath = projectRelativePath(rawPath, ctx.cwd, root);
    if (!relativePath) return [];
    const matching = rules.filter((rule) => rule.patterns && ruleMatchesPath(rule, relativePath));
    const newlyActivated = matching.filter((rule) => !activatedRuleIds.has(rule.id));
    if (newlyActivated.length > 0) {
      // Persist discovery, not delivery. Nested calls may all precede the next model request.
      pi.appendEntry(ACTIVATION_TYPE, {
        root,
        ruleIds: newlyActivated.map((rule) => rule.id),
      });
      for (const rule of newlyActivated) activatedRuleIds.add(rule.id);
    }
    return matching;
  }

  pi.on("session_start", (_, ctx) => {
    workspace = findWorkspace(ctx.cwd);
    rules = [];
    restoreActivations(ctx);
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

  pi.on("session_tree", (_, ctx) => restoreActivations(ctx));
  pi.on("session_compact", () => suppliedRuleIds.clear());

  pi.on("context", (event) => {
    const baseMessages = event.messages.filter(
      (message) => !(message.role === "custom" && message.customType === MESSAGE_TYPE),
    );
    const activeRules = rules.filter((rule) => !rule.patterns || activatedRuleIds.has(rule.id));
    suppliedRuleIds.clear();
    for (const rule of activeRules) suppliedRuleIds.add(rule.id);
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
    if (
      !isToolCallEventType("read", event) &&
      !isToolCallEventType("edit", event) &&
      !isToolCallEventType("write", event)
    ) {
      return;
    }

    const matching = activatePath(event.input.path, ctx);
    if (event.toolName === "read") return;
    const unseen = matching.filter((rule) => !suppliedRuleIds.has(rule.id));
    if (unseen.length === 0) return;

    return {
      block: true,
      reason: `Blocked ${event.toolName} of ${event.input.path}: activated rules have not yet been supplied to the model (${unseen.map((rule) => rule.id).join(", ")}). End this tool batch; the next model request will receive them. Review them, then retry.`,
    };
  });
}
