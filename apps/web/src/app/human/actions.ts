"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertAdminWriteAllowed, assertConsoleWriteAllowed } from "@/lib/admin-auth";
import { prisma } from "@/lib/db";

const valueOf = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
};

const stringify = (value: unknown) => JSON.stringify(value, null, 2);

const intentConfig = {
  acknowledge: {
    status: "acknowledged",
    decisionStatus: "acknowledged",
    action: "incident_acknowledged",
    reason: "Operator acknowledged the incident.",
  },
  monitor: {
    status: "monitoring",
    decisionStatus: "monitoring",
    action: "incident_monitoring",
    reason: "Operator moved the incident to monitoring.",
  },
  resolve: {
    status: "resolved",
    decisionStatus: "resolved",
    action: "incident_resolved",
    reason: "Operator resolved the incident.",
  },
} as const;

type IncidentIntent = keyof typeof intentConfig;

const isIncidentIntent = (value: string): value is IncidentIntent => value in intentConfig;

export async function updateIncidentStatusAction(formData: FormData) {
  assertConsoleWriteAllowed();
  const actor = assertAdminWriteAllowed(formData);
  const incidentId = valueOf(formData, "incidentId");
  const intent = valueOf(formData, "intent");
  const note = valueOf(formData, "note");

  if (!incidentId) {
    throw new Error("incidentId is required.");
  }

  if (!isIncidentIntent(intent)) {
    throw new Error("Unsupported incident action.");
  }

  const config = intentConfig[intent];
  const now = new Date();
  const incident = await prisma.incident.findUnique({ where: { id: incidentId } });
  if (!incident) {
    throw new Error(`Incident not found: ${incidentId}`);
  }

  await prisma.$transaction([
    prisma.incident.update({
      where: { id: incidentId },
      data: {
        status: config.status,
        acknowledgedAt: incident.acknowledgedAt ?? now,
        acknowledgedByType: incident.acknowledgedByType ?? actor.actorType,
        acknowledgedById: incident.acknowledgedById ?? actor.actorId,
        acknowledgedByName: incident.acknowledgedByName ?? actor.actorName,
        resolvedAt: intent === "resolve" ? now : null,
      },
    }),
    prisma.adminDecision.create({
      data: {
        id: randomUUID(),
        decisionType: "incident_status",
        status: config.decisionStatus,
        targetType: "incident",
        targetId: incidentId,
        projectId: incident.projectId,
        runId: incident.runId,
        agentId: incident.agentId,
        adminActorId: actor.actorId,
        adminName: actor.actorName,
        source: "human_console",
        reason: note || config.reason,
        metadataJson: stringify({
          previousStatus: incident.status,
          nextStatus: config.status,
          intent,
          fingerprint: incident.fingerprint,
        }),
      },
    }),
    prisma.userActivityLog.create({
      data: {
        id: randomUUID(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: config.action,
        targetType: "incident",
        targetId: incidentId,
        projectId: incident.projectId,
        runId: incident.runId,
        source: "human_console",
        metadataJson: stringify({
          previousStatus: incident.status,
          nextStatus: config.status,
          note: note || null,
        }),
      },
    }),
  ]);

  revalidatePath("/human");
  redirect(`/human?view=incidents&incident=${config.decisionStatus}`);
}
