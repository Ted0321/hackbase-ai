import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env");

if (existsSync(envPath)) {
  const raw = readFileSync(envPath, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);

    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
