import assert from "node:assert/strict";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";

export type ContextFile = {
  level: "system" | "user" | "project";
  path: string;
  content: string;
};

/** XDG lists put the highest priority directory first; prompt layers go last-wins. */
export function contextPaths(home: string, configHome: string, configDirs: string): string[] {
  assert(posix.isAbsolute(home), "The execution environment must provide an absolute HOME.");
  const directories = [
    ...new Set(
      (configDirs || "/etc/xdg").split(":").filter((directory) => posix.isAbsolute(directory)),
    ),
  ];
  return [
    ...directories.reverse().map((directory) => posix.join(directory, "llms.txt")),
    posix.join(posix.isAbsolute(configHome) ? configHome : posix.join(home, ".config"), "llms.txt"),
  ];
}

async function configurationPaths(env: ExecutionEnv, context: Context): Promise<string[]> {
  let output = "";
  const result = getOrThrow(
    await env.exec(
      'printf \'%s\\0\' "${HOME-}" "${XDG_CONFIG_HOME-}" "${XDG_CONFIG_DIRS-}"',
      {
        timeout: 10,
        onOutput(text, _, info) {
          if (info.stream === "stdout") output += text;
        },
      },
      context,
    ),
  );
  assert.equal(result.exitCode, 0, "Could not resolve context paths in the execution environment.");
  const values = output.split("\0");
  assert(values.length === 4 && values[3] === "", "Invalid execution environment context paths.");
  return contextPaths(values[0], values[1], values[2]);
}

async function repositoryRoot(env: ExecutionEnv, context: Context): Promise<string> {
  const cwd = getOrThrow(await env.canonicalPath(env.cwd, context));
  let directory = cwd;
  while (true) {
    // A linked worktree has a .git file, not a directory. Never follow it into the main worktree.
    const marker = await env.fileInfo(posix.join(directory, ".git"), context);
    if (marker.ok) return directory;
    if (marker.error.code !== "not_found") throw marker.error;
    const parent = posix.dirname(directory);
    if (parent === directory) return cwd; // Non-Git projects use their base directory.
    directory = parent;
  }
}

/** All discovery and reads use the selected environment, including HOME and XDG variables. */
export async function loadContextFiles(
  env: ExecutionEnv,
  context: Context,
): Promise<ContextFile[]> {
  const paths = await configurationPaths(env, context);
  const root = await repositoryRoot(env, context);
  const candidates: { level: ContextFile["level"]; path: string }[] = paths.map((path, index) => ({
    level: index === paths.length - 1 ? "user" : "system",
    path,
  }));
  candidates.push(
    { level: "project", path: posix.join(root, "README.md") },
    { level: "project", path: posix.join(root, "CONTRIBUTING.md") },
  );
  const files = new Map<string, ContextFile>();
  for (const candidate of candidates) {
    const opened = await env.openBinaryReader(candidate.path, undefined, context);
    if (!opened.ok) {
      if (opened.error.code === "not_found") continue;
      throw opened.error;
    }
    const reader = opened.value;
    try {
      const { size } = getOrThrow(await reader.info(context));
      // Reject rather than silently truncating instructions. Also excludes unbounded reads.
      assert(size <= 1024 * 1024, `Context file exceeds 1 MiB: ${candidate.path}`);
      const bytes = getOrThrow(await reader.read(0, size + 1, context));
      assert.equal(bytes.length, size, `Context file changed while reading: ${candidate.path}`);
      const canonical = getOrThrow(await env.canonicalPath(candidate.path, context));
      // XDG directories can expose the same Nix-store file through several symlinks.
      files.delete(canonical);
      files.set(canonical, {
        ...candidate,
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      });
    } finally {
      await reader.close(context);
    }
  }
  return [...files.values()];
}

export function createContextExtension() {
  return defineExtension({
    name: "context",
    sections: [
      section("context", async (input, context) => {
        assert(input.env, "Context requires the selected execution environment.");
        const files = await loadContextFiles(input.env, context);
        return (["system", "user", "project"] as const)
          .map((level) => {
            const content = files
              .filter((file) => file.level === level)
              .map((file) => file.content)
              .join("\n\n");
            return `<${level}>\n${content}\n</${level}>`;
          })
          .join("\n");
      }),
    ],
  });
}
