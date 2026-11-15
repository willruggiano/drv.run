/*
 * Imports
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import type { InventoryRecord, InventoryPhase, InventoryService } from "../graphql/src/graphql.ts";
import type { DeploymentConfiguration } from "./configuration.ts";

/*
 * Exports: Inventory
 */

export function createInventoryService(config: DeploymentConfiguration): InventoryService {
  const namespace = `uid:${process.getuid!()}`;
  const root = dirname(config.stateDirectory);
  const unit = (id: string) => `drv.run@${id}.service`;

  return {
    namespace,
    async list(limit, cursor, context) {
      const after = isObject(cursor) && typeof cursor.after === "string" ? cursor.after : undefined;
      if (
        cursor !== undefined &&
        (!isObject(cursor) ||
          Object.keys(cursor).length !== 2 ||
          cursor.namespace !== namespace ||
          after === undefined)
      )
        return { invalidCursor: true };
      const all = await inventory(context);
      const remaining = all.filter(
        (item) => after === undefined || item.id.localeCompare(after) > 0,
      );
      const items = remaining.slice(0, limit);
      const next = remaining.length > items.length ? { namespace, after: items.at(-1)!.id } : null;
      return { items, next };
    },
    async lookup(id, context) {
      if (!(await known(id, context))) return undefined;
      return { id, unit: unit(id) };
    },
    async flakeReference(id, context) {
      if (!(await known(id, context))) return undefined;
      try {
        return (
          await readFile(join(root, id, "reference"), {
            encoding: "utf8",
            signal: context.abortSignal,
          })
        ).trim();
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    async connect(id, context) {
      if (!(await known(id, context))) return undefined;
      const directory = join(config.runtimeDirectory, `drv.run.${id}`);
      const identityFile = join(directory, "client-key");
      const knownHostsFile = join(directory, "known_hosts");
      const configFile = join(directory, "client.conf");
      try {
        const files = await Promise.all(
          [identityFile, knownHostsFile, configFile].map((path) => stat(path)),
        );
        if (files.some((file) => !file.isFile())) return undefined;
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
      context.abortSignal?.throwIfAborted();
      return {
        host: `drv.run.${id}`,
        user: "root",
        identityFile,
        knownHostsFile,
        hostKeyAlias: `drv.run.${id}`,
        configFile,
      };
    },
    async state(id, context) {
      if (!(await known(id, context))) return undefined;
      const { stdout } = await exec(
        config.systemctl,
        ["--user", "show", unit(id), "--property=ActiveState,SubState,Result", "--value"],
        { timeout: 10_000, signal: context.abortSignal },
      );
      const [activeState, subState, result] = stdout.trimEnd().split("\n");
      assert(activeState !== undefined && subState !== undefined);
      return { activeState, subState, result: result || null };
    },
    async timings(id, context) {
      if (!(await known(id, context))) return undefined;
      const { stdout } = await exec(
        config.systemctl,
        ["--user", "show", unit(id), "--property=InvocationID", "--value"],
        { timeout: 10_000, signal: context.abortSignal },
      );
      const invocationId = stdout.trim();
      if (!invocationId) return undefined;
      const directory = join(config.runtimeDirectory, `drv.run.${id}`);
      const [host, guest] = await Promise.all([
        phases(join(directory, "timings.jsonl")),
        phases(join(directory, "guest-timings.jsonl")),
      ]);
      if (!host && !guest) return undefined;
      return {
        invocation_id: invocationId,
        host_phases: host ?? null,
        guest_phases: guest ?? null,
      };
    },
  };

  /*
   * Helpers: Inventory
   */

  async function inventory(context: Context): Promise<InventoryRecord[]> {
    context.abortSignal?.throwIfAborted();
    const [directories, loaded, installed] = await Promise.all([
      readdir(root, { withFileTypes: true }).catch((error: unknown) => {
        if (missing(error)) return [];
        throw error;
      }),
      exec(
        config.systemctl,
        [
          "--user",
          "list-units",
          "--all",
          "--type=service",
          "--plain",
          "--no-legend",
          "--no-pager",
          "drv.run@*.service",
        ],
        {
          timeout: 10_000,
          signal: context.abortSignal,
        },
      ),
      exec(
        config.systemctl,
        [
          "--user",
          "list-unit-files",
          "--type=service",
          "--no-legend",
          "--no-pager",
          "drv.run@*.service",
        ],
        {
          timeout: 10_000,
          signal: context.abortSignal,
        },
      ),
    ]);
    const ids = new Set<string>();
    for (const entry of directories) if (entry.isDirectory()) ids.add(entry.name);
    for (const output of [loaded.stdout, installed.stdout]) {
      for (const line of output.split("\n")) {
        const found = /^drv\.run@(.+)\.service(?:\s|$)/.exec(line.trim());
        if (found?.[1]) ids.add(found[1]);
      }
    }
    context.abortSignal?.throwIfAborted();
    return [...ids]
      .filter((id) => !["harness", ".", ".."].includes(id) && basename(id) === id)
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id, unit: unit(id) }));
  }

  async function known(id: string, context: Context): Promise<boolean> {
    return (await inventory(context)).some((record) => record.id === id);
  }
}

/*
 * Helpers: Inventory
 */

const exec = promisify(execFile);

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function phases(path: string): Promise<InventoryPhase[] | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const result: InventoryPhase[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    let item: unknown;
    try {
      item = JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
    const parsed = phase(item);
    if (!parsed) return undefined;
    result.push(parsed);
  }
  return result.length ? result : undefined;
}

function phase(value: unknown): InventoryPhase | undefined {
  if (
    !isObject(value) ||
    typeof value.phase !== "string" ||
    typeof value.clock !== "string" ||
    typeof value.monotonic_s !== "number" ||
    !Number.isFinite(value.monotonic_s) ||
    value.monotonic_s < 0 ||
    typeof value.resolution_s !== "number" ||
    !Number.isFinite(value.resolution_s) ||
    value.resolution_s <= 0
  )
    return undefined;
  return {
    phase: value.phase,
    clock: value.clock,
    monotonic_s: value.monotonic_s,
    resolution_s: value.resolution_s,
  };
}
