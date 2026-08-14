import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("login is keyboard-accessible and has no serious WCAG violations", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page.getByLabel("Pincode")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Naar hoofdinhoud" })).toBeFocused();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious"
    )
  ).toEqual([]);
});

test("login never follows an external next URL", async ({ page }) => {
  await page.goto("/login?next=https://example.com/phishing");
  await page.getByLabel("Pincode").fill("123456");
  await page.getByRole("button", { name: "Ontgrendelen" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3100/");
});

test("privacy information is public and accessible", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "Gegevensgebruik" })).toBeVisible();
  await expect(page.getByText("niet naar advertentie- of AI-diensten")).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious"
    )
  ).toEqual([]);
});
