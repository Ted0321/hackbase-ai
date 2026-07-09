"use server";

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertConsoleWriteAllowed } from "@/lib/admin-auth";
import { prisma } from "@/lib/db";
import { HUMAN_LIKE_RATINGS } from "@/lib/feedback-counts";
import { publicProjectWhere } from "@/lib/project-visibility";
import { ensureVisitorId } from "@/lib/visitor-cookie";
import { ROSTER } from "../../scripts/agent-roster";
import { defaultResearchCachePath, readResearchCache } from "../../scripts/research-cache";

const execFileAsync = promisify(execFile);

const childProcessEnv = (extra: Partial<NodeJS.ProcessEnv> = {}) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    NODE_ENV: process.env.NODE_ENV,
  };

  if (process.platform === "win32" && env.Path && env.PATH && env.Path !== env.PATH) {
    delete env.PATH;
  }

  return env;
};

const allowedRatings = new Set([
  "like",
  "want_to_grow",
  "comment",
  "bug_report",
  "report",
]);

const humanActor = {
  actorType: "human",
  actorId: "anonymous",
  actorName: "anonymous",
};

const demoGenerationFailurePath = (reason: string) =>
  `/human?demo=failed&reason=${encodeURIComponent(reason)}`;

const checkJudgeDemoCache = async () => {
  const cache = await readResearchCache(defaultResearchCachePath);

  if (!cache) {
    return { ok: false, reason: "cache_missing" };
  }

  const refreshedAt = Date.parse(cache.lastRefreshedAt);
  if (
    !Number.isFinite(refreshedAt) ||
    (Date.now() - refreshedAt) / (1000 * 60 * 60) > cache.cachePolicy.maxAgeHours
  ) {
    return { ok: false, reason: "cache_stale" };
  }

  const loadedSources = cache.sources.filter((source) => source.status === "loaded").length;
  if (
    cache.signals.length < cache.cachePolicy.minimumSignals ||
    loadedSources < cache.cachePolicy.minimumSources ||
    cache.sourceProductIndex.status !== "loaded" ||
    cache.sourceProductIndex.entryCount <= 0
  ) {
    return { ok: false, reason: "cache_inputs_insufficient" };
  }

  return { ok: true, reason: null };
};

const revalidateProjectSurfaces = (projectId: string, runId?: string, agentId?: string) => {
  revalidatePath("/");
  revalidatePath("/human");
  revalidatePath("/runs");
  revalidatePath(`/projects/${projectId}`);
  if (runId) {
    revalidatePath(`/runs/${runId}`);
  }
  if (agentId) {
    revalidatePath(`/agents/${agentId}`);
  }
};

const updateRunPublishedCount = async (runId: string) => {
  const publishedProjectCount = await prisma.project.count({
    where: {
      runId,
      status: {
        in: ["auto_published", "published"],
      },
    },
  });

  await prisma.run.update({
    where: { id: runId },
    data: {
      publishedProjectCount,
    },
  });
};

export async function addProjectFeedback(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const rating = String(formData.get("rating") ?? "");
  const comment = String(formData.get("comment") ?? "").trim();

  if (!projectId || !allowedRatings.has(rating)) {
    return;
  }

  const project = await prisma.project.findFirst({
    where: {
      ...publicProjectWhere,
      id: projectId,
    },
    select: {
      agentId: true,
      runId: true,
      title: true,
    },
  });

  if (!project) {
    return;
  }

  // ログイン無しの人間反応は匿名訪問者Cookie（ランダムUUID）で識別する。
  // actorName は従来どおり "anonymous" のままなので公開表示は変わらない。
  const visitorId = await ensureVisitorId();
  const actor = {
    actorType: humanActor.actorType,
    actorId: visitorId,
    actorName: humanActor.actorName,
  };

  // いいね系はブラウザ単位で1作品1回まで。既に押していたら取り消し（トグル）。
  if (HUMAN_LIKE_RATINGS.includes(rating)) {
    const existing = await prisma.feedback.findFirst({
      where: {
        targetType: "project",
        targetId: projectId,
        rating,
        actorType: "human",
        actorId: visitorId,
      },
      select: { id: true },
    });

    if (existing) {
      await prisma.$transaction([
        prisma.feedback.delete({ where: { id: existing.id } }),
        prisma.runEvent.deleteMany({ where: { id: `event_feedback_${existing.id}` } }),
      ]);
      revalidateProjectSurfaces(projectId, project.runId, project.agentId);
      return;
    }
  }

  const feedbackId = crypto.randomUUID();
  await prisma.$transaction([
    prisma.feedback.create({
      data: {
        id: feedbackId,
        targetType: "project",
        targetId: projectId,
        rating,
        comment: comment || null,
        ...actor,
        reviewerName: humanActor.actorName,
      },
    }),
    prisma.runEvent.create({
      data: {
        id: `event_feedback_${feedbackId}`,
        runId: project.runId,
        projectId,
        agentId: project.agentId,
        type: "feedback_added",
        ...actor,
        summary: `Human feedback "${rating}" was added to ${project.title}.`,
        metadataJson: JSON.stringify({
          feedbackId,
          rating,
          hasComment: Boolean(comment),
        }),
      },
    }),
  ]);

  revalidateProjectSurfaces(projectId, project?.runId, project?.agentId);
}

export async function approveProject(formData: FormData) {
  assertConsoleWriteAllowed();
  const projectId = String(formData.get("projectId") ?? "");

  if (!projectId) {
    return;
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      agentId: true,
      runId: true,
      title: true,
    },
  });

  if (!project) {
    return;
  }

  const now = new Date();

  await prisma.$transaction([
    prisma.project.update({
      where: { id: projectId },
      data: {
        status: "published",
        approvalRequired: false,
        approvedByType: humanActor.actorType,
        approvedById: humanActor.actorId,
        approvedByName: humanActor.actorName,
        approvedAt: now,
        publishedByType: humanActor.actorType,
        publishedById: humanActor.actorId,
        publishedByName: humanActor.actorName,
        publishedAt: now,
        publishDecision: "human_approved",
        publishDecisionReason: "Human curator approved this post from the console.",
      },
    }),
    prisma.runEvent.create({
      data: {
        id: crypto.randomUUID(),
        runId: project.runId,
        projectId,
        agentId: project.agentId,
        type: "approved",
        ...humanActor,
        summary: `${project.title} was approved by a human curator.`,
        metadataJson: JSON.stringify({
          publishDecision: "human_approved",
        }),
      },
    }),
  ]);

  await updateRunPublishedCount(project.runId);
  revalidateProjectSurfaces(projectId, project.runId, project.agentId);
}

export async function withdrawProject(formData: FormData) {
  assertConsoleWriteAllowed();
  const projectId = String(formData.get("projectId") ?? "");

  if (!projectId) {
    return;
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      agentId: true,
      runId: true,
      title: true,
    },
  });

  if (!project) {
    return;
  }

  await prisma.$transaction([
    prisma.project.update({
      where: { id: projectId },
      data: {
        status: "archived",
        approvalRequired: false,
        publishedAt: null,
        publishDecision: "withdrawn",
        publishDecisionReason: "Human curator withdrew this post from the public feed.",
      },
    }),
    prisma.runEvent.create({
      data: {
        id: crypto.randomUUID(),
        runId: project.runId,
        projectId,
        agentId: project.agentId,
        type: "withdrawn",
        ...humanActor,
        summary: `${project.title} was withdrawn by a human curator.`,
        metadataJson: JSON.stringify({
          publishDecision: "withdrawn",
        }),
      },
    }),
  ]);

  await updateRunPublishedCount(project.runId);
  revalidateProjectSurfaces(projectId, project.runId, project.agentId);
}

export async function toggleFeaturedProject(formData: FormData) {
  assertConsoleWriteAllowed();
  const projectId = String(formData.get("projectId") ?? "");
  const nextFeatured = String(formData.get("nextFeatured") ?? "") === "true";

  if (!projectId) {
    return;
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      agentId: true,
      runId: true,
      title: true,
    },
  });

  if (!project) {
    return;
  }

  await prisma.$transaction([
    prisma.project.update({
      where: { id: projectId },
      data: {
        featured: nextFeatured,
      },
    }),
    prisma.runEvent.create({
      data: {
        id: crypto.randomUUID(),
        runId: project.runId,
        projectId,
        agentId: project.agentId,
        type: nextFeatured ? "featured" : "unfeatured",
        ...humanActor,
        summary: `${project.title} was ${nextFeatured ? "featured" : "removed from featured"} by a human curator.`,
        metadataJson: JSON.stringify({
          featured: nextFeatured,
        }),
      },
    }),
  ]);

  revalidateProjectSurfaces(projectId, project.runId, project.agentId);
}

export async function runFeedbackDrivenPipeline(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const latestForTarget = projectId
    ? null
    : await prisma.feedback.findFirst({
        where: { targetType: "project" },
        orderBy: { createdAt: "desc" },
      });

  const targetProjectId = projectId || latestForTarget?.targetId;
  const project = targetProjectId
    ? await prisma.project.findUnique({
        where: { id: targetProjectId },
        select: {
          id: true,
          title: true,
          oneLiner: true,
          agentId: true,
          agent: { select: { name: true } },
        },
      })
    : null;

  if (!project) {
    redirect("/human");
  }

  // FL-3: 最新1件ではなく、対象projectの全feedbackを集計した構造化inputにする
  const projectFeedback = await prisma.feedback.findMany({
    where: { targetType: "project", targetId: project.id },
    orderBy: { createdAt: "desc" },
  });
  const likeCount = projectFeedback.filter((item) =>
    ["like", "want_to_grow", "agent_like"].includes(item.rating),
  ).length;
  const commentItems = projectFeedback.filter((item) => item.comment);
  const agentReactions = projectFeedback.filter((item) => item.actorType === "agent");
  const topComments = commentItems.slice(0, 3).map((item) => (item.comment ?? "").slice(0, 100));
  const summaryBits = [
    `likes ${likeCount}`,
    `comments ${commentItems.length}`,
    `ai-reactions ${agentReactions.length}`,
    topComments.length ? `requests: ${topComments.join(" / ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  const theme = `Feedback-driven follow-up for ${project.title}: ${summaryBits || "recent reactions"}`.slice(
    0,
    240,
  );

  // Windows + 新しめのNodeでは execFile("npm.cmd") が EINVAL になるため、
  // node + tsx CLI を直接起動する（judge demo と同じ方式）。
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const runScript = (scriptArgs: string[]) =>
    execFileAsync(process.execPath, [tsxCli, ...scriptArgs], {
      cwd: process.cwd(),
      env: childProcessEnv({ NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca" }),
      maxBuffer: 1024 * 1024 * 4,
    });

  // 対象projectにフォーカスしたguidanceを生成し、次生成プロンプトへ注入できるようにする
  try {
    await runScript(["scripts/build-feedback-digest.ts", "--project", project.id, "--quiet"]);
  } catch (error) {
    console.error("Feedback digest refresh failed (continuing).", error);
  }

  const { stdout } = await runScript([
    "scripts/generate-manual-post.ts",
    "--trigger",
    "feedback_driven",
    "--theme",
    theme,
    "--agent",
    "all",
    "--count",
    "4",
    "--kinds",
    "board,roulette,explainer,map",
  ]);
  const runId = stdout.match(/created run:?\s+(run_[^\s]+)/i)?.[1];

  // FL-3: どの反応を受けて生成したかをrun証跡に残す
  if (runId) {
    try {
      await prisma.runEvent.create({
        data: {
          id: `event_feedback_consumed_${crypto.randomUUID()}`,
          runId,
          projectId: project.id,
          agentId: project.agentId,
          type: "feedback_consumed",
          actorType: "system",
          actorId: "feedback_loop",
          actorName: "feedback_loop",
          summary: `Feedback-driven run seeded from ${project.title}: ${summaryBits || "recent reactions"}`.slice(
            0,
            300,
          ),
          metadataJson: JSON.stringify({
            sourceProjectId: project.id,
            likeCount,
            commentCount: commentItems.length,
            agentReactionCount: agentReactions.length,
            consumedFeedbackIds: projectFeedback.slice(0, 20).map((item) => item.id),
            topComments,
          }),
        },
      });
    } catch (error) {
      console.error("Failed to record feedback_consumed event (continuing).", error);
    }
  }

  revalidatePath("/");
  revalidatePath("/human");
  revalidatePath("/runs");

  if (runId) {
    revalidatePath(`/runs/${runId}`);
    redirect(`/runs/${runId}`);
  }

  redirect("/runs");
}

export async function runJudgeDemoGeneration() {
  let targetPath = demoGenerationFailurePath("runtime_error");

  try {
    const cacheCheck = await checkJudgeDemoCache();
    if (!cacheCheck.ok) {
      targetPath = demoGenerationFailurePath(cacheCheck.reason ?? "runtime_error");
    } else {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "scripts/run-demo-generation.ts"],
        {
          cwd: process.cwd(),
          env: childProcessEnv({
            NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--use-system-ca",
          }),
          maxBuffer: 1024 * 1024 * 10,
        },
      );
      const runId =
        stdout.match(/Demo run: (run_[^\s]+)/)?.[1] ??
        stdout.match(/Pipeline run: (run_[^\s]+)/)?.[1];

      if (runId) {
        revalidatePath("/");
        revalidatePath("/human");
        revalidatePath("/runs");
        revalidatePath(`/runs/${runId}`);
        targetPath = `/runs/${runId}`;
      } else {
        console.error("Judge demo generation completed without a run id.", { stdout, stderr });
        targetPath = demoGenerationFailurePath("run_id_missing");
      }
    }
  } catch (error) {
    console.error("Judge demo generation failed.", error);
  }

  redirect(targetPath);
}

// 審査員向け「能動デモ」: ランダムなエージェントを1体起こし、そのトリガーで作った1プロダクトを即reveal。
// 事前温めプール（warm-judge-pool.ts が積む fresh run）を優先し、無ければ既存の agent 作品を見せる。
// 実時間 Gemini 生成はしない（OOM/数分待ち/flaky を避ける）。常に1〜2秒で結果ページへ遷移する。
const pickRandom = <T>(arr: readonly T[]): T | undefined =>
  arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : undefined;

type WarmEntry = { projectId: string; agentId: string; trigger?: string };

export async function revealAgentDemo() {
  let targetPath = "/?demo=failed";

  try {
    let chosen: WarmEntry | null = null;

    // 1) 温めプールを優先（事前生成された fresh な agent run）
    try {
      const raw = await readFile(
        path.join(process.cwd(), "data", "judge-demo", "warm-pool.json"),
        "utf8",
      );
      const pool = (JSON.parse(raw) as WarmEntry[]).filter((e) => e?.projectId && e?.agentId);
      const pick = pickRandom(pool);
      if (pick) {
        const exists = await prisma.project.findUnique({
          where: { id: pick.projectId },
          select: { id: true },
        });
        if (exists) chosen = pick;
      }
    } catch {
      // 温めプール未整備でも以降のフォールバックで成立する
    }

    // 2) フォールバック: ランダムな active creator の最新公開プロダクトを見せる
    if (!chosen) {
      const agentId = pickRandom(ROSTER.map((spec) => spec.id));
      const byAgent = agentId
        ? await prisma.project.findFirst({
            where: {
              agentId,
              status: { in: ["auto_published", "published"] },
              createdByType: "agent",
            },
            orderBy: { publishedAt: "desc" },
            select: { id: true, agentId: true },
          })
        : null;
      const any = byAgent
        ? null
        : await prisma.project.findFirst({
            where: { status: { in: ["auto_published", "published"] }, createdByType: "agent" },
            orderBy: { publishedAt: "desc" },
            select: { id: true, agentId: true },
          });
      const proj = byAgent ?? any;
      if (proj) chosen = { projectId: proj.id, agentId: proj.agentId ?? agentId ?? "" };
    }

    if (chosen) {
      const spec = ROSTER.find((s) => s.id === chosen!.agentId);
      const handle = spec?.handle ?? chosen.agentId;
      const trigger =
        chosen.trigger ?? pickRandom(spec?.preferredInputs ?? []) ?? "today's signals";
      const proj = await prisma.project.findUnique({
        where: { id: chosen.projectId },
        select: { runId: true, title: true },
      });
      if (proj?.runId) {
        await prisma.runEvent.create({
          data: {
            id: `event_judgedemo_${Date.now()}`,
            runId: proj.runId,
            projectId: chosen.projectId,
            agentId: chosen.agentId,
            type: "judge_demo",
            actorType: "agent",
            actorId: chosen.agentId,
            actorName: handle,
            summary: `${handle} が「${trigger}」をきっかけに起き、${proj.title} を提示した。`,
            metadataJson: JSON.stringify({ trigger, source: "judge_demo_reveal" }),
          },
        });
      }
      revalidatePath("/");
      revalidatePath("/runs");
      revalidatePath(`/projects/${chosen.projectId}`);
      targetPath = `/projects/${chosen.projectId}?via=judge`;
    }
  } catch (error) {
    console.error("revealAgentDemo failed", error);
  }

  redirect(targetPath);
}
