/*
 * Imports
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { Problem } from "./problem.ts";

/*
 * Exports: Sessions
 */

export class Sessions {
  private readonly instances = new Map<
    string,
    {
      readonly create: boolean;
      readonly promise: Promise<Harness | undefined>;
    }
  >();
  private closing: Promise<void> | undefined;

  private readonly open: (
    id: string,
    context: Context,
    create: boolean,
  ) => Promise<Harness | undefined>;

  constructor(
    open: (id: string, context: Context, create: boolean) => Promise<Harness | undefined>,
  ) {
    this.open = open;
  }

  async get(id: string, create = false): Promise<Harness | undefined> {
    if (this.closing) throw new Problem(503);
    let instance = this.instances.get(id);
    if (!instance) {
      const promise = Promise.resolve().then(() => this.open(id, BACKGROUND_CONTEXT, create));
      instance = { create, promise };
      this.instances.set(id, instance);
      void promise.then(
        (harness) => {
          if (!harness) this.instances.delete(id);
          else void harness.closed.then(() => this.instances.delete(id));
        },
        () => {
          this.instances.delete(id);
        },
      );
    }
    const harness = await instance.promise;
    if (this.closing) throw new Problem(503);
    if (!harness && create && !instance.create) return this.get(id, true);
    return harness;
  }

  close(): Promise<void> {
    this.closing ??= this.closeAll();
    return this.closing;
  }

  /*
   * Helpers: Sessions
   */

  private async closeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.instances.values()].map(async (instance) => {
        const harness = await instance.promise.catch(() => undefined);
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
