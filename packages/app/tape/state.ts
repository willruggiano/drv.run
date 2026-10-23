import assert from "node:assert/strict";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  LiveDoc,
  type CommitPublication,
  type LiveState,
} from "@earendil-works/pi-durable";
import { Sessions, Metadata, type Session } from "../serve/sessions.ts";
import {
  PresentationDoc,
  viewer,
  decode,
  live,
  presentation,
  maxBytes,
  maxFrames,
  type Tape,
  type Frame,
  type Change,
  type Presentation,
} from "./model.ts";

export const created = Date.UTC(2026, 0, 15, 12);
export const sessionID = "00000000-0000-4000-8000-000000000001";
export const scenes = ["session-settings", "context", "default-preferences"] as const;
export type Scene = (typeof scenes)[number];
export const initial = {
  name: "Inspect the configuration loader",
  created,
  presentation: PresentationDoc.definition.initial(null),
  entries: [
    {
      kind: "pi.user",
      model: [
        {
          role: "user" as const,
          content: "How does the configuration loader handle missing settings?",
          timestamp: created,
        },
      ],
    },
    {
      kind: "pi.assistant",
      model: [
        fauxAssistantMessage(
          "The loader merges project settings with safe defaults.\n\n```ts\nconst settings = { ...defaults, ...project };\n```\n\nI’ll check the validation path next.",
          { timestamp: created + 1 },
        ),
      ],
    },
  ],
};

export async function openState(directory: string, seed: Tape["initial"]) {
  const models = createModels();
  const faux = fauxProvider({
    models: [{ id: "faux-1", name: "Showcase model", reasoning: true }],
  });
  models.setProvider(faux.provider);
  const reports: unknown[] = [];
  const options = {
    directory: join(directory, "state"),
    models,
    // The input format cannot import tasks or submissions. The browser's
    // application server is read-only. Keep an additional execution tripwire.
    env: async () => {
      throw new Error("Execution is forbidden during tape replay");
    },
    onReport: (error: unknown) => {
      reports.push(error);
    },
  };
  let sessions = await Sessions.open(options);
  try {
    const session = await sessions.create(
      sessionID,
      undefined,
      { provider: "faux", modelId: "faux-1" },
      "high",
    );
    await session.root.commit(async (tx) => {
      Object.assign(await tx.doc(Metadata, session.root.id), {
        created: seed.created,
        name: seed.name,
      });
      Object.assign(await tx.doc(AgentDoc, session.root.id), { cwd: "/workspace/sample" });
      Object.assign(await tx.doc(PresentationDoc, viewer, null), seed.presentation);
      for (const entry of seed.entries) await tx.appendEntry(session.root.id, entry);
    }, context);
    // Sessions caches creation time when opening. Reopen after the fixed fixture
    // metadata is committed; do not freeze process timers or alter production code.
    await sessions.close();
    sessions = await Sessions.open(options);
    const active = await sessions.get(sessionID);
    return {
      sessions,
      session: active,
      async check() {
        assert.deepEqual(reports, [], "Durable reported an error");
        assert.equal(faux.state.callCount, 0, "Replay invoked a provider");
        const state = await active.harness.inspect(context);
        assert.equal(state.tasks.length, 0, "Replay created executable work");
        assert.equal(state.submissions.length, 0, "Replay created a submission");
      },
      async close() {
        await sessions.close();
      },
    };
  } catch (error) {
    await sessions.close();
    throw error;
  }
}

// A quiescent, exclusively owned fixture is the bootstrap boundary. Retained
// entry history supplies the initial state. subscribeCommits supplies exact
// intermediate live/presentation values; no general-purpose journal is needed.
export class Recorder {
  readonly frames: Frame[] = [];
  private failure: unknown;
  private bytes = 0;
  private stopped = false;
  private readonly stop: () => void;
  constructor(session: Session) {
    this.stop = session.harness.subscribeCommits((publication) => {
      try {
        this.observe(publication);
      } catch (error) {
        this.failure ??= error;
      }
    });
  }
  private observe(publication: CommitPublication) {
    const changes: Change[] = [];
    for (const change of publication.changes) {
      if (change.type !== "document") continue;
      if (change.record.kind === LiveDoc.definition.kind) {
        assert(change.version === 1 && change.value !== null);
        changes.push({ kind: "pi.live", version: 1, value: live(change.value) });
      } else if (
        change.record.kind === PresentationDoc.definition.kind &&
        change.record.key === viewer
      ) {
        assert(change.version === 1 && change.value !== null);
        changes.push({
          kind: "app.presentation",
          key: viewer,
          version: 1,
          value: presentation(change.value),
        });
      }
    }
    if (changes.length) this.append({ type: "commit", seq: publication.seq, changes });
  }
  private append(frame: Frame) {
    assert(!this.stopped, "Recording is finalized");
    if (this.failure) throw this.failure;
    this.bytes += Buffer.byteLength(JSON.stringify(frame));
    assert(this.frames.length < maxFrames && this.bytes <= maxBytes, "Recording limit exceeded");
    this.frames.push(structuredClone(frame));
  }
  capture(name: string) {
    this.append({ type: "capture", name });
  }
  finish(scene: string, seed: Tape["initial"]): Tape {
    this.stop();
    this.stopped = true;
    if (this.failure) throw this.failure;
    return decode(
      JSON.stringify({
        kind: "app.tape",
        version: 1,
        complete: true,
        scene,
        initial: seed,
        frames: this.frames,
      }),
    );
  }
  close() {
    this.stop();
    this.stopped = true;
  }
}

export async function apply(session: Session, frame: Extract<Frame, { type: "commit" }>) {
  await session.root.commit(async (tx) => {
    for (const change of frame.changes) {
      if (change.kind === "app.presentation")
        Object.assign(await tx.doc(PresentationDoc, viewer, null), change.value);
      else {
        const state = await tx.doc(LiveDoc, session.root.id);
        delete state.generation;
        Object.assign(state, change.value);
      }
    }
  }, context);
}

export async function record(directory: string, scene: Scene, signal?: AbortSignal): Promise<Tape> {
  signal?.throwIfAborted();
  const state = await openState(directory, initial);
  const recorder = new Recorder(state.session);
  try {
    let seq = 0;
    const change = async (value: Presentation, output: LiveState = {}) => {
      signal?.throwIfAborted();
      await apply(state.session, {
        type: "commit",
        seq: ++seq,
        changes: [
          { kind: "app.presentation", version: 1, key: viewer, value },
          { kind: "pi.live", version: 1, value: output },
        ],
      });
    };
    recorder.capture("conversation");
    const draft = "Please explain the validation path.";
    await change({ panel: "conversation", draft });
    recorder.capture("draft");
    const panel =
      scene === "session-settings"
        ? "settings"
        : scene === "default-preferences"
          ? "defaults"
          : "context";
    await change({ panel, draft });
    recorder.capture(panel);
    await change({ panel: "conversation", draft });
    recorder.capture("returned");
    await change(
      { panel: "conversation", draft },
      live({
        generation: {
          attempt: 1,
          message: fauxAssistantMessage(
            "The validator rejects unknown keys before applying defaults…",
            { timestamp: created + 2 },
          ),
        },
      }),
    );
    recorder.capture("partial-response");
    await change({ panel: "conversation", draft });
    recorder.capture("settled");
    await state.check();
    signal?.throwIfAborted();
    return recorder.finish(scene, initial);
  } finally {
    recorder.close();
    await state.close();
  }
}
