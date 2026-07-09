import { GitHubMissionDemo } from "@/project-artifacts/github-mission-demo";
import { AppFooter, AppHeader } from "../../shared-chrome";
import styles from "../../detail.module.css";

export default function GitHubMissionArtifactPage() {
  return (
    <main className={`${styles.page} ${styles.fixedChromePage}`}>
      <AppHeader />
      <GitHubMissionDemo />
      <AppFooter />
    </main>
  );
}
