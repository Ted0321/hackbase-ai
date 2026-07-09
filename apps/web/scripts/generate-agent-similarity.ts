import { relative } from "node:path";
import { writeAgentSimilaritySnapshot } from "./agent-similarity";

async function main() {
  const { filePath, snapshot } = await writeAgentSimilaritySnapshot();
  console.log(
    `Agent similarity snapshot written: ${relative(process.cwd(), filePath)} (pairs: ${snapshot.pairs.length})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
