import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { browserFixture } from "./browser-testing.ts";
import { authorizationFixture } from "./testing.ts";
import { fixture, model, waitFor } from "./sessions-testing.ts";
import { GlobalSettingsStore } from "../server.ts";
import { rename } from "../sessions.ts";

for (const provider of ["github", "openai"] as const)
  await test(
    `elm/${provider}: mobile navigation and settings auth support enrollment, polling and removal`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t);
      await rename(await f.create(), "Review the authentication flow");
      const control = await authorizationFixture(t);
      const settings = new GlobalSettingsStore({ model });
      const { page, base, errors, screenshots } = await browserFixture(
        t,
        f.sessions,
        control.authorization,
        undefined,
        settings,
      );
      page.setDefaultTimeout(10_000);
      const capture = async (name: string) => {
        if (screenshots && provider === "openai")
          await page.screenshot({ path: join(screenshots, `elm-mobile-${name}.png`) });
      };
      const label = provider === "github" ? "GitHub" : "OpenAI";
      const selector = `#${provider}-authorization`;
      await page.goto(`${base}/`);
      await page.locator("#session-list a").waitFor();
      const settingsLink = page.getByRole("link", { name: "Global settings", exact: true });
      assert.equal(await settingsLink.isVisible(), true);
      const bounds = await settingsLink.boundingBox();
      assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
      await capture("landing");
      assert.equal(await page.getByRole("link", { name: "Activity", exact: true }).count(), 0);
      await page.getByRole("link", { name: "Global settings", exact: true }).click();
      await page.locator(`${selector} [data-state="not-enrolled"]`).waitFor();
      assert.equal(new URL(page.url()).pathname, `/settings`);
      assert.equal(await page.locator("#settings #authorization").count(), 1);
      assert.equal(await page.locator("form form").count(), 0);
      assert.equal(await page.locator(selector).getByRole("button").count(), 1);
      assert.equal(await page.locator(selector).getByRole("link").count(), 0);
      assert.equal(
        await page
          .locator(selector)
          .getByRole("button", { name: "Remove authorization", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page.locator(selector).getByLabel("Account ID", { exact: true }).count(),
        0,
      );
      await capture("settings");
      await page.locator("#authorization").scrollIntoViewIfNeeded();
      await capture("auth");
      const heading = await page.locator(selector).getByRole("heading", { level: 3 }).boundingBox();
      const primary = await page
        .locator(selector)
        .getByRole("button", { name: "Authorize", exact: true })
        .boundingBox();
      assert.ok(heading && primary && heading.x + heading.width <= primary.x);
      assert.ok(Math.abs(heading.y + heading.height / 2 - (primary.y + primary.height / 2)) < 0.5);
      await page.locator(selector).getByRole("button", { name: "Authorize", exact: true }).click();
      await page.locator(`${selector} [data-state="authorizing"]`).waitFor();
      assert.equal((await control.authorization.status(undefined, provider)).state, "authorizing");
      const approval = page.getByRole("link", {
        name: `${label} device authorization`,
        exact: true,
      });
      assert.equal(
        await approval.getAttribute("href"),
        provider === "github"
          ? "https://github.com/login/device"
          : "https://auth.openai.com/codex/device",
      );
      assert.equal(await approval.getAttribute("target"), "_blank");
      await page.locator(selector).scrollIntoViewIfNeeded();
      await capture("approval");
      // Leaving settings does not cancel the host's enrollment.
      await page.getByRole("link", { name: "Sessions", exact: true }).click();
      await page.locator("#landing").waitFor();
      await page.getByRole("link", { name: "Global settings", exact: true }).click();
      await page.locator(`${selector} [data-state="authorizing"]`).waitFor();
      // Hold a settings save while the approval completes through polling.
      const saving = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      t.after(() => resume.resolve());
      await page.route(`${base}/settings`, async (route) => {
        if (route.request().method() === "POST") {
          saving.resolve();
          await resume.promise;
        }
        await route.continue();
      });
      await page
        .locator('#settings form[data-autosave] input[name="hideThinkingBlock"][value="true"]')
        .check();
      await saving.promise;
      assert.equal(
        await page.locator("#settings form[data-autosave]").getAttribute("aria-busy"),
        "true",
      );
      assert.equal(await page.locator("#settings form[data-autosave] output").count(), 0);
      assert.equal(settings.read().values.hideThinkingBlock, false);
      control.approve(provider);
      await page.locator(`${selector} [data-state="usable"]`).waitFor();
      assert.equal(
        await page
          .locator('#settings form[data-autosave] input[name="hideThinkingBlock"][value="true"]')
          .isChecked(),
        true,
      );
      resume.resolve();
      await waitFor(async () => settings.read().values.hideThinkingBlock === true);
      await page.locator('#settings form[data-autosave][aria-busy="false"]').waitFor();
      assert.equal(await page.locator("#settings form[data-autosave] output").count(), 0);
      await page
        .locator(selector)
        .getByRole("button", { name: "Remove authorization", exact: true })
        .click();
      await page.locator(`${selector} [data-state="not-enrolled"]`).waitFor();
      assert.equal((await control.authorization.status(undefined, provider)).state, "not-enrolled");
      assert.equal(new URL(page.url()).pathname, `/settings`);
      assert.equal(
        await page
          .locator('#settings form[data-autosave] input[name="hideThinkingBlock"][value="true"]')
          .isChecked(),
        true,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await page.getByRole("link", { name: "Sessions", exact: true }).click();
        await page.locator("#landing").waitFor();
        const cog = page.getByRole("link", { name: "Global settings", exact: true });
        const cogBounds = await cog.boundingBox();
        assert.ok(cogBounds && cogBounds.width >= 44 && cogBounds.height >= 44);
        await cog.click();
        await page.locator("#authorization").scrollIntoViewIfNeeded();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
      }
      assert.deepEqual(errors, []);
    },
  );

await test(`elm: settings show authorized providers`, async (t) => {
  const f = await fixture(t);
  const control = await authorizationFixture(t);
  for (const provider of ["github", "openai"] as const) {
    await control.authorization.change("login", undefined, provider);
    control.approve(provider);
  }
  const { page, base, screenshots, errors } = await browserFixture(
    t,
    f.sessions,
    control.authorization,
    undefined,
    new GlobalSettingsStore({ model }),
  );
  await page.goto(`${base}/settings`);
  for (const provider of ["github", "openai"]) {
    const section = page.locator(`#${provider}-authorization`);
    await section.locator('[data-state="usable"]').waitFor();
    assert.equal(
      await section.getByRole("button", { name: "Reauthorize", exact: true }).count(),
      0,
    );
    assert.equal(await section.getByRole("button", { name: "Authorize", exact: true }).count(), 0);
    assert.equal(
      await section.getByLabel("Account ID", { exact: true }).textContent(),
      provider === "openai" ? "account-alice" : "1",
    );
    assert.equal(await section.getByRole("status").count(), 0);
    assert.equal(
      await section
        .getByRole("heading", { level: 3 })
        .getByLabel("Account ID", { exact: true })
        .count(),
      1,
    );
    const remove = section.getByRole("button", { name: "Remove authorization", exact: true });
    assert.equal(await section.getByRole("button").count(), 1);
    assert.equal(await section.getByRole("link").count(), 0);
    assert.equal(await remove.textContent(), "");
    assert.equal(await remove.locator("svg[aria-hidden=true]").count(), 1);
    const bounds = await remove.boundingBox();
    assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
    const removeBounds = await remove.locator("svg").boundingBox();
    const headingBounds = await section.getByRole("heading", { level: 3 }).boundingBox();
    assert.ok(removeBounds && headingBounds);
    assert.ok(headingBounds.x + headingBounds.width <= removeBounds.x);
    assert.ok(
      Math.abs(
        headingBounds.y + headingBounds.height / 2 - (removeBounds.y + removeBounds.height / 2),
      ) < 0.5,
    );
  }
  await page.locator("#authorization").scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  if (screenshots)
    await page.screenshot({
      path: join(screenshots, `elm-mobile-authorized.png`),
      animations: "disabled",
    });
  assert.deepEqual(errors, []);
});
