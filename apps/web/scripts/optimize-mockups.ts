import { stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

type SharpLike = (input: string) => {
  resize: (options: { width: number; withoutEnlargement: boolean }) => {
    webp: (options: { quality: number }) => {
      toFile: (output: string) => Promise<unknown>;
    };
  };
};

const require = createRequire(import.meta.url);
const sharp = require("sharp") as SharpLike;

const publicMockupDir = path.join(process.cwd(), "public", "mockups");

const targets = [
  {
    input: "trading-dashboard-top.png",
    output: "trading-dashboard-top.webp",
  },
  {
    input: "trading-dashboard-workspace.png",
    output: "trading-dashboard-workspace.webp",
  },
];

const formatBytes = (value: number) => `${Math.round(value / 1024)}KB`;

async function main() {
  for (const target of targets) {
    const inputPath = path.join(publicMockupDir, target.input);
    const outputPath = path.join(publicMockupDir, target.output);

    await sharp(inputPath)
      .resize({ width: 1280, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(outputPath);

    const [before, after] = await Promise.all([stat(inputPath), stat(outputPath)]);
    console.log(`${target.output}: ${formatBytes(before.size)} -> ${formatBytes(after.size)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
