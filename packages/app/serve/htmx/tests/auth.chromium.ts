import assert from "node:assert/strict";
import { test } from "node:test";
import { browserFixture } from "../../tests/browser-testing.ts";
import { authorizationFixture } from "../../tests/testing.ts";
import { fixture } from "../../tests/sessions-testing.ts";

for (const frontend of ["elm", "htmx"] as const)
  await test(
    `${frontend}: phone /auth authorizes, resumes polling, and removes credentials without a terminal`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t);
      const control = await authorizationFixture(t);
      const { page, base, errors } = await browserFixture(t, f.sessions, control.authorization);
      await page.goto(`${base}/${frontend}/`);
      assert.equal(await page.locator(`a[href="/${frontend}/auth"]`).count(), 0);
      await page.goto(`${base}/${frontend}/auth`);
      await page.locator('#github-authorization [data-state="not-enrolled"]').waitFor();
      assert.equal(new URL(page.url()).pathname, `/${frontend}/auth`);
      await page.getByRole("button", { name: "Authorize", exact: true }).click();
      await page.locator('#github-authorization [data-state="authorizing"]').waitFor();
      assert.equal((await control.authorization.status()).state, "authorizing");
      const approval = page.getByRole("link", { name: "GitHub device authorization", exact: true });
      assert.equal(await approval.getAttribute("href"), "https://github.com/login/device");
      assert.equal(await approval.getAttribute("target"), "_blank");
      // Leaving the page does not cancel the host's enrollment.
      await page.getByRole("link", { name: "Sessions", exact: true }).click();
      await page.locator("#landing").waitFor();
      assert.equal(await page.locator(`a[href="/${frontend}/auth"]`).count(), 0);
      await page.goto(`${base}/${frontend}/auth`);
      await page.locator('#github-authorization [data-state="authorizing"]').waitFor();
      control.approve();
      // Completion must arrive via polling, not a manual navigation.
      await page.locator('#github-authorization [data-state="usable"]').waitFor();
      assert.equal(await page.locator("#github-authorization").getAttribute("hx-get"), null);
      await page.getByRole("button", { name: "Remove authorization", exact: true }).click();
      await page.locator('#github-authorization [data-state="not-enrolled"]').waitFor();
      assert.equal((await control.authorization.status()).state, "not-enrolled");
      assert.equal(new URL(page.url()).pathname, `/${frontend}/auth`);
      assert.deepEqual(errors, []);
    },
  );
