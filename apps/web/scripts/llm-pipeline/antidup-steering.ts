// Anti-duplication steering for the concept step.
//
// The research step remixes a frozen local corpus (data/*-signals.json + data/research-exploration/),
// so as the public feed grows the concept strategist starts reproducing concepts that are already
// live (observed 2026-07-07: one run produced 3/3 near-duplicate candidates; another selected a
// verbatim copy of a published product). Two layers, both fed from the live Project table:
//
// 1. Prompt steering: build a runtime prompts dir (copy of scripts/prompts) whose
//    concept-strategist.md ends with an exclusion list of published products plus hard rules.
//    The pipeline picks it up via PRODIA_PROMPTS_DIR (promptsBaseDir() in shared.ts).
// 2. Deterministic backstop: findVerbatimClone() lets run-gemini reject a selected concept whose
//    title/oneLiner equals a published product, feeding the guided retry so the model re-rolls
//    the concept inside the same run. Prompt steering alone is NOT sufficient — a bare list was
//    observed (2026-07-08) to make the model anchor on a listed item and copy it verbatim.
//
// The rules come BEFORE the list and the list is framed strictly as an exclusion set, paired
// with a positive redirect toward unused domains — the combination that held up in practice.

import { cp, mkdir, appendFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type PublishedProduct = { title: string; oneLiner: string };

type PrismaLikeClient = {
  project: {
    findMany: (args: {
      where: { status: { in: string[] } };
      select: { title: true; oneLiner: true };
      orderBy: { createdAt: "asc" };
    }) => Promise<Array<{ title: string | null; oneLiner: string | null }>>;
  };
};

// Public feed = manually approved ("published") + scheduler auto-publishes ("auto_published").
export const PUBLIC_FEED_STATUSES = ["published", "auto_published"];

// The exclusion list also covers held_for_review: held items are mostly semantic clones that a
// human refused to publish, so steering only on the public feed lets the concept step keep
// regenerating the same held theme (observed 2026-07-08: a 4th disaster-prep concept arrived
// while two earlier ones sat in held_for_review).
export const ANTIDUP_EXCLUSION_STATUSES = [...PUBLIC_FEED_STATUSES, "held_for_review"];

export async function fetchPublishedProducts(prisma: PrismaLikeClient): Promise<PublishedProduct[]> {
  const rows = await prisma.project.findMany({
    where: { status: { in: ANTIDUP_EXCLUSION_STATUSES } },
    // held rows have publishedAt=null, so order by the always-present createdAt instead.
    select: { title: true, oneLiner: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({ title: String(row.title ?? ""), oneLiner: String(row.oneLiner ?? "") }));
}

export function renderAntiDupSection(products: PublishedProduct[]): string {
  const lines = products.map((product) => `- ${product.title} — ${product.oneLiner}`);
  return [
    "",
    "---",
    "",
    "## 【自動注入・実行時に毎回更新・絶対厳守】アンチ重複ルール",
    "",
    "この後に「すでに本番フィードに公開済み、または審査保留(held)中のプロダクト一覧」を載せる。これは**除外リスト**であり、発想の見本・参考例ではない。次を絶対に守ること:",
    "",
    "1. **一覧にあるタイトル・oneLinerと同一またはほぼ同一の候補を出すことは失格。** 一覧の項目をそのまま、または言い換えただけで候補・selectedConceptにしてはならない。",
    "2. 一覧と「題材×インタラクション」が同型・近縁のコンセプトも候補に入れない・選ばない。同じ価値提案の別ドメイン移植だけの案も不可。",
    "3. **一覧でまだ使われていない題材領域から発想すること。ただし、専門知識がなくても一般の人がすぐ分かる題材を選ぶこと**(未使用領域に振るために専門的・ニッチになりすぎない — domainOpacityの高い候補はconceptゲートで失格する)。例: 身近な生き物や自然現象のしくみ、歴史上の出来事、体・食・ものの由来、音・色・ことばの不思議、まちの仕組み、数や図形の面白さ、など未使用で身近な領域は広く残っている。",
    "4. 各候補の `whyDifferentFromRecentArtifacts` では、一覧の中で最も近い既存作を1つ名指しし、題材とインタラクションの両方でどう違うかを具体的に書くこと。",
    "",
    `### 公開済み・審査保留プロダクト一覧(${products.length}件) — これらは作ってはいけない`,
    "",
    ...lines,
    "",
  ].join("\n");
}

// Conservative on purpose: normalized equality of title or oneLiner catches verbatim copies
// deterministically without false-killing legitimate same-genre concepts. Semantic near-dups
// remain the reviewer's call (and the prompt steering's job).
const normalizeForCloneCheck = (value: unknown): string =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[。、．，.,!?！？:：;；'"“”‘’()（）\-–—_]/g, "");

export function findVerbatimClone(
  conceptResponse: unknown,
  products: PublishedProduct[],
): { selectedTitle: string; matchedTitle: string } | null {
  if (!conceptResponse || typeof conceptResponse !== "object" || products.length === 0) return null;
  const record = conceptResponse as Record<string, unknown>;
  const selectedId =
    record.selectedConcept && typeof record.selectedConcept === "object"
      ? String((record.selectedConcept as Record<string, unknown>).id ?? "")
      : "";
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  const selected = candidates.find(
    (candidate) =>
      candidate && typeof candidate === "object" && String((candidate as Record<string, unknown>).id ?? "") === selectedId,
  ) as Record<string, unknown> | undefined;
  if (!selected) return null;

  const title = normalizeForCloneCheck(selected.title);
  const oneLiner = normalizeForCloneCheck(selected.oneLiner);
  for (const product of products) {
    if (
      (title && title === normalizeForCloneCheck(product.title)) ||
      (oneLiner && oneLiner === normalizeForCloneCheck(product.oneLiner))
    ) {
      return { selectedTitle: String(selected.title ?? ""), matchedTitle: product.title };
    }
  }
  return null;
}

export type AntidupSteeringResult = {
  promptsDir: string;
  productsFile: string;
  publishedCount: number;
};

// Per-run dir: the hourly scheduler and a manual run may overlap, and each should see the feed
// as of its own start.
export async function buildAntidupSteering(
  products: PublishedProduct[],
  runId: string,
): Promise<AntidupSteeringResult> {
  const sourcePromptsDir = path.join(process.cwd(), "scripts", "prompts");
  const promptsDir = path.join(os.tmpdir(), `prodia-antidup-prompts-${runId}`);
  await rm(promptsDir, { recursive: true, force: true });
  await mkdir(promptsDir, { recursive: true });
  await cp(sourcePromptsDir, promptsDir, { recursive: true });
  await appendFile(path.join(promptsDir, "concept-strategist.md"), renderAntiDupSection(products), "utf8");

  const productsFile = path.join(promptsDir, "published-products.json");
  await writeFile(productsFile, `${JSON.stringify(products, null, 2)}\n`, "utf8");

  return { promptsDir, productsFile, publishedCount: products.length };
}
