import assert from "node:assert/strict";
import { callGemini } from "./run-gemini";

// callGemini の再試行/タイムアウト堅牢化の回帰テスト。fake fetch を注入し、遅延0・sleep noop で
// 高速に検証する。ネットワークエラー/タイムアウトは 429/5xx と同じくバックオフ再試行され、
// 非再試行ステータス(400/403)は即 throw、という契約を固定する。

type FetchBehavior =
  | { type: "ok"; body?: unknown }
  | { type: "status"; status: number; retryAfter?: string; textBody?: string }
  | { type: "network"; message?: string }
  | { type: "hang" }; // signal が abort されるまで解決しない(タイムアウト経路の検証用)

const makeResponse = (behavior: Extract<FetchBehavior, { type: "ok" | "status" }>): Response => {
  if (behavior.type === "ok") {
    return {
      ok: true,
      status: 200,
      json: async () => behavior.body ?? { ok: true },
      text: async () => "",
      headers: { get: () => null },
    } as unknown as Response;
  }
  return {
    ok: false,
    status: behavior.status,
    json: async () => ({}),
    text: async () => behavior.textBody ?? "error body",
    headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? behavior.retryAfter ?? null : null) },
  } as unknown as Response;
};

// キューされた behavior を順に返す fake fetch。呼び出し回数も数える。
const makeFetch = (behaviors: FetchBehavior[]) => {
  let calls = 0;
  const fetchImpl = ((_endpoint: string, init?: { signal?: AbortSignal }) => {
    const behavior = behaviors[Math.min(calls, behaviors.length - 1)];
    calls += 1;
    if (behavior.type === "network") {
      return Promise.reject(new Error(behavior.message ?? "ECONNRESET"));
    }
    if (behavior.type === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // タイムアウト無しなら本当にハングする(テストでは使わない)
        if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
      });
    }
    return Promise.resolve(makeResponse(behavior));
  }) as unknown as typeof fetch;
  return { fetchImpl, callCount: () => calls };
};

const noopSleep = async () => {};

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  await run("retries a network error then succeeds", async () => {
    const { fetchImpl, callCount } = makeFetch([{ type: "network" }, { type: "ok", body: { ok: 1 } }]);
    const result = await callGemini("k", "m", "p", {}, { fetchImpl, retryDelaysMs: [0], sleep: noopSleep });
    assert.deepEqual(result, { ok: 1 });
    assert.equal(callCount(), 2);
  });

  await run("throws a network/timeout error once retries are exhausted", async () => {
    const { fetchImpl, callCount } = makeFetch([{ type: "network" }, { type: "network", message: "ETIMEDOUT" }]);
    await assert.rejects(
      () => callGemini("k", "m", "p", {}, { fetchImpl, retryDelaysMs: [0], sleep: noopSleep }),
      /network\/timeout/,
    );
    assert.equal(callCount(), 2); // maxRetries=1 → attempt 0 retries, attempt 1 throws
  });

  await run("aborts on timeout and retries", async () => {
    const { fetchImpl, callCount } = makeFetch([{ type: "hang" }, { type: "ok", body: { ok: 2 } }]);
    const result = await callGemini("k", "m", "p", {}, {
      fetchImpl,
      retryDelaysMs: [0],
      timeoutMs: 10,
      sleep: noopSleep,
    });
    assert.deepEqual(result, { ok: 2 });
    assert.equal(callCount(), 2);
  });

  await run("still retries HTTP 429 then succeeds", async () => {
    const { fetchImpl, callCount } = makeFetch([{ type: "status", status: 429 }, { type: "ok", body: { ok: 3 } }]);
    const result = await callGemini("k", "m", "p", {}, { fetchImpl, retryDelaysMs: [0], sleep: noopSleep });
    assert.deepEqual(result, { ok: 3 });
    assert.equal(callCount(), 2);
  });

  await run("does not retry a non-retryable status (400)", async () => {
    const { fetchImpl, callCount } = makeFetch([{ type: "status", status: 400, textBody: "bad request" }]);
    await assert.rejects(
      () => callGemini("k", "m", "p", {}, { fetchImpl, retryDelaysMs: [0, 0], sleep: noopSleep }),
      /Gemini generateContent failed: 400/,
    );
    assert.equal(callCount(), 1);
  });

  console.log("All run-gemini callGemini checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
