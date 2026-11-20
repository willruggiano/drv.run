import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { serve } from "../src/server.ts";
import { authFixture, servePrefixed } from "./fixtures.ts";

const state = (page: Page, expected: string) =>
  page.waitForFunction(
    (expected) => document.getElementById("login-attempt")?.dataset.state === expected,
    expected,
  );

await test(
  "generic login renders typed prompts/events, preserves drafts across polling, and shares reconnects/tabs",
  { timeout: 60_000 },
  async (t) => {
    const { auth, sessions, path } = await authFixture(t);
    const provider = auth.models.getProvider("openai");
    assert(provider?.auth.apiKey);
    const answers: string[] = [];
    let starts = 0;
    auth.models.setProvider({
      ...provider,
      auth: {
        apiKey: {
          ...provider.auth.apiKey,
          login: async (interaction) => {
            starts++;
            interaction.notify({
              type: "info",
              message: "Provider instructions",
              links: [
                { url: "https://example.test/help", label: "Help" },
                { url: "javascript:window.pdsInjected=true", label: "Unsafe" },
              ],
            });
            interaction.notify({
              type: "auth_url",
              url: "https://example.test/authorize",
              instructions: "Authorize this login",
            });
            interaction.notify({
              type: "device_code",
              verificationUri: "https://example.test/device",
              userCode: "TEST-CODE",
              expiresInSeconds: 300,
            });
            interaction.notify({ type: "progress", message: "Waiting for account" });
            answers.push(
              await interaction.prompt({
                type: "text",
                message: "Account name",
                placeholder: "Account",
              }),
            );
            answers.push(await interaction.prompt({ type: "secret", message: "Private key" }));
            answers.push(
              await interaction.prompt({
                type: "select",
                message: "Account kind",
                options: [
                  { id: "personal", label: "Personal", description: "Personal account" },
                  { id: "team", label: "Team" },
                ],
              }),
            );
            answers.push(await interaction.prompt({ type: "manual_code", message: "Manual code" }));
            return { type: "api_key", key: "stored-secret" };
          },
        },
      },
    });
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(new URL("login", base).href);
    await page.getByLabel("Provider", { exact: true }).selectOption("openai");
    await page.getByRole("button", { name: "Show provider" }).click();
    assert.equal(new URL(page.url()).pathname, "/pds/login");
    assert.equal(new URL(page.url()).searchParams.get("provider"), "openai");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.getByLabel("Account name", { exact: true }).fill("draft-account");
    // A status response must not replace a locally edited input of the same prompt.
    await page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/pds/login/status",
    );
    assert.equal(
      await page.getByLabel("Account name", { exact: true }).inputValue(),
      "draft-account",
    );
    assert.equal(await page.locator("#login-device-code").textContent(), "TEST-CODE");
    assert.deepEqual(
      await page
        .locator("#login-events a")
        .evaluateAll((links) =>
          links.map((link) => ({
            href: (link as HTMLAnchorElement).href,
            target: (link as HTMLAnchorElement).target,
            rel: (link as HTMLAnchorElement).rel,
          })),
        ),
      [
        { href: "https://example.test/help", target: "_blank", rel: "noopener noreferrer" },
        { href: "https://example.test/authorize", target: "_blank", rel: "noopener noreferrer" },
        { href: "https://example.test/device", target: "_blank", rel: "noopener noreferrer" },
      ],
    );
    assert.equal(await page.evaluate(() => Object.hasOwn(window, "pdsInjected")), false);
    const attempt = await page.locator("#login-attempt").getAttribute("data-attempt");
    const other = await context.newPage();
    await other.goto(page.url());
    assert.equal(await other.locator("#login-attempt").getAttribute("data-attempt"), attempt);
    assert.equal(starts, 1);
    assert.equal(
      await other.getByRole("button", { name: "Log in", exact: true }).isDisabled(),
      true,
    );
    await page.reload();
    assert.equal(await page.locator("#login-attempt").getAttribute("data-attempt"), attempt);
    await page.getByLabel("Account name", { exact: true }).fill("account-answer");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Private key", { exact: true }).fill("submitted-secret");
    assert.equal(
      await page.getByLabel("Private key", { exact: true }).getAttribute("type"),
      "password",
    );
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Account kind", { exact: true }).selectOption("team");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Manual code", { exact: true }).fill("manual-answer");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await state(page, "succeeded");
    await state(other, "succeeded");
    assert.deepEqual(answers, ["account-answer", "submitted-secret", "team", "manual-answer"]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      openai: { type: "api_key", key: "stored-secret" },
    });
    assert.equal(await page.locator("#login-events").textContent(), "");
    assert.equal(await page.locator("input[name=answer]").count(), 0);
    assert.equal(await page.locator("#login-storage").getAttribute("data-state"), "api_key");
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await page.waitForFunction(
      () => document.getElementById("login-logout")?.dataset.state === "succeeded",
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {});
    assert.deepEqual(await sessions.list(), []);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(errors, []);
  },
);

await test(
  "login failure and cancellation are sanitized; native forms work without JavaScript",
  { timeout: 60_000 },
  async (t) => {
    const { auth, sessions } = await authFixture(t);
    const provider = auth.models.getProvider("openai");
    assert(provider?.auth.apiKey);
    let fail = false;
    auth.models.setProvider({
      ...provider,
      auth: {
        apiKey: {
          ...provider.auth.apiKey,
          login: async (interaction) => {
            if (fail)
              throw new Error("RAW-PROVIDER-CREDENTIAL", { cause: { access: "RAW-TOKEN" } });
            const key = await interaction.prompt({ type: "secret", message: "Private key" });
            return { type: "api_key", key };
          },
        },
      },
    });
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(`${server.origin}/login?provider=openai`);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.getByLabel("Private key", { exact: true }).fill("not-to-be-saved");
    await page.getByRole("button", { name: "Cancel login", exact: true }).click();
    await state(page, "cancelled");
    assert.equal(
      await page.locator("#login-attempt").innerText(),
      "Login cancelled before saving.",
    );
    assert.equal((await auth.view("openai")).selected?.stored, undefined);
    fail = true;
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await state(page, "failed");
    assert.equal(
      await page.locator("#login-attempt").innerText(),
      "Login failed. Check stored login status before trying again.",
    );
    assert.equal(await page.locator("input[name=answer]").count(), 0);
    fail = false;
    const native = await browser.newPage({ javaScriptEnabled: false });
    await native.goto(`${server.origin}/login?provider=openai`);
    await native.getByRole("button", { name: "Log in", exact: true }).click();
    await native.getByLabel("Private key", { exact: true }).fill("native-form-secret");
    await native.getByRole("button", { name: "Continue", exact: true }).click();
    await native.reload();
    assert.equal((await auth.view("openai")).selected?.stored, "api_key");
    assert.equal(new URL(native.url()).searchParams.get("provider"), "openai");
    assert.deepEqual([...new URL(native.url()).searchParams.keys()], ["provider"]);
    assert.equal(await native.locator("input[name=answer]").count(), 0);
  },
);
