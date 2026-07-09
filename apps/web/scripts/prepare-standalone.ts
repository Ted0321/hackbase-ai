import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "..");
const standaloneRoot = path.join(appRoot, ".next", "standalone");

function copyDir(source: string, destination: string) {
  if (!existsSync(source)) return;

  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

if (!existsSync(standaloneRoot)) {
  throw new Error("Missing .next/standalone. Run next build with output: standalone first.");
}

copyDir(path.join(appRoot, ".next", "static"), path.join(standaloneRoot, ".next", "static"));
copyDir(path.join(appRoot, "public"), path.join(standaloneRoot, "public"));
copyDir(path.join(appRoot, "prisma"), path.join(standaloneRoot, "prisma"));

console.log("Standalone assets prepared.");
