/**
 * interaction-slot-planner.ts の単体テスト。`npm run eval:interaction-slot-planner:test` で実行。
 */
import assert from "node:assert/strict";
import { drawDailyCount, drawSlotGroup } from "./interaction-slot-planner";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("drawSlotGroup: 片方が枯渇したら残り全部をもう片方へ強制する(性格の有無に関わらず)", () => {
  assert.equal(drawSlotGroup({ remainingLike: 0, remainingComment: 3 }), "comment");
  assert.equal(drawSlotGroup({ remainingLike: 3, remainingComment: 0 }), "like");
  assert.equal(drawSlotGroup({ remainingLike: 0, remainingComment: 0 }), null);
  // 性格が強くいいね寄り(persona=0.95)でも、いいね枠が枯渇していればコメントに強制される。
  assert.equal(
    drawSlotGroup({ remainingLike: 0, remainingComment: 3, personaLikeProbability: 0.95 }),
    "comment",
  );
});

check("drawSlotGroup: personaLikeProbability未指定ならプール比のみで判定(旧来互換)", () => {
  // remainingLike/(remainingLike+remainingComment) 未満なら like
  assert.equal(drawSlotGroup({ remainingLike: 3, remainingComment: 1, random: () => 0.5 }), "like"); // 0.5 < 0.75
  assert.equal(drawSlotGroup({ remainingLike: 1, remainingComment: 3, random: () => 0.5 }), "comment"); // 0.5 >= 0.25
});

check("drawSlotGroup: personaLikeProbability指定時はプール比とブレンドされる", () => {
  // プール比=0.5(remainingLike:remainingComment=1:1)、persona=0.9、poolBalanceWeight=0.5
  // → blended = 0.5*0.5 + 0.5*0.9 = 0.70。random=0.6ならlike、random=0.8ならcomment。
  assert.equal(
    drawSlotGroup({
      remainingLike: 1,
      remainingComment: 1,
      personaLikeProbability: 0.9,
      poolBalanceWeight: 0.5,
      random: () => 0.6,
    }),
    "like",
  );
  assert.equal(
    drawSlotGroup({
      remainingLike: 1,
      remainingComment: 1,
      personaLikeProbability: 0.9,
      poolBalanceWeight: 0.5,
      random: () => 0.8,
    }),
    "comment",
  );
});

check("drawSlotGroup: poolBalanceWeight=1.0なら性格を無視しプール比のみになる", () => {
  assert.equal(
    drawSlotGroup({
      remainingLike: 1,
      remainingComment: 3,
      personaLikeProbability: 0.99,
      poolBalanceWeight: 1.0,
      random: () => 0.3,
    }),
    // blended = 1.0*0.25 + 0*0.99 = 0.25。random=0.3 >= 0.25 なので comment。
    "comment",
  );
});

check("drawSlotGroup: poolBalanceWeight=0.0なら性格のみで決まる(旧来の確率的選択と等価)", () => {
  assert.equal(
    drawSlotGroup({
      remainingLike: 1,
      remainingComment: 3,
      personaLikeProbability: 0.9,
      poolBalanceWeight: 0.0,
      random: () => 0.5,
    }),
    // blended = 0*0.25 + 1.0*0.9 = 0.9。random=0.5 < 0.9 なので like(プール比は完全無視)。
    "like",
  );
});

check("drawSlotGroup: 連続抽選は目標配分に厳密収束する(自己補正、personaありでも)", () => {
  // 決定論的な線形合同法 RNG（テスト間で再現可能にするため new Date()/Math.random は使わない）。
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const likeTarget = 6;
  const commentTarget = 6;
  let remainingLike = likeTarget;
  let remainingComment = commentTarget;
  let likes = 0;
  let comments = 0;
  // 強めにいいね寄りな性格(0.85)でブレンドしても、枯渇時の強制により最終合計は目標どおりになる。
  for (let i = 0; i < 30; i += 1) {
    const group = drawSlotGroup({ remainingLike, remainingComment, personaLikeProbability: 0.85, random });
    if (!group) break;
    if (group === "like") {
      likes += 1;
      remainingLike -= 1;
    } else {
      comments += 1;
      remainingComment -= 1;
    }
  }
  assert.equal(likes, likeTarget);
  assert.equal(comments, commentTarget);
});

check("drawDailyCount: 0..maxDailyの範囲に収まる", () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 200; i += 1) {
    const count = drawDailyCount(2, random);
    assert.ok(count >= 0 && count <= 2, `count=${count} out of range`);
  }
});

check("drawDailyCount: maxDaily=0なら常に0", () => {
  assert.equal(drawDailyCount(0, () => 0.99), 0);
});

console.log(`\nAll ${passed} interaction-slot-planner checks passed.`);
