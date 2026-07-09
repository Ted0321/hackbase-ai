import { copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import "./load-local-env";

const keepDb = process.argv.includes("--keep-db");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const isWindows = process.platform === "win32";
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
const sourceDb = path.resolve("prisma", "dev.db");
const tempDbName = `.submission-check-${stamp}-${process.pid}.db`;
const tempDb = path.resolve("prisma", tempDbName);
const tempDatabaseUrl = `file:./prisma/${tempDbName}`;

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const spawnCommand = isWindows ? "cmd.exe" : command;
  const spawnArgs = isWindows ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "unknown status"}`);
  }
}

async function main() {
  if (!existsSync(sourceDb)) {
    throw new Error(`Source DB not found: ${path.relative(process.cwd(), sourceDb)}`);
  }

  copyFileSync(sourceDb, tempDb);
  console.log(`Created disposable submission-check DB: ${path.relative(process.cwd(), tempDb)}`);

  const env = {
    ...process.env,
    DATABASE_URL: tempDatabaseUrl,
  };

  try {
    run(npxCommand, ["prisma", "db", "push", "--accept-data-loss"], env);
    run(npmCommand, ["run", "db:seed"], env);
    run(npmCommand, ["run", "agents:outputs:metadata:write"], env);
    run(npmCommand, ["run", "submission:check:body"], env);
  } finally {
    if (keepDb) {
      console.log(`Keeping disposable DB for inspection: ${path.relative(process.cwd(), tempDb)}`);
    } else if (existsSync(tempDb)) {
      rmSync(tempDb, { force: true });
      console.log(`Removed disposable submission-check DB: ${path.relative(process.cwd(), tempDb)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
