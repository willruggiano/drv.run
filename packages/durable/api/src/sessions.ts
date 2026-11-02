import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { Problem } from "./problem.ts";

export class Sessions {
  private readonly instances = new Map<string, Promise<Harness | undefined>>();
  private closing: Promise<void> | undefined;

  private readonly open: (id: string, context: Context) => Promise<Harness | undefined>;

  constructor(open: (id: string, context: Context) => Promise<Harness | undefined>) {
    this.open = open;
  }

  async get(id: string): Promise<Harness> {
    if (this.closing) throw new Problem(503);
    let instance = this.instances.get(id);
    if (!instance) {
      // Opening belongs to the service, not the first request's cancellation.
      instance = Promise.resolve().then(() => this.open(id, BACKGROUND_CONTEXT));
      this.instances.set(id, instance);
      void instance.then(
        (harness) => {
          if (!harness) this.instances.delete(id);
        },
        () => {
          this.instances.delete(id);
        },
      );
    }
    const harness = await instance;
    if (this.closing) throw new Problem(503);
    if (!harness) throw new Problem(404);
    return harness;
  }

  close(): Promise<void> {
    this.closing ??= this.closeAll();
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.instances.values()].map(async (instance) => {
        const harness = await instance.catch(() => undefined);
        await harness?.close(BACKGROUND_CONTEXT);
      }),
    );
    this.instances.clear();
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Harness shutdown failed",
      );
  }
}
