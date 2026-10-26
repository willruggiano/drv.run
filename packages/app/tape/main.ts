import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildAssets } from "serve/build";
import { decode, digest, maxBytes, type Tape } from "./model.ts";
import { record, scenes } from "./state.ts";
import { replay, profiles, type Profile } from "./browser.ts";

const usage = `Usage: nix run .#app.tape -- [options]
  --list                  List available scenes
  --scene GLOB            Select scenes (default: *)
  --profile NAME          mobile or desktop (default: both)
  --tape FILE             Replay a previously recorded JSON tape
  --record-only           Export tapes without launching Chromium
  --output DIRECTORY      Output parent (default: .scratch/showcase)
  --help                  Show this help

This first slice records controlled fixtures, not arbitrary browser sessions.
Video/GIF and general manual recording are not implemented yet.`;
export function options(args: string[]) {
  const result = {
    list: false,
    help: false,
    scene: "*",
    profiles: Object.keys(profiles) as Profile[],
    tape: "",
    recordOnly: false,
    output: ".scratch/showcase",
  };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    assert(!seen.has(arg), `Duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === "--list") result.list = true;
    else if (arg === "--help") result.help = true;
    else if (arg === "--record-only") result.recordOnly = true;
    else {
      assert(
        ["--scene", "--profile", "--tape", "--output"].includes(arg),
        `Unknown option: ${arg}`,
      );
      const value = args[++i];
      assert(value && !value.startsWith("--"), `Missing value: ${arg}`);
      if (arg === "--scene") {
        assert(/^[a-z0-9*-]+$/.test(value), "Invalid scene pattern");
        result.scene = value;
      } else if (arg === "--profile") {
        assert(value === "mobile" || value === "desktop", "Unknown profile");
        result.profiles = [value];
      } else if (arg === "--tape") result.tape = resolve(value);
      else result.output = resolve(value);
    }
  }
  assert(!(result.tape && seen.has("--scene")), "Choose --tape or --scene, not both");
  assert(!(result.tape && result.recordOnly), "--record-only requires an authored scene");
  return result;
}
export function selected(pattern: string) {
  const matcher = new RegExp(`^${pattern.replaceAll("*", ".*")}$`);
  const result = scenes.filter((scene) => matcher.test(scene));
  assert(result.length, `No scenes match: ${pattern}`);
  return result;
}
export async function run(args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const config = options(args);
  if (config.help) {
    console.log(usage);
    return;
  }
  if (config.list) {
    console.log(scenes.join("\n"));
    return;
  }
  const choices = config.tape ? [] : selected(config.scene);
  let imported: Tape | undefined;
  if (config.tape) {
    assert((await stat(config.tape)).size <= maxBytes, "Tape exceeds size limit");
    imported = decode(await readFile(config.tape, "utf8"));
  }
  signal.throwIfAborted();
  await mkdir(config.output, { recursive: true });
  const output = await mkdtemp(join(config.output, "run-"));
  const source = dirname(fileURLToPath(import.meta.resolve("serve/server")));
  const manifest = {
    version: 1,
    complete: false,
    recordings: [] as {
      scene: string;
      sha256: string;
      runs: Awaited<ReturnType<typeof replay>>[];
    }[],
  };
  const saveManifest = () =>
    writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await saveManifest();
  const temporary = await mkdtemp(join(tmpdir(), "app-tape-"));
  try {
    let assets = source;
    if (!config.recordOnly) {
      // Packaged runs use the app's already-built assets. Source runs use the
      // same production builder, never a second HTML or CSS implementation.
      if (await stat(join(source, "htmx/client.ts")).catch(() => undefined)) {
        assets = join(temporary, "assets");
        await buildAssets(source, assets);
      }
    }
    const tapes = imported ? [imported] : [];
    for (const scene of choices) {
      signal.throwIfAborted();
      tapes.push(await record(join(temporary, `record-${scene}`), scene, signal));
    }
    for (const tape of tapes) {
      signal.throwIfAborted();
      const text = JSON.stringify(tape, null, 2) + "\n";
      const directory = join(output, tape.scene);
      await mkdir(directory);
      await writeFile(join(directory, "tape.json"), text, { flag: "wx" });
      const item = {
        scene: tape.scene,
        sha256: digest(text),
        runs: [] as Awaited<ReturnType<typeof replay>>[],
      };
      manifest.recordings.push(item);
      if (!config.recordOnly) {
        for (const profile of config.profiles) {
          item.runs.push(await replay(tape, profile, assets, join(directory, profile), signal));
          await saveManifest();
        }
      }
    }
    const escape = (text: string) =>
      text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
    const gallery = manifest.recordings
      .map(
        ({ scene, runs }) =>
          `<section><h2>${escape(scene)}</h2>${runs.map((run) => `<h3>${run.profile}</h3><div class="captures">${run.captures.map((capture) => `<figure><a href="${scene}/${run.profile}/${capture.name}.png"><img loading="lazy" src="${scene}/${run.profile}/${capture.name}.png" alt="${escape(capture.name)}"></a><figcaption>${escape(capture.name)}</figcaption></figure>`).join("")}</div>`).join("")}</section>`,
      )
      .join("");
    await writeFile(
      join(output, "index.html"),
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>App tape showcase</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#151719;color:#ddd;font:16px system-ui;margin:24px}.captures{display:flex;flex-wrap:wrap;gap:20px}figure{margin:0;width:320px}img{width:100%}a{color:inherit}</style><h1>App tape showcase</h1><p>Presentation replay · <a href="manifest.json">manifest</a></p>${gallery}</html>`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  signal.throwIfAborted();
  manifest.complete = true;
  try {
    await saveManifest();
    signal.throwIfAborted();
  } catch (error) {
    manifest.complete = false;
    await saveManifest();
    throw error;
  }
  console.log(output);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Capture interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await run(process.argv.slice(2), controller.signal);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
