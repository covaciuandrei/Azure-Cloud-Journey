import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { approvedAdministrativeAccount, matchesProjectBudget } from "./preflight.js";

type Budget = Parameters<typeof matchesProjectBudget>[0];

test("cloud identity is explicitly configured, never a workstation-specific default", () => {
  assert.throws(() => approvedAdministrativeAccount({}), /explicitly approved/);
  assert.throws(() => approvedAdministrativeAccount({ AZURE_CLOUD_JOURNEY_ADMIN_EMAIL: "not-an-email" }), /explicitly approved/);
  assert.equal(approvedAdministrativeAccount({ AZURE_CLOUD_JOURNEY_ADMIN_EMAIL: " Study-Admin@example.test " }), "study-admin@example.test");
});

const desiredBudget = {
  ...JSON.parse(await readFile(new URL("./budget.json", import.meta.url), "utf8")),
  name: "billingAccounts/test/budgets/study-project",
} as Budget;

test("the authorized budget configuration passes preflight", () => {
  assert.equal(matchesProjectBudget(desiredBudget), true);
});

test("alert order and omitted default zero/false fields do not matter", () => {
  const budget = structuredClone(desiredBudget);
  budget.thresholdRules?.reverse();
  delete budget.amount?.specifiedAmount?.nanos;
  delete budget.notificationsRule?.disableDefaultIamRecipients;
  assert.equal(matchesProjectBudget(budget), true);
});

for (const threshold of [0.5, 0.9, 1]) {
  test(`a missing ${threshold * 100}% alert fails preflight`, () => {
    const budget = structuredClone(desiredBudget);
    budget.thresholdRules = budget.thresholdRules!.filter(
      (rule) => rule.thresholdPercent !== threshold,
    );
    assert.equal(matchesProjectBudget(budget), false);
  });
}

test("duplicate, extra, and forecast-only thresholds fail preflight", () => {
  for (const rules of [
    [0.5, 1, 1].map((thresholdPercent) => ({ thresholdPercent, spendBasis: "CURRENT_SPEND" })),
    [0.5, 0.9, 1, 1.1].map((thresholdPercent) => ({ thresholdPercent, spendBasis: "CURRENT_SPEND" })),
    [0.5, 0.9, 1].map((thresholdPercent) => ({ thresholdPercent, spendBasis: "FORECASTED_SPEND" })),
  ]) {
    assert.equal(matchesProjectBudget({ ...desiredBudget, thresholdRules: rules }), false);
  }
});

test("account-wide, other-project, and multiple-project budgets fail preflight", () => {
  for (const projects of [[], ["projects/other"], ["projects/237261733668", "projects/other"]]) {
    assert.equal(matchesProjectBudget({
      ...desiredBudget,
      budgetFilter: { ...desiredBudget.budgetFilter, projects },
    }), false);
  }
});

test("narrowed or nonmonthly budgets fail preflight", () => {
  for (const extraFilter of [
    { services: ["services/example"] },
    { subaccounts: ["billingAccounts/example"] },
    { resourceAncestors: ["folders/example"] },
    { labels: { environment: ["production"] } },
    { creditTypes: ["PROMOTION"] },
    { creditTypesTreatment: "EXCLUDE_ALL_CREDITS" },
    { calendarPeriod: "YEAR" },
  ]) {
    assert.equal(matchesProjectBudget({
      ...desiredBudget,
      budgetFilter: { ...desiredBudget.budgetFilter, ...extraFilter },
    }), false);
  }
});

test("amount and currency must match the authorized one-dollar budget", () => {
  for (const specifiedAmount of [
    { currencyCode: "USD", units: "2" },
    { currencyCode: "USD", units: "1", nanos: 1 },
    { currencyCode: "EUR", units: "1" },
  ]) {
    assert.equal(matchesProjectBudget({ ...desiredBudget, amount: { specifiedAmount } }), false);
  }
});

test("both billing and project recipient notifications must be enabled", () => {
  for (const notificationsRule of [
    { disableDefaultIamRecipients: true, enableProjectLevelRecipients: true },
    { disableDefaultIamRecipients: false, enableProjectLevelRecipients: false },
    {},
  ]) {
    assert.equal(matchesProjectBudget({ ...desiredBudget, notificationsRule }), false);
  }
});
