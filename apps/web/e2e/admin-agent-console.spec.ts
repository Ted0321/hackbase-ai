import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AGENT_STATUSES } from "../src/lib/admin-agent-registry";
import {
  ensureAgentOperatingContractTable,
  importRegistryContractsToDb,
  readAdminAgentRegistryWithContracts,
} from "../src/lib/agent-operating-contract-store";
import { createPrismaClient, databaseUrl, isPostgresUrl } from "../src/lib/prisma-factory";

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3012";
const adminWriteKey =
  process.env.PLAYWRIGHT_ADMIN_WRITE_KEY ?? process.env.PRODIA_ADMIN_WRITE_KEY ?? "admin-agent-console-e2e-key";

const field = (scope: Page | Locator, name: string) => scope.locator(`[name="${name}"]`);
const submitButton = (scope: Page | Locator) => scope.locator('button[type="submit"]');

function assertLocalOnly() {
  const parsed = new URL(baseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error(`Admin Agent Playwright E2E can only run against localhost, got ${baseUrl}`);
  }
  if (isPostgresUrl(databaseUrl())) {
    throw new Error("Admin Agent Playwright E2E refuses to run against a postgres DATABASE_URL.");
  }
}

async function ensureImportedContracts() {
  const prisma = createPrismaClient();
  try {
    const before = await readAdminAgentRegistryWithContracts(prisma);
    if (before.contractSourceSummary.registry > 0) {
      await importRegistryContractsToDb(prisma, {
        actorType: "system",
        actorId: "admin_agent_console_playwright",
        actorName: "Admin Agent Console Playwright",
        source: "playwright_e2e",
      });
    }
    const after = await readAdminAgentRegistryWithContracts(prisma);
    expect(after.contractSourceSummary.db).toBeGreaterThanOrEqual(22);
    expect(after.contractSourceSummary.registry).toBe(0);
  } finally {
    await prisma.$disconnect();
  }
}

async function cleanupAgent(agentId: string) {
  const prisma = createPrismaClient();
  try {
    await ensureAgentOperatingContractTable(prisma);
    await prisma.userActivityLog.deleteMany({
      where: { targetType: "agent", targetId: agentId },
    });
    await prisma.adminDecision.deleteMany({
      where: { agentId },
    });
    await prisma.agent.deleteMany({
      where: { id: agentId },
    });
    await prisma.$executeRaw`DELETE FROM "AgentOperatingContract" WHERE "agentId" = ${agentId}`;
  } finally {
    await prisma.$disconnect();
  }
}

async function fillDevelopmentForm(
  page: Page,
  args: {
    agentId: string;
    adminWriteKey: string;
    displayName: string;
    oneLiner: string;
    motivation: string;
    mission: string;
  },
) {
  await field(page, "adminName").fill("Playwright Admin");
  await field(page, "adminWriteKey").fill(args.adminWriteKey);
  await field(page, "agentId").fill(args.agentId);
  await field(page, "displayName").fill(args.displayName);
  await field(page, "primaryCategoryId").selectOption("cat_ideation");
  await field(page, "roleHint").selectOption("creator");
  await field(page, "oneLiner").fill(args.oneLiner);
  await field(page, "voiceHint").selectOption("Concrete, reviewable, bounded");
  await field(page, "motivation").fill(args.motivation);
  await field(page, "mission").fill(args.mission);
  await field(page, "targetUserHint").fill("Operators reviewing product ideas.");
  await field(page, "refusesToMakeHint").fill("Credential collection and regulated decisions.");
  await field(page, "principleHint").fill("Keep outputs inspectable, bounded, and safe to review.");
  await field(page, "initialRunModeHint").selectOption("scheduler_disabled");
  await field(page, "lowSignalPolicyHint").selectOption("skip_if_low_signal");
  await field(page, "commentToneHint").selectOption("short_specific");
  await field(page, "reactionAllowedHint").selectOption("same_category");
  await field(page, "reactionForbiddenHint").fill("credential_collection");

  for (const checkbox of await field(page, "guardrails").all()) {
    await checkbox.check();
  }
  await expect(submitButton(page)).toBeEnabled();
}

test.describe.serial("admin agent console forms", () => {
  let agentId = "";

  test.beforeAll(async () => {
    assertLocalOnly();
    await ensureImportedContracts();
  });

  test.afterEach(async () => {
    if (agentId) {
      await cleanupAgent(agentId);
    }
  });

  test("rejects draft creation when admin write key is invalid", async ({ page }) => {
    agentId = `e2e_agent_bad_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

    await page.goto("/human/agents/new");
    await expect(page.getByRole("heading", { name: "AIエージェント開発" })).toBeVisible();
    await fillDevelopmentForm(page, {
      agentId,
      adminWriteKey: "definitely-wrong-key",
      displayName: "Rejected Draft Agent",
      oneLiner: "This draft should not be created.",
      motivation: "Verify admin write key rejection.",
      mission: "Do not create a contract when the write key is wrong.",
    });
    await submitButton(page).click();

    await expect(page).toHaveURL(/\/human\/agents\/new\?error=admin_write_key$/, { timeout: 2_000 });

    const prisma = createPrismaClient();
    try {
      const contract = await readAdminAgentRegistryWithContracts(prisma);
      expect(contract.agents.find((agent) => agent.agentId === agentId)).toBeUndefined();
    } finally {
      await prisma.$disconnect();
    }
  });

  test("creates a draft, saves settings, then activates through the admin UI", async ({ page }) => {
    agentId = `e2e_agent_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const displayName = "Playwright Draft Agent";
    const updatedDisplayName = "Playwright Ready Agent";

    await page.goto("/human/agents/new");
    await expect(page.getByRole("heading", { name: "AIエージェント開発" })).toBeVisible();
    await fillDevelopmentForm(page, {
      agentId,
      adminWriteKey,
      displayName,
      oneLiner: "Creates an inspectable E2E-only product planning surface.",
      motivation: "Verify that admin-created agents can be operated safely.",
      mission: "Create bounded product planning artifacts for admin review.",
    });
    await submitButton(page).click();

    await expect(page).toHaveURL(new RegExp(`/human/agents/${agentId}\\?tab=settings&created=1$`));
    await expect(page.getByText("draft Agentを作成しました。内容を確認してから有効化してください。", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: displayName })).toBeVisible();
    await expect(page.locator("section").filter({ hasText: "有効化前チェック" }).last().getByText("pass")).toHaveCount(6);

    const editForm = page.locator(`form#agent-settings-${agentId}`);
    await field(editForm, "adminName").fill("Playwright Admin");
    await field(editForm, "adminWriteKey").fill(adminWriteKey);
    await field(editForm, "displayName").fill(updatedDisplayName);
    await field(editForm, "status").selectOption("review_ready");
    await field(editForm, "cadence").selectOption("weekly");
    await field(editForm, "maxRunsPerDay").fill("2");
    await field(editForm, "cooldownHours").fill("48");
    await field(editForm, "preferredHours").fill("8");
    await field(editForm, "maxReactionsPerDay").fill("3");
    await field(editForm, "maxReactionsPerProject").fill("1");
    await submitButton(editForm).click();

    await expect(page).toHaveURL(new RegExp(`/human/agents/${agentId}\\?tab=settings&saved=1$`));
    await expect(page.getByText("設定を保存しました。")).toBeVisible();
    await expect(page.getByRole("heading", { name: updatedDisplayName })).toBeVisible();
    await expect(page.locator("main")).toContainText("review_ready");
    await expect(page.locator("section").filter({ hasText: "次回判定プレビュー" }).last()).toContainText("review_ready");

    const activationSection = page.locator("section").filter({
      hasText: "有効化前チェック",
    }).last();
    await field(activationSection, "adminName").fill("Playwright Admin");
    await field(activationSection, "adminWriteKey").fill(adminWriteKey);
    await submitButton(activationSection).click();

    await expect(page).toHaveURL(new RegExp(`/human/agents/${agentId}\\?tab=settings&activated=1$`));
    await expect(page.getByText("Agentを有効化し、scheduler対象にしました。", { exact: true })).toBeVisible();
    await expect(page.locator("main")).toContainText("active");
    await expect(page.locator("section").filter({ hasText: "DB同期" }).last()).toContainText("exists");

    const prisma = createPrismaClient();
    try {
      const contract = await readAdminAgentRegistryWithContracts(prisma);
      const created = contract.agents.find((agent) => agent.agentId === agentId);
      expect(created?.displayName).toBe(updatedDisplayName);
      expect(created?.status).toBe(AGENT_STATUSES[2]);
      expect(created?.schedulingPolicy?.enabled).toBe(true);
      expect(created?.schedulingPolicy?.cadence).toBe("weekly");
      expect(created?.interactionPolicy?.maxReactionsPerDay).toBe(3);
    } finally {
      await prisma.$disconnect();
    }
  });
});
