import { relative } from "node:path";
import { writeAgentDiversityReport } from "./agent-diversity-report";

async function main() {
  const { filePath, report } = await writeAgentDiversityReport();
  console.log(
    `Agent diversity report written: ${relative(process.cwd(), filePath)} ` +
      `(active creators: ${report.activeCreatorCount}, pairs: ${report.includedPairwiseComparisons})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
