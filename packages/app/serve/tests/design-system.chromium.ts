import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fixture } from "./sessions-testing.ts";
import { browserFixture } from "./browser-testing.ts";

await test("design-system showcase works over HTTP and from disk at every breakpoint", async (t) => {
  const f = await fixture(t);
  const { assets, base, screenshots, page: showcase, errors } = await browserFixture(t, f.sessions);
  const response = await showcase.goto(`${base}/design-system.html`);
  assert.equal(response?.status(), 200);
  assert.equal(response?.headers()["content-type"], "text/html; charset=utf-8");
  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  for (const width of [320, 390, 650, 651, 1440]) {
    await showcase.setViewportSize({ width, height: 900 });
    assert.equal(
      await showcase.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(await showcase.locator(".ds-section").count(), 9);
    assert.deepEqual(
      await showcase
        .locator("#bottom-line button")
        .evaluateAll((nodes) =>
          nodes.filter((node) => node.checkVisibility()).map((node) => node.id),
        ),
      width <= 650 ? ["footer-model", "footer-context"] : ["footer-stats", "footer-context"],
    );
    assert.equal(
      await showcase
        .locator(".ds-swatch")
        .evaluateAll((nodes) =>
          nodes.every((node) => getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)"),
        ),
      true,
    );
    if (screenshots)
      await showcase.screenshot({
        path: join(screenshots, `design-system-${width}.png`),
        fullPage: true,
      });
  }
  for (const [id, close, open] of [
    ["picker", "Close sessions", "Open sessions"],
    ["preferences", "Close settings", "Open settings"],
    ["usage-dialog", "Close statistics", "Open statistics"],
  ]) {
    await showcase.getByRole("button", { name: close, exact: true }).click();
    await showcase.getByRole("button", { name: open, exact: true }).click();
    assert.equal(await showcase.locator(`#${id}`).evaluate((node) => node.matches(":modal")), true);
    await showcase.keyboard.press("Escape");
  }
  await showcase.getByRole("button", { name: "More actions", exact: true }).click();
  assert.equal(
    await showcase.locator("#live-menu").evaluate((node) => node.matches(":popover-open")),
    true,
  );
  await showcase.keyboard.press("Escape");
  await showcase.goto(pathToFileURL(join(assets, "design-system.html")).href);
  assert.equal(
    await showcase.locator("#send").evaluate((node) => getComputedStyle(node).backgroundColor),
    "rgb(180, 212, 190)",
  );
  await showcase.close();
  assert.deepEqual(errors, []);
});
