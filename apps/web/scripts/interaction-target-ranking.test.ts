/**
 * interaction-target-ranking.ts(engagement-weighted選定)の単体テスト。
 * random を注入して決定論的に検証する。`npm run eval:target-ranking:test` で実行。
 */
import assert from "node:assert/strict";
import {
  AFFINITY_MATCH_CAP,
  engagementWeight,
  rankProjectsByEngagement,
  type EngagementRankCandidate,
} from "./interaction-target-ranking";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const NOW = new Date("2026-07-11T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const candidate = (
  id: string,
  reactions: number,
  createdAt: Date,
  signals: string[] = [],
): EngagementRankCandidate<string> => ({
  project: id,
  agentReactionCount: reactions,
  createdAt,
  preferenceSignals: signals,
});

const weightOf = (c: EngagementRankCandidate<string>, preferences?: string[]) =>
  engagementWeight({
    agentReactionCount: c.agentReactionCount,
    createdAt: c.createdAt,
    preferenceSignals: c.preferenceSignals,
    preferences,
    now: NOW,
  });

check("人気: 反応数が多いほど重みが単調に増える", () => {
  const old = daysAgo(30);
  const weights = [0, 1, 3, 7, 15].map((n) => weightOf(candidate("p", n, old)));
  for (let i = 1; i < weights.length; i += 1) {
    assert.ok(weights[i] > weights[i - 1], `expected w(${i}) > w(${i - 1})`);
  }
});

check("新着: 同じ反応数なら新しい作品の重みが大きい(1ヶ月でほぼ消える)", () => {
  const fresh = weightOf(candidate("new", 2, daysAgo(0)));
  const week = weightOf(candidate("week", 2, daysAgo(7)));
  const month = weightOf(candidate("month", 2, daysAgo(30)));
  assert.ok(fresh > week && week > month);
  // 30日後のブースト残りは +10% 未満(1に漸近)
  assert.ok(month < weightOf(candidate("base", 2, daysAgo(3650))) * 1.1);
});

check("親和: targetPreference一致で重みが増え、capを超えて増えない", () => {
  const old = daysAgo(30);
  const none = weightOf(candidate("p", 3, old, ["cat_operations"]), ["education"]);
  const one = weightOf(candidate("p", 3, old, ["cat_education"]), ["education"]);
  const many = weightOf(
    candidate("p", 3, old, ["cat_education", "workflow_tools", "beginner_projects"]),
    ["education", "workflow_tools", "beginner_projects"],
  );
  const capped = weightOf(
    candidate("p", 3, old, ["a", "b", "c", "d"]),
    ["a", "b", "c", "d"],
  );
  assert.ok(one > none, "1件一致 > 0件一致");
  assert.ok(many > one, "複数一致 > 1件一致");
  assert.equal(capped, weightOf(candidate("p", 3, old, ["a", "b"]), ["a", "b"]), `一致${AFFINITY_MATCH_CAP}件でcap`);
});

check("preferences未指定なら親和は効かない(signalsがあっても等価)", () => {
  const old = daysAgo(30);
  assert.equal(
    weightOf(candidate("p", 3, old, ["cat_education"])),
    weightOf(candidate("p", 3, old, [])),
  );
});

check("定数random: 重みの大きい順に並ぶ(決定論リグレッション)", () => {
  // key = r^(1/w) は r∈(0,1) 固定なら w が大きいほど 1 に近い → 重み降順になる。
  const candidates = [
    candidate("cold_old", 0, daysAgo(30)),
    candidate("hot", 12, daysAgo(3)),
    candidate("mid", 4, daysAgo(10)),
    candidate("cold_new", 0, daysAgo(0)),
  ];
  const order = rankProjectsByEngagement({ candidates, now: NOW, random: () => 0.5 });
  assert.deepEqual(order, ["hot", "mid", "cold_new", "cold_old"]);
});

check("シードRNG: 人気作が先頭を取ることが圧倒的に多いが、反応ゼロ新作も探索される", () => {
  let seed = 123456789;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const candidates = [
    candidate("hot", 12, daysAgo(3)),
    candidate("cold_new", 0, daysAgo(0)),
    candidate("cold_old", 0, daysAgo(20)),
  ];
  const firstCounts = new Map<string, number>();
  const trials = 3000;
  for (let i = 0; i < trials; i += 1) {
    const first = rankProjectsByEngagement({ candidates, now: NOW, random })[0];
    firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1);
  }
  const hot = firstCounts.get("hot") ?? 0;
  const coldNew = firstCounts.get("cold_new") ?? 0;
  const coldOld = firstCounts.get("cold_old") ?? 0;
  assert.ok(hot > coldNew && hot > coldOld, `人気作が最多のはず: hot=${hot} coldNew=${coldNew} coldOld=${coldOld}`);
  assert.ok(coldNew > 0 && coldOld > 0, "反応ゼロの作品にも選ばれる機会がある(探索)");
  assert.ok(coldNew > coldOld, "同じ反応ゼロなら新作の方が選ばれやすい");
});

check("rankProjectsByEngagement: 空配列は空配列を返す", () => {
  assert.deepEqual(rankProjectsByEngagement({ candidates: [], now: NOW, random: () => 0.5 }), []);
});

console.log(`\nAll ${passed} interaction-target-ranking checks passed.`);
