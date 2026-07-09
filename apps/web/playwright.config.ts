import { defineConfig, devices } from "@playwright/test";

const defaultPort = "3012";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${defaultPort}`;
const parsedBaseUrl = new URL(baseURL);
const port = parsedBaseUrl.port || defaultPort;
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

process.env.PRODIA_ADMIN_WRITE_KEY =
  process.env.PLAYWRIGHT_ADMIN_WRITE_KEY ?? process.env.PRODIA_ADMIN_WRITE_KEY ?? "admin-agent-console-e2e-key";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: process.env.CI ? "off" : "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
      },
    },
  ],
  webServer:
    process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1"
      ? undefined
      : {
          command: `${npmBin} run dev -- --hostname 127.0.0.1 --port ${port}`,
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: "pipe",
          stderr: "pipe",
        },
});
