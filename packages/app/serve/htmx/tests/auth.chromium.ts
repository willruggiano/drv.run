import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { browserFixture } from "../../tests/browser-testing.ts";
import { authorizationFixture } from "../../tests/testing.ts";
import { fixture, model, waitFor } from "../../tests/sessions-testing.ts";
import { GlobalSettingsStore } from "../../server.ts";
import { Activity, activityDefaults } from "../../activity.ts";
import { Notifications } from "../../notifications.ts";
import { rename } from "../../sessions.ts";

for (const frontend of ["elm", "htmx"] as const)
  for (const provider of ["github", "openai"] as const)
    await test(
      `${frontend}/${provider}: mobile navigation and settings auth support enrollment, polling and removal`,
      { timeout: 30_000 },
      async (t) => {
        const f = await fixture(t);
        await rename(await f.create(), "Review the authentication flow");
        const control = await authorizationFixture(t);
        const settings = new GlobalSettingsStore({ model });
        const notifications = new Notifications(new Activity(":memory:"), {
          activity: activityDefaults,
          push: null,
        });
        t.after(() => notifications.close());
        const { page, base, errors, screenshots } = await browserFixture(
          t,
          f.sessions,
          control.authorization,
          notifications,
          settings,
        );
        page.setDefaultTimeout(10_000);
        const capture = async (name: string) => {
          if (screenshots && provider === "openai")
            await page.screenshot({ path: join(screenshots, `${frontend}-mobile-${name}.png`) });
        };
        const label = provider === "github" ? "GitHub" : "OpenAI";
        const selector = `#${provider}-authorization`;
        await page.goto(`${base}/${frontend}/`);
        await page.locator("#session-list a").waitFor();
        for (const name of ["Global settings", "Activity"]) {
          const link = page.getByRole("link", { name, exact: true });
          assert.equal(await link.isVisible(), true);
          const bounds = await link.boundingBox();
          assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
        }
        await capture("landing");
        const activity = page.getByRole("link", { name: "Activity", exact: true });
        assert.equal(await activity.getAttribute("href"), `/${frontend}/activity`);
        await activity.click();
        await page.locator("#enable-push").waitFor();
        assert.equal(new URL(page.url()).pathname, `/${frontend}/activity`);
        await page.getByRole("link", { name: "Sessions", exact: true }).click();
        await page.locator("#landing").waitFor();
        await page.getByRole("link", { name: "Global settings", exact: true }).click();
        await page.locator(`${selector} [data-state="not-enrolled"]`).waitFor();
        assert.equal(new URL(page.url()).pathname, `/${frontend}/settings`);
        assert.equal(await page.locator("#global-preferences #authorization").count(), 1);
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
        const heading = await page
          .locator(selector)
          .getByRole("heading", { level: 3 })
          .boundingBox();
        const primary = await page
          .locator(selector)
          .getByRole("button", { name: "Authorize", exact: true })
          .boundingBox();
        assert.ok(heading && primary && heading.x + heading.width <= primary.x);
        assert.ok(
          Math.abs(heading.y + heading.height / 2 - (primary.y + primary.height / 2)) < 0.5,
        );
        await page
          .locator(selector)
          .getByRole("button", { name: "Authorize", exact: true })
          .click();
        await page.locator(`${selector} [data-state="authorizing"]`).waitFor();
        assert.equal(
          (await control.authorization.status(undefined, provider)).state,
          "authorizing",
        );
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
        await page.route(`${base}/${frontend}/settings`, async (route) => {
          if (route.request().method() === "POST") {
            saving.resolve();
            await resume.promise;
          }
          await route.continue();
        });
        await page
          .locator('#global-settings select[name="hideThinkingBlock"]')
          .selectOption("true");
        await saving.promise;
        assert.equal(settings.read().values.hideThinkingBlock, false);
        control.approve(provider);
        await page.locator(`${selector} [data-state="usable"]`).waitFor();
        assert.equal(
          await page.locator('#global-settings select[name="hideThinkingBlock"]').inputValue(),
          "true",
        );
        resume.resolve();
        await waitFor(async () => settings.read().values.hideThinkingBlock === true);
        assert.equal(await page.locator(selector).getAttribute("hx-get"), null);
        await page
          .locator(selector)
          .getByRole("button", { name: "Remove authorization", exact: true })
          .click();
        await page.locator(`${selector} [data-state="not-enrolled"]`).waitFor();
        assert.equal(
          (await control.authorization.status(undefined, provider)).state,
          "not-enrolled",
        );
        assert.equal(new URL(page.url()).pathname, `/${frontend}/settings`);
        assert.equal(
          await page.locator('#global-settings select[name="hideThinkingBlock"]').inputValue(),
          "true",
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
          const bell = page.getByRole("link", { name: "Activity", exact: true });
          const cogBounds = await cog.boundingBox();
          const bellBounds = await bell.boundingBox();
          assert.ok(cogBounds && bellBounds && bellBounds.x + bellBounds.width <= cogBounds.x);
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

await test("HTMX settings auth works without JavaScript", async (t) => {
  const f = await fixture(t);
  const control = await authorizationFixture(t);
  const b = await browserFixture(
    t,
    f.sessions,
    control.authorization,
    undefined,
    new GlobalSettingsStore({ model }),
  );
  const browser = await b.browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(b.base + "/htmx/");
  await page.getByRole("link", { name: "Global settings", exact: true }).click();
  const provider = page.locator("#openai-authorization");
  await provider.getByRole("button", { name: "Authorize", exact: true }).click();
  await provider.locator('[data-state="authorizing"]').waitFor();
  assert.equal(new URL(page.url()).pathname, "/htmx/settings");
  control.approve("openai");
  await page.reload();
  await provider.locator('[data-state="usable"]').waitFor();
  await provider.getByRole("button", { name: "Remove authorization", exact: true }).click();
  await provider.locator('[data-state="not-enrolled"]').waitFor();
  assert.equal((await control.authorization.status(undefined, "openai")).state, "not-enrolled");
});

for (const frontend of ["elm", "htmx"] as const)
  await test(`${frontend}: settings show authorized providers`, async (t) => {
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
    await page.goto(`${base}/${frontend}/settings`);
    for (const provider of ["github", "openai"]) {
      const section = page.locator(`#${provider}-authorization`);
      await section.locator('[data-state="usable"]').waitFor();
      assert.equal(
        await section.getByRole("button", { name: "Reauthorize", exact: true }).count(),
        0,
      );
      assert.equal(
        await section.getByRole("button", { name: "Authorize", exact: true }).count(),
        0,
      );
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
        path: join(screenshots, `${frontend}-mobile-authorized.png`),
        animations: "disabled",
      });
    assert.deepEqual(errors, []);
  });
