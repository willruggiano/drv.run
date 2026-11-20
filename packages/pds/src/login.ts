import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type * as A from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export class LoginError extends Error {}

type State = "pending" | "saving" | "succeeded" | "cancelled" | "expired" | "failed";
export interface LoginAttempt {
  id: string;
  state: State;
  events: A.AuthEvent[];
  prompt?: { id: string; request: A.AuthPrompt };
}
interface Attempt {
  view: LoginAttempt;
  controller: AbortController;
  done: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
  answer?: (value: string) => void;
}
export interface LoginView {
  providers: { id: string; name: string }[];
  selected?: {
    id: string;
    name: string;
    methods: { type: A.AuthType; name: string }[];
    stored?: A.AuthType;
    authorized?: boolean;
    unavailable: boolean;
    attempt?: LoginAttempt;
    logout: "idle" | "pending" | "succeeded" | "failed";
  };
}

// One owner per PDS process, independent of coding sessions and browser connections.
export class ModelAuth {
  readonly models: A.MutableModels;
  private readonly attempts = new Map<string, Attempt>();
  private readonly removals = new Map<
    string,
    { state: "pending" | "succeeded" | "failed"; done: Promise<void> }
  >();
  private closing: Promise<void> | undefined;
  private readonly credentials: A.CredentialStore;

  constructor(credentials: A.CredentialStore, authContext?: A.AuthContext) {
    this.credentials = credentials;
    this.models = builtinModels({
      ...(authContext ? { authContext } : {}),
      credentials: {
        read: (id, options) => credentials.read(id, options),
        list: (options) => credentials.list(options),
        delete: (id, options) => credentials.delete(id, options),
        modify: (id, fn, options) =>
          credentials.modify(
            id,
            async (previous) => {
              const next = await fn(previous);
              const attempt = this.attempts.get(id);
              // pi-ai 1.5.2 passes the interaction signal unchanged to modify().
              // Its mutation callback is the non-cancellable login commit boundary.
              if (attempt && attempt.controller.signal === options?.signal) {
                options.signal.throwIfAborted();
                attempt.view.state = "saving";
              }
              return next;
            },
            options,
          ),
      },
    });
  }

  async view(providerId?: string, options?: A.AuthOperationOptions): Promise<LoginView> {
    const providers = this.models.getProviders().map(({ id, name }) => ({ id, name }));
    if (providerId === undefined) return { providers };
    const provider = this.provider(providerId);
    const methods: { type: A.AuthType; name: string }[] = [];
    if (provider.auth.apiKey?.login)
      methods.push({ type: "api_key", name: provider.auth.apiKey.name });
    if (provider.auth.oauth)
      methods.push({
        type: "oauth",
        name: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
      });
    let stored: A.AuthType | undefined;
    let authorized: boolean | undefined;
    let unavailable = false;
    try {
      stored = (await this.credentials.list(options)).find(
        (entry) => entry.providerId === providerId,
      )?.type;
      authorized = !!(await this.models.checkAuth(providerId, options));
    } catch {
      options?.signal?.throwIfAborted();
      unavailable = true;
    }
    const attempt = this.attempts.get(providerId)?.view;
    return {
      providers,
      selected: {
        id: provider.id,
        name: provider.name,
        methods,
        unavailable,
        ...(unavailable ? {} : { ...(stored ? { stored } : {}), authorized: authorized! }),
        ...(attempt ? { attempt: structuredClone(attempt) } : {}),
        logout: this.removals.get(providerId)?.state ?? "idle",
      },
    };
  }

  start(providerId: string, method: string): void {
    this.assertOpen();
    const provider = this.provider(providerId);
    if (
      !(
        (method === "api_key" && provider.auth.apiKey?.login) ||
        (method === "oauth" && provider.auth.oauth)
      )
    )
      throw new LoginError("Select an available login method.");
    if (this.removals.get(providerId)?.state === "pending")
      throw new LoginError("Logout is still in progress.");
    const previous = this.attempts.get(providerId);
    if (previous && active(previous.view))
      throw new LoginError("A login is already in progress. Continue or cancel it.");
    this.removals.delete(providerId);
    const controller = new AbortController();
    const attempt: Attempt = {
      view: { id: randomUUID(), state: "pending", events: [] },
      controller,
      done: Promise.resolve(),
      timer: setTimeout(() => this.stop(attempt, "expired"), 15 * 60_000).unref(),
      expiresAt: Date.now() + 15 * 60_000,
    };
    this.attempts.set(providerId, attempt);
    attempt.done = this.models
      .login(providerId, method, {
        signal: controller.signal,
        prompt: (request) => this.prompt(attempt, request),
        notify: (event) => {
          if (controller.signal.aborted || attempt.view.state !== "pending") return;
          // Keep instructions/links, but not an accumulating progress log.
          attempt.view.events = attempt.view.events.filter((item) => item.type !== "progress");
          attempt.view.events.push(event);
          if (event.type === "device_code" && event.expiresInSeconds !== undefined) {
            assert(Number.isFinite(event.expiresInSeconds) && event.expiresInSeconds >= 0);
            clearTimeout(attempt.timer);
            attempt.expiresAt = Math.min(
              attempt.expiresAt,
              Date.now() + event.expiresInSeconds * 1000,
            );
            attempt.timer = setTimeout(
              () => this.stop(attempt, "expired"),
              Math.max(0, attempt.expiresAt - Date.now()),
            ).unref();
          }
        },
      })
      .then(
        () => {
          attempt.view.state = "succeeded";
        },
        () => {
          if (!controller.signal.aborted) attempt.view.state = "failed";
        },
      )
      .finally(() => {
        // Release outstanding per-prompt listeners even if a provider finished out of band.
        controller.abort();
        clearTimeout(attempt.timer);
        delete attempt.answer;
        delete attempt.view.prompt;
        attempt.view.events = [];
      });
  }

  respond(providerId: string, attemptId: string, promptId: string, value: string): void {
    this.assertOpen();
    const attempt = this.attempt(providerId, attemptId);
    const prompt = attempt.view.prompt;
    if (!prompt || prompt.id !== promptId || !attempt.answer || attempt.view.state !== "pending")
      throw new LoginError("This prompt has ended. Continue with the current login.");
    if (
      prompt.request.type === "select" &&
      !prompt.request.options.some((option) => option.id === value)
    )
      throw new LoginError("Select an available option.");
    attempt.answer(value);
  }

  async cancel(providerId: string, attemptId: string): Promise<void> {
    const attempt = this.attempt(providerId, attemptId);
    this.stop(attempt, "cancelled");
    await attempt.done;
  }

  async logout(providerId: string): Promise<void> {
    this.assertOpen();
    this.provider(providerId);
    const previous = this.removals.get(providerId);
    if (previous?.state === "pending") return previous.done;
    const removal = {
      state: "pending" as "pending" | "succeeded" | "failed",
      done: Promise.resolve(),
    };
    this.removals.set(providerId, removal);
    const attempt = this.attempts.get(providerId);
    if (attempt) this.stop(attempt, "cancelled");
    removal.done = (async () => {
      await attempt?.done;
      await this.models.logout(providerId);
      removal.state = "succeeded";
      this.attempts.delete(providerId);
    })().catch(() => {
      removal.state = "failed";
    });
    return removal.done;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const attempt of this.attempts.values()) this.stop(attempt, "cancelled");
      await Promise.all([
        ...[...this.attempts.values()].map((attempt) => attempt.done),
        ...[...this.removals.values()].map((removal) => removal.done),
      ]);
    })();
    return this.closing;
  }

  private assertOpen() {
    if (this.closing) throw new LoginError("Model login is closing.");
  }
  private provider(id: string) {
    const provider = this.models.getProvider(id);
    if (!provider) throw new LoginError("Select an available provider.");
    return provider;
  }
  private attempt(providerId: string, attemptId: string) {
    const attempt = this.attempts.get(providerId);
    if (!attempt || attempt.view.id !== attemptId)
      throw new LoginError("This login has ended. Reload its current state.");
    return attempt;
  }
  private stop(attempt: Attempt, state: "cancelled" | "expired") {
    if (attempt.view.state !== "pending") return;
    attempt.view.state = state;
    attempt.controller.abort();
  }
  private async prompt(attempt: Attempt, request: A.AuthPrompt): Promise<string> {
    const signal = request.signal
      ? AbortSignal.any([attempt.controller.signal, request.signal])
      : attempt.controller.signal;
    signal.throwIfAborted();
    assert(!attempt.view.prompt, "Provider requested overlapping login prompts");
    const answer = Promise.withResolvers<string>();
    const abort = () => answer.reject(signal.reason);
    const id = randomUUID();
    // Do not retain a prompt's signal in the display snapshot.
    const { signal: _signal, ...display } = request;
    attempt.view.prompt = { id, request: display };
    attempt.answer = (value) => {
      delete attempt.answer;
      delete attempt.view.prompt;
      answer.resolve(value);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await answer.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      delete attempt.answer;
      delete attempt.view.prompt;
    }
  }
}

export function active(attempt: LoginAttempt): boolean {
  return attempt.state === "pending" || attempt.state === "saving";
}
