import { projectArtifactMeta } from "@/project-artifacts/metadata";

/**
 * A project has browsable source/code evidence when it either has stored Artifact
 * rows (LLM/daily-generated products always write metadata.json + source files) or
 * a static catalog entry. Seed/baseline posts have neither, so their `/source`
 * route would 404 — callers use this to hide the "コードを見る" affordance for them.
 */
export function projectHasSource(projectId: string, artifactCount: number): boolean {
  return artifactCount > 0 || projectId in projectArtifactMeta;
}
