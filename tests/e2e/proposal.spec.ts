import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { createHash } from "node:crypto";

test("uploaded CSV keeps leading-zero values and runs without model keys", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page.getByLabel("Source file").setInputFiles({
    name: "tiny-orders.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("customer_id,amount\n00123,12.34\n00456,bad\n"),
  });
  await page.getByRole("button", { name: "Import source", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Generate proposal", exact: true }).first().click();
  await expect(page.getByText("Ready for review", { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Source evidence", exact: true }).click();
  await expect(page.getByText("00123", { exact: true }).first()).toBeVisible();
});

test("sample proposal → validation → revision → approval → exported bundle", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Generate proposal", exact: true }).first().click();
  await expect(page.getByText("Ready for review", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Validation results", exact: true }).click();
  await expect(page.getByText("Every source row accounted for", { exact: true })).toBeVisible();
  await expect(
    page.getByText("1180 accepted + 20 quarantined + 24 duplicate versions = 1224"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Transformation plan", exact: true }).click();
  await page.getByRole("button", { name: "Edit order_id", exact: true }).click();
  await page.getByLabel("Target name").fill("order_identifier");
  await page.getByRole("button", { name: /Save/ }).click();
  // Changing a dedup key name must also update its references; UI handles this edit.
  await expect(page.getByText("Ready for review", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("order_identifier REQUIRED", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Approve proposal", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approved", exact: true })).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: /Export/ })
    .first()
    .click();
  const download = await downloading;
  const files = unzipSync(await readFile((await download.path())!));
  expect(Object.keys(files)).toContain("pipeline.sql");
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  for (const [name, digest] of Object.entries(manifest.files))
    expect(createHash("sha256").update(files[name]).digest("hex")).toBe(digest);
  const proposal = JSON.parse(strFromU8(files["proposal.json"]));
  expect(proposal.revision).toBe(2);
  expect(proposal.approvedAt).toBeTruthy();
  expect(JSON.parse(strFromU8(files["validation-report.json"])).preview).toEqual([]);
});
