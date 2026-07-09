import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type ArtifactValidationResult = {
  status: "pass" | "fail";
  checks: Record<string, "pass" | "fail">;
  summary: string;
  errors: string[];
};

const requiredFiles = [
  "metadata.json",
  "demo.html",
  "source.tsx",
  "README.md",
  "diagrams/process.json",
  "diagrams/architecture.json",
  "mockups/mockup-briefs.json",
  "validation/self-review.json",
];
const blockedPatterns = [
  /api[_-]?key\s*[:=]/i,
  /secret\s*[:=]/i,
  /password\s*[:=]/i,
  /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /process\.env\.[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)/,
];

async function readOptional(filePath: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function fileExists(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export async function validateArtifactDirectory(artifactDir: string): Promise<ArtifactValidationResult> {
  const checks: ArtifactValidationResult["checks"] = {};
  const errors: string[] = [];

  for (const file of requiredFiles) {
    const filePath = path.join(artifactDir, file);

    try {
      const info = await stat(filePath);
      checks[`file:${file}`] = info.isFile() && info.size > 0 ? "pass" : "fail";
    } catch {
      checks[`file:${file}`] = "fail";
      errors.push(`${file} is missing`);
    }
  }

  const metadataRaw = await readOptional(path.join(artifactDir, "metadata.json"));
  if (metadataRaw) {
    try {
      const metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
      const hasRequiredMetadata =
        typeof metadata.label === "string" &&
        typeof metadata.sourcePath === "string" &&
        typeof metadata.demoPath === "string" &&
        typeof metadata.generatedAt === "string" &&
        Array.isArray(metadata.roles) &&
        Array.isArray(metadata.process) &&
        Array.isArray(metadata.architecture) &&
        Array.isArray(metadata.mockups);
      checks.metadata_json = hasRequiredMetadata ? "pass" : "fail";
      if (!hasRequiredMetadata) {
        errors.push("metadata.json does not include required fields");
      }
    } catch {
      checks.metadata_json = "fail";
      errors.push("metadata.json is not valid JSON");
    }
  } else {
    checks.metadata_json = "fail";
  }

  const demoHtml = await readOptional(path.join(artifactDir, "demo.html"));
  if (demoHtml) {
    const hasHtmlShape =
      /<!doctype html>/i.test(demoHtml) &&
      /<html[\s>]/i.test(demoHtml) &&
      /<body[\s>]/i.test(demoHtml);
    checks.demo_html = hasHtmlShape ? "pass" : "fail";
    if (!hasHtmlShape) {
      errors.push("demo.html does not look like a complete HTML document");
    }
  } else {
    checks.demo_html = "fail";
  }

  const visualManifestRaw = await readOptional(path.join(artifactDir, "mockups", "visual-manifest.json"));
  if (visualManifestRaw) {
    try {
      const visualManifest = JSON.parse(visualManifestRaw) as {
        isConceptOnly?: unknown;
        notImplementedAsSource?: unknown;
        productShowcase?: { path?: unknown; prompt?: unknown };
        uiPreview?: { path?: unknown; prompt?: unknown };
        logo?: { path?: unknown; prompt?: unknown };
      };
      const hasConceptBoundary =
        visualManifest.isConceptOnly === true && visualManifest.notImplementedAsSource === true;

      // A concept visual passes for PNG/WebP/SVG alike: existence + a prompt +
      // the concept-only boundary. The AI path keeps the same manifest shape.
      const visualCheck = async (asset?: { path?: unknown; prompt?: unknown }) => {
        const assetPath = typeof asset?.path === "string" ? asset.path : "";
        const exists = assetPath.length > 0 && (await fileExists(path.join(artifactDir, assetPath)));
        const hasPrompt = typeof asset?.prompt === "string" && asset.prompt.trim().length > 0;
        return hasConceptBoundary && exists && hasPrompt;
      };

      const showcase = visualManifest.productShowcase ?? visualManifest.uiPreview;
      checks.product_showcase_visual = (await visualCheck(showcase)) ? "pass" : "fail";
      if (checks.product_showcase_visual === "fail") {
        errors.push("mockups/visual-manifest.json must mark concept-only product showcase and point to an existing image with a prompt");
      }

      checks.product_icon_visual = (await visualCheck(visualManifest.logo)) ? "pass" : "fail";
      if (checks.product_icon_visual === "fail") {
        errors.push("mockups/visual-manifest.json must mark concept-only product icon (logo) and point to an existing image with a prompt");
      }
    } catch {
      checks.product_showcase_visual = "fail";
      errors.push("mockups/visual-manifest.json is not valid JSON");
    }
  }

  const allText = (
    await Promise.all(requiredFiles.map((file) => readOptional(path.join(artifactDir, file))))
  )
    .filter(Boolean)
    .join("\n");
  const blockedHit = blockedPatterns.find((pattern) => pattern.test(allText));
  checks.secret_scan = blockedHit ? "fail" : "pass";
  if (blockedHit) {
    errors.push(`Blocked pattern found: ${blockedHit.source}`);
  }

  const status = Object.values(checks).every((value) => value === "pass") ? "pass" : "fail";
  const passCount = Object.values(checks).filter((value) => value === "pass").length;
  const summary =
    status === "pass"
      ? `Validation pass: ${passCount}/${Object.keys(checks).length} checks passed.`
      : `Validation fail: ${errors.join("; ")}`;

  return {
    status,
    checks,
    summary,
    errors,
  };
}

if (require.main === module) {
  const artifactDir = process.argv[2];

  if (!artifactDir) {
    console.error("Usage: tsx scripts/validate-artifact.ts <artifact-dir>");
    process.exit(1);
  }

  validateArtifactDirectory(path.resolve(artifactDir))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === "pass" ? 0 : 1);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
