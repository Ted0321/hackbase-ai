"use client";

import { useState } from "react";
import styles from "./artifacts.module.css";
import { repoMaterials, type MissionMode } from "./github-mission-data";

const modeLabels: Record<MissionMode, string> = {
  beginner: "Beginner",
  builder: "Builder",
  "deep-dive": "Deep dive",
};

const actionLabels: Record<string, string> = {
  copy: "Copy",
  inspect: "Inspect",
  modify: "Modify",
  read: "Read",
  run: "Run",
};

export function GitHubMissionDemo() {
  const [repoId, setRepoId] = useState(repoMaterials[0]?.id ?? "");
  const [mode, setMode] = useState<MissionMode>("builder");
  const selectedRepo = repoMaterials.find((repo) => repo.id === repoId) ?? repoMaterials[0];
  const plan = selectedRepo.plans[mode];
  const [selectedStepId, setSelectedStepId] = useState(plan.steps[0]?.id ?? "");

  const selectedStep = plan.steps.find((step) => step.id === selectedStepId) ?? plan.steps[0];

  const selectedFiles = selectedStep.repoFileIds
    .map((fileId) => selectedRepo.fileMap.find((file) => file.id === fileId))
    .filter(Boolean);

  const switchRepo = (nextRepoId: string) => {
    const nextRepo = repoMaterials.find((repo) => repo.id === nextRepoId) ?? repoMaterials[0];
    const nextPlan = nextRepo.plans[mode];
    setRepoId(nextRepo.id);
    setSelectedStepId(nextPlan.steps[0]?.id ?? "");
  };

  const switchMode = (nextMode: MissionMode) => {
    setMode(nextMode);
    setSelectedStepId(selectedRepo.plans[nextMode].steps[0]?.id ?? "");
  };

  return (
    <div className={`${styles.demo} ${styles.missionDemo}`}>
      <div className={styles.missionShell}>
        <header className={styles.missionHero}>
          <div>
            <span className={styles.demoTag}>GitHub攻略ミッションメーカー</span>
            <h2>Repoを30分の改造ミッションに変える</h2>
            <p>
              サンプルrepoを選ぶと、AIが読む順番、触るファイル、写経ポイント、
              つまずき、次に作る改造案へ分解します。
            </p>
          </div>
          <div className={styles.missionScoreCard}>
            <span>Mission quality</span>
            <strong>{plan.quality.actionabilityScore}</strong>
            <small>actionability</small>
          </div>
        </header>

        <section className={styles.repoControlBand} aria-label="repo selection">
          <div className={styles.repoPicker}>
            {repoMaterials.map((repo) => (
              <button
                className={repo.id === selectedRepo.id ? styles.activeRepoButton : styles.repoButton}
                key={repo.id}
                type="button"
                onClick={() => switchRepo(repo.id)}
              >
                <strong>{repo.title}</strong>
                <span>{repo.stack.slice(0, 3).join(" / ")}</span>
              </button>
            ))}
          </div>
          <div className={styles.modeTabs} aria-label="mission mode">
            {(Object.keys(modeLabels) as MissionMode[]).map((item) => (
              <button
                className={item === mode ? styles.activeModeTab : undefined}
                key={item}
                type="button"
                onClick={() => switchMode(item)}
              >
                {modeLabels[item]}
              </button>
            ))}
          </div>
        </section>

        <section className={styles.missionWorkspace}>
          <aside className={styles.repoPreviewPanel}>
            <span className={styles.panelEyebrow}>Repo input</span>
            <h3>{selectedRepo.title}</h3>
            <p>{selectedRepo.repoSummary}</p>
            <div className={styles.stackList}>
              {selectedRepo.stack.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            <div className={styles.fileMap}>
              {selectedRepo.fileMap.map((file) => (
                <button
                  className={
                    selectedStep.repoFileIds.includes(file.id)
                      ? styles.activeFileRow
                      : styles.fileRow
                  }
                  key={file.id}
                  type="button"
                  onClick={() => {
                    const step = plan.steps.find((item) => item.repoFileIds.includes(file.id));
                    if (step) setSelectedStepId(step.id);
                  }}
                >
                  <span>{file.role}</span>
                  <strong>{file.path}</strong>
                </button>
              ))}
            </div>
          </aside>

          <div className={styles.missionTimelinePanel}>
            <span className={styles.panelEyebrow}>Mission route</span>
            <h3>{plan.title}</h3>
            <p>{plan.missionSummary}</p>
            <div className={styles.missionTimeline}>
              {plan.steps.map((step) => (
                <button
                  className={
                    step.id === selectedStep.id ? styles.activeMissionStep : styles.missionStepButton
                  }
                  key={step.id}
                  type="button"
                  onClick={() => setSelectedStepId(step.id)}
                >
                  <span>{String(step.order).padStart(2, "0")}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <small>
                      {actionLabels[step.actionType]} / {step.estimatedMinutes} min
                    </small>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <aside className={styles.missionDetailPanel}>
            <span className={styles.panelEyebrow}>Selected step</span>
            <h3>{selectedStep.title}</h3>
            <p>{selectedStep.purpose}</p>
            <div className={styles.missionBadges}>
              <span>{selectedStep.difficulty}</span>
              <span>{actionLabels[selectedStep.actionType]}</span>
              <span>{selectedStep.estimatedMinutes} min</span>
            </div>
            <div className={styles.missionDetailGrid}>
              <article>
                <span>Do this</span>
                <p>{selectedStep.task}</p>
              </article>
              <article>
                <span>Done when</span>
                <p>{selectedStep.completionClue}</p>
              </article>
              <article>
                <span>Watch out</span>
                <p>{selectedStep.stumblingPoint}</p>
              </article>
              <article>
                <span>Recover</span>
                <p>{selectedStep.recoveryHint}</p>
              </article>
            </div>
            <div className={styles.fileRefs}>
              {selectedFiles.map((file) => (
                <span key={file?.id}>{file?.path}</span>
              ))}
            </div>
          </aside>
        </section>

        <section className={styles.remixBand}>
          <article className={styles.remixMission}>
            <span>30-minute modification</span>
            <h3>{plan.remixMission.title}</h3>
            <p>{plan.remixMission.goal}</p>
            <div className={styles.fileRefs}>
              {plan.remixMission.targetFiles.map((file) => (
                <span key={file}>{file}</span>
              ))}
            </div>
            <strong>{plan.remixMission.successCheck}</strong>
          </article>
          <div className={styles.qualityGrid}>
            <article>
              <span>Repo grounding</span>
              <strong>{plan.quality.repoGroundingScore}</strong>
            </article>
            <article>
              <span>Actionability</span>
              <strong>{plan.quality.actionabilityScore}</strong>
            </article>
            <article>
              <span>Remix potential</span>
              <strong>{plan.quality.remixPotentialScore}</strong>
            </article>
          </div>
        </section>
      </div>
    </div>
  );
}
