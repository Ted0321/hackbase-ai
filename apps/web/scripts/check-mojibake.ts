import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..", "..", "..");

const targets = [
  "README.md",
  "docs/README.md",
  "docs/product/DOC-01_プロダクト構想書.md",
  "docs/product/DOC-02_要件定義書.md",
  "docs/product/DOC-03_MVP定義書.md",
  "docs/product/DOC-04_AI設計書.md",
  "docs/architecture/DOC-05_技術アーキテクチャ設計書.md",
  "docs/architecture/DOC-11_データモデル草案.md",
  "docs/architecture/DOC-12_Validation条件設計書.md",
  "docs/product/DOC-16_UI世界観改訂メモ.md",
  "docs/product/DOC-20_企画生成プロンプト設計書.md",
  "docs/architecture/DOC-29_コードArtifact保管設計.md",
  "docs/product/DOC-33_Hackbase.ai名称決定メモ.md",
  "docs/submission/findy/SUBMISSION.md",
  "docs/submission/findy/FINDY_PROTO_PEDIA_FINAL.md",
  "apps/web/README.md",
  "apps/web/src/app/page.tsx",
  "apps/web/src/app/layout.tsx",
  "apps/web/src/app/projects/[id]/page.tsx",
  "apps/web/src/app/projects/[id]/source/page.tsx",
  "apps/web/src/app/runs",
  "apps/web/src/app/agents",
  "apps/web/src/app/human",
  "apps/web/scripts/templates/product-templates.json",
  "apps/web/scripts/run-core-demo.ts",
];

const mojibakePattern =
  /繧|縺|螂|譁|謚|莠|蜿|隕|逕|螳|荳|鬘|豁ｴ|蛻|貅|髱|谺|讀|菴|蟆|繝/g;

async function collectFiles(target: string): Promise<string[]> {
  const absolute = path.join(root, target);
  const stat = statSync(absolute);

  if (stat.isFile()) return [absolute];

  const entries = await readdir(absolute, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) return collectFiles(child);
      if (/\.(md|ts|tsx|json|svg)$/.test(entry.name)) return [path.join(root, child)];
      return [];
    }),
  );
  return files.flat();
}

async function main() {
  const files = (await Promise.all(targets.map(collectFiles))).flat();
  const failures: string[] = [];

  for (const file of files) {
    const body = readFileSync(file, "utf8");
    const matches = [...body.matchAll(mojibakePattern)];
    if (matches.length === 0) continue;

    const relative = path.relative(root, file);
    const sample = matches
      .slice(0, 6)
      .map((match) => match[0])
      .join(" ");
    failures.push(`${relative}: ${sample}`);
  }

  if (failures.length > 0) {
    console.error("Mojibake-like text was found in guarded files:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`Mojibake check passed for ${files.length} guarded files.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
