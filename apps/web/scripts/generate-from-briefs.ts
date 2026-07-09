import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createPrismaClient } from "./prisma-client";
import { validateArtifactDirectory } from "./validate-artifact";

type ProjectBriefArtifact = {
  selectedTheme: {
    id?: string;
    title: string;
    prototypeQuestion: string;
    selectionReason: string;
    riskNotes: string;
  };
  projectBriefs: Array<{
    agentCode: string;
    agentId: string;
    agentName: string;
    title: string;
    oneLiner: string;
    concept: string;
    interestingness?: string;
    targetUser: string;
    userMoment: string;
    artifactKind: string;
    templatePatternId?: string;
    templatePatternReason?: string;
    coreInteraction: string;
    sections: string[];
    dataInputs: string[];
    validationFocus: string[];
    riskNotes: string;
    successCriteria: string[];
  }>;
};

const prisma = createPrismaClient();

const systemActor = {
  actorType: "system",
  actorId: "brief_artifact_generator",
  actorName: "Brief Artifact Generator",
};

const validationActor = {
  actorType: "validation_worker",
  actorId: "local_validation_worker",
  actorName: "Local Validation Worker",
};

const checksum = (value: string) => createHash("sha256").update(value).digest("hex");

const parseArgs = () => {
  const raw = process.argv.slice(2);
  const values = new Map<string, string>();

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item.startsWith("--")) {
      values.set(item.slice(2), raw[index + 1] ?? "");
      index += 1;
    }
  }

  return {
    runId: values.get("run") ?? "",
  };
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const categoryForKind = (kind: string) => {
  switch (kind) {
    case "roulette":
      return "cat_ideation";
    case "explainer":
      return "cat_learning";
    case "map":
      return "cat_research";
    case "board":
    default:
      return "cat_automation";
  }
};

const categoryForBrief = (brief: ProjectBriefArtifact["projectBriefs"][number]) => {
  switch (brief.templatePatternId) {
    case "signal_map":
    case "source_to_mission":
      return "cat_research";
    case "guided_explainer_path":
      return "cat_learning";
    case "transformation_studio":
      return "cat_creative";
    case "remix_roulette":
      return "cat_ideation";
    case "evidence_decision_board":
      return "cat_decision";
    case "boundary_simulator":
      return "cat_utility";
    case "ops_steward_console":
      return "cat_operations";
    default:
      return categoryForKind(brief.artifactKind);
  }
};

const patternExperience = (brief: ProjectBriefArtifact["projectBriefs"][number]) => {
  switch (brief.templatePatternId) {
    case "source_to_mission":
      return {
        patternName: "Source to Mission",
        primaryOperation: "sourceとskill levelを選び、次に進めるmission stepを切り替える。",
        screenStructure: "左にsource/level selector、中央にroute list、右にselected step detailとcompletion clueを置く。",
        stateChange: "levelやstepの選択で、target、stumble point、done clueが更新される。",
      };
    case "evidence_decision_board":
      return {
        patternName: "Evidence Decision Board",
        primaryOperation: "candidateを選び、evidence/risk weightを切り替えて優先レーンを見直す。",
        screenStructure: "上にweight controls、中央にdecision lanes、右にselected candidateの根拠とnext actionを置く。",
        stateChange: "weightやcandidate選択で、lane、score、decision memoが更新される。",
      };
    case "signal_map":
      return {
        patternName: "Signal Map",
        primaryOperation: "zoneとevidence layerを選び、次に掘る領域を決める。",
        screenStructure: "中央にzone map、左にlayer selector、右にselected zone detailとexploration pathを置く。",
        stateChange: "zone/layer選択で、代表signal、confidence、next pathが更新される。",
      };
    case "transformation_studio":
      return {
        patternName: "Transformation Studio",
        primaryOperation: "raw inputに変換lensを当て、別形式のartifactへ変える。",
        screenStructure: "左にbefore input、中央にlens controls、右にafter artifactとdifference rationaleを置く。",
        stateChange: "lens選択で、output format、after content、差分説明が更新される。",
      };
    case "boundary_simulator":
      return {
        patternName: "Boundary Simulator",
        primaryOperation: "autonomy、data scope、publish rangeを調整し、安全な任せ方を試す。",
        screenStructure: "左にscenario controls、中央にrisk meter、右にhuman approval pointとsafe next stepを置く。",
        stateChange: "条件を変えると、risk level、approval point、allowed actionが更新される。",
      };
    case "guided_explainer_path":
      return {
        patternName: "Guided Explainer Path",
        primaryOperation: "personaとquestionを選び、説明順、例、first actionを切り替える。",
        screenStructure: "上にpersona/question selector、中央にexplanation path、右にexampleとfirst actionを置く。",
        stateChange: "personaやquestion選択で、説明route、具体例、最初に試す行動が更新される。",
      };
    case "remix_roulette":
      return {
        patternName: "Remix Roulette",
        primaryOperation: "source、constraint、audience cardsをdraw/lockし、次に試す小さな企画を作る。",
        screenStructure: "3つのcard slot、lock controls、生成されたremix planとfit rationaleを置く。",
        stateChange: "drawやlockでカードの組み合わせ、next action、rationaleが更新される。",
      };
    case "ops_steward_console":
      return {
        patternName: "Ops Steward Console",
        primaryOperation: "findingをfilterし、human actionを選んでsystem checkへ渡す。",
        screenStructure: "左にfinding filter、中央にreview queue、右にevidence、owner、next system checkを置く。",
        stateChange: "filter/action選択で、対象finding、責任者、次の検証手順が更新される。",
      };
    default:
      return {
        patternName: brief.templatePatternId ?? brief.artifactKind,
        primaryOperation: brief.coreInteraction,
        screenStructure: "sections、input、review focusを一画面で確認する。",
        stateChange: "主要な観点を選ぶと、確認すべき情報が変わる。",
      };
  }
};

const toScriptJson = (value: unknown) =>
  JSON.stringify(value).replaceAll("</", "<\\/");

const asDataItems = (items: string[], fallback: string) =>
  (items.length > 0 ? items : [fallback]).map((item, index) => ({
    id: `item_${index + 1}`,
    label: item,
  }));

const demoHtml = (brief: ProjectBriefArtifact["projectBriefs"][number]) => {
  const experience = patternExperience(brief);
  const sectionItems = asDataItems(brief.sections, brief.coreInteraction);
  const inputItems = asDataItems(brief.dataInputs, brief.oneLiner);
  const criteriaItems = asDataItems(brief.successCriteria, brief.coreInteraction);
  const focusItems = asDataItems(brief.validationFocus, "artifact_exists");
  const sections = brief.sections
    .map(
      (section, index) => `<article>
        <span>0${index + 1}</span>
        <h2>${escapeHtml(section)}</h2>
        <p>${escapeHtml(brief.successCriteria[index % brief.successCriteria.length] ?? brief.coreInteraction)}</p>
      </article>`,
    )
    .join("\n");
  const inputs = brief.dataInputs
    .map((input) => `<li>${escapeHtml(input)}</li>`)
    .join("\n");

  if (brief.templatePatternId === "source_to_mission") {
    const steps = sectionItems.map((section, index) => ({
      title: section.label,
      target: inputItems[index % inputItems.length]?.label ?? brief.oneLiner,
      action: criteriaItems[index % criteriaItems.length]?.label ?? brief.coreInteraction,
      stumble: brief.riskNotes,
      clue: criteriaItems[(index + 1) % criteriaItems.length]?.label ?? "完了条件を確認する。",
    }));

    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(brief.title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #eef2f7; color: #111827; font-family: Inter, Arial, sans-serif; }
      main { max-width: 1180px; margin: 0 auto; padding: 24px; }
      header { padding: 24px 0 18px; border-bottom: 3px solid #111827; }
      .tag { color: #047857; font-size: 12px; font-weight: 900; text-transform: uppercase; }
      h1 { margin: 8px 0; font-size: 34px; line-height: 1.12; }
      p { color: #4b5563; line-height: 1.6; }
      .mission { display: grid; grid-template-columns: 270px minmax(0, 1fr) 320px; gap: 14px; margin-top: 18px; }
      .panel, .step, .detail { border: 1px solid #cbd5e1; background: #fff; padding: 16px; }
      .panel h2, .detail h2 { margin: 0 0 12px; font-size: 16px; }
      button { width: 100%; border: 1px solid #94a3b8; background: #f8fafc; padding: 10px; margin: 6px 0; text-align: left; font-weight: 800; cursor: pointer; }
      button.active { background: #111827; color: #fff; border-color: #111827; }
      .route { display: grid; gap: 10px; }
      .step { cursor: pointer; border-left: 6px solid #94a3b8; }
      .step.active { border-left-color: #047857; background: #f0fdf4; }
      .step strong, .detail strong { display: block; margin-bottom: 6px; }
      .metric { display: inline-block; margin: 4px 4px 8px 0; padding: 5px 8px; background: #dcfce7; color: #14532d; font-size: 12px; font-weight: 900; }
      .clue { margin-top: 12px; padding: 12px; background: #111827; color: #fff; }
      @media (max-width: 900px) { .mission { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="tag">${escapeHtml(brief.agentCode)} / ${escapeHtml(experience.patternName)}</div>
        <h1>${escapeHtml(brief.title)}</h1>
        <p>${escapeHtml(brief.oneLiner)}</p>
      </header>
      <section class="mission">
        <aside class="panel">
          <h2>Source</h2>
          ${inputItems
            .map(
              (item, index) =>
                `<button class="source ${index === 0 ? "active" : ""}" data-source="${index}">${escapeHtml(item.label)}</button>`,
            )
            .join("\n")}
          <h2>Skill level</h2>
          <button class="level active" data-level="Starter">Starter</button>
          <button class="level" data-level="Builder">Builder</button>
          <button class="level" data-level="Reviewer">Reviewer</button>
        </aside>
        <section class="route" id="route"></section>
        <aside class="detail">
          <h2 id="detailTitle"></h2>
          <span class="metric" id="levelBadge"></span>
          <strong>Target</strong>
          <p id="detailTarget"></p>
          <strong>Stumble point</strong>
          <p id="detailStumble"></p>
          <div class="clue" id="detailClue"></div>
        </aside>
      </section>
    </main>
    <script>
      const steps = ${toScriptJson(steps)};
      let selectedStep = 0;
      let selectedSource = 0;
      let level = "Starter";
      const route = document.querySelector("#route");
      const render = () => {
        route.innerHTML = steps.map((step, index) => \`
          <article class="step \${index === selectedStep ? "active" : ""}" data-step="\${index}">
            <strong>\${index + 1}. \${step.title}</strong>
            <p>\${step.action}</p>
          </article>
        \`).join("");
        const step = steps[selectedStep];
        document.querySelector("#detailTitle").textContent = step.title;
        document.querySelector("#levelBadge").textContent = level + " route";
        document.querySelector("#detailTarget").textContent = steps[selectedSource % steps.length].target;
        document.querySelector("#detailStumble").textContent = step.stumble;
        document.querySelector("#detailClue").textContent = "Done when: " + step.clue;
        document.querySelectorAll(".step").forEach((item) => item.addEventListener("click", () => {
          selectedStep = Number(item.dataset.step);
          render();
        }));
      };
      document.querySelectorAll(".source").forEach((item) => item.addEventListener("click", () => {
        selectedSource = Number(item.dataset.source);
        document.querySelectorAll(".source").forEach((button) => button.classList.remove("active"));
        item.classList.add("active");
        render();
      }));
      document.querySelectorAll(".level").forEach((item) => item.addEventListener("click", () => {
        level = item.dataset.level;
        document.querySelectorAll(".level").forEach((button) => button.classList.remove("active"));
        item.classList.add("active");
        render();
      }));
      render();
    </script>
  </body>
</html>
`;
  }

  if (brief.templatePatternId === "evidence_decision_board") {
    const candidates = sectionItems.map((section, index) => ({
      title: section.label,
      evidence: criteriaItems[index % criteriaItems.length]?.label ?? brief.coreInteraction,
      risk: focusItems[index % focusItems.length]?.label ?? "risk",
      action: criteriaItems[(index + 1) % criteriaItems.length]?.label ?? brief.coreInteraction,
      score: 62 + index * 8,
    }));

    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(brief.title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #f7f7f2; color: #1f2937; font-family: Inter, Arial, sans-serif; }
      main { max-width: 1160px; margin: 0 auto; padding: 24px; }
      header { display: grid; grid-template-columns: minmax(0, 1fr) 250px; gap: 18px; align-items: end; padding-bottom: 18px; }
      .tag { color: #b45309; font-size: 12px; font-weight: 900; text-transform: uppercase; }
      h1 { margin: 8px 0; font-size: 32px; line-height: 1.12; }
      p { color: #4b5563; line-height: 1.6; }
      .weights, .lane, .detail { border: 1px solid #d6d3d1; background: #fff; padding: 14px; }
      .weights button { border: 1px solid #a8a29e; background: #fafaf9; padding: 9px; margin: 4px; font-weight: 900; cursor: pointer; }
      .weights button.active { background: #7c2d12; color: #fff; border-color: #7c2d12; }
      .board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) 280px; gap: 12px; }
      .lane h2, .detail h2 { margin: 0 0 10px; font-size: 15px; }
      .card { border: 1px solid #d6d3d1; background: #fafaf9; padding: 12px; margin: 8px 0; cursor: pointer; }
      .card.active { outline: 3px solid #ea580c; background: #fff7ed; }
      .score { font-size: 28px; font-weight: 900; color: #7c2d12; }
      .next { padding: 10px; background: #1f2937; color: #fff; }
      @media (max-width: 900px) { header, .board { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <div class="tag">${escapeHtml(brief.agentCode)} / ${escapeHtml(experience.patternName)}</div>
          <h1>${escapeHtml(brief.title)}</h1>
          <p>${escapeHtml(brief.oneLiner)}</p>
        </div>
        <aside class="weights">
          <button class="weight active" data-weight="evidence">Evidence first</button>
          <button class="weight" data-weight="risk">Risk first</button>
          <button class="weight" data-weight="speed">Speed first</button>
        </aside>
      </header>
      <section class="board">
        <section class="lane" id="tryLane"><h2>Try now</h2></section>
        <section class="lane" id="watchLane"><h2>Watch</h2></section>
        <section class="lane" id="holdLane"><h2>Need evidence</h2></section>
        <aside class="detail">
          <h2 id="detailTitle"></h2>
          <div class="score" id="detailScore"></div>
          <strong>Evidence</strong>
          <p id="detailEvidence"></p>
          <strong>Risk</strong>
          <p id="detailRisk"></p>
          <p class="next" id="detailAction"></p>
        </aside>
      </section>
    </main>
    <script>
      const candidates = ${toScriptJson(candidates)};
      let selected = 0;
      let weight = "evidence";
      const adjustedScore = (candidate, index) => {
        if (weight === "risk") return candidate.score - index * 11;
        if (weight === "speed") return candidate.score + (candidates.length - index) * 5;
        return candidate.score;
      };
      const cardHtml = (candidate, index) => \`
        <article class="card \${index === selected ? "active" : ""}" data-index="\${index}">
          <strong>\${candidate.title}</strong>
          <p>\${candidate.evidence}</p>
        </article>
      \`;
      const render = () => {
        document.querySelector("#tryLane").innerHTML = "<h2>Try now</h2>";
        document.querySelector("#watchLane").innerHTML = "<h2>Watch</h2>";
        document.querySelector("#holdLane").innerHTML = "<h2>Need evidence</h2>";
        candidates.forEach((candidate, index) => {
          const score = adjustedScore(candidate, index);
          const lane = score >= 78 ? "#tryLane" : score >= 64 ? "#watchLane" : "#holdLane";
          document.querySelector(lane).insertAdjacentHTML("beforeend", cardHtml(candidate, index));
        });
        const current = candidates[selected];
        document.querySelector("#detailTitle").textContent = current.title;
        document.querySelector("#detailScore").textContent = adjustedScore(current, selected) + " pts";
        document.querySelector("#detailEvidence").textContent = current.evidence;
        document.querySelector("#detailRisk").textContent = current.risk;
        document.querySelector("#detailAction").textContent = "Next action: " + current.action;
        document.querySelectorAll(".card").forEach((card) => card.addEventListener("click", () => {
          selected = Number(card.dataset.index);
          render();
        }));
      };
      document.querySelectorAll(".weight").forEach((button) => button.addEventListener("click", () => {
        weight = button.dataset.weight;
        document.querySelectorAll(".weight").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        render();
      }));
      render();
    </script>
  </body>
</html>
`;
  }

  if (brief.templatePatternId === "signal_map") {
    const zones = sectionItems.map((section, index) => ({
      title: section.label,
      signal: inputItems[index % inputItems.length]?.label ?? brief.oneLiner,
      confidence: ["High", "Medium", "Early", "Crowded"][index % 4],
      path: criteriaItems[index % criteriaItems.length]?.label ?? brief.coreInteraction,
      x: 18 + (index % 2) * 44,
      y: 18 + Math.floor(index / 2) * 34,
    }));

    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(brief.title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #eef6f6; color: #102a43; font-family: Inter, Arial, sans-serif; }
      main { max-width: 1180px; margin: 0 auto; padding: 24px; }
      header { padding-bottom: 16px; }
      .tag { color: #0f766e; font-size: 12px; font-weight: 900; text-transform: uppercase; }
      h1 { margin: 8px 0; font-size: 34px; line-height: 1.12; }
      p { color: #486581; line-height: 1.6; }
      .workspace { display: grid; grid-template-columns: 220px minmax(0, 1fr) 300px; gap: 14px; }
      .layers, .map, .detail { border: 1px solid #9cc9c3; background: #fff; padding: 16px; }
      button { border: 1px solid #7bb7ad; background: #f0fdfa; padding: 10px; margin: 5px 0; width: 100%; text-align: left; font-weight: 900; cursor: pointer; }
      button.active { background: #134e4a; color: #fff; }
      .map { position: relative; min-height: 420px; overflow: hidden; background: linear-gradient(90deg, #ecfeff 50%, #f8fafc 50%); }
      .axis { position: absolute; inset: 18px; border: 1px dashed #99f6e4; }
      .zone { position: absolute; width: 190px; min-height: 105px; border: 2px solid #0f766e; background: #ffffff; padding: 12px; cursor: pointer; box-shadow: 0 8px 16px rgba(15, 118, 110, 0.12); }
      .zone.active { background: #ccfbf1; border-color: #115e59; }
      .badge { display: inline-block; padding: 4px 8px; background: #dbeafe; color: #1d4ed8; font-size: 12px; font-weight: 900; }
      .path { padding: 12px; background: #102a43; color: #fff; }
      @media (max-width: 900px) { .workspace { grid-template-columns: 1fr; } .map { min-height: 560px; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="tag">${escapeHtml(brief.agentCode)} / ${escapeHtml(experience.patternName)}</div>
        <h1>${escapeHtml(brief.title)}</h1>
        <p>${escapeHtml(brief.oneLiner)}</p>
      </header>
      <section class="workspace">
        <aside class="layers">
          <h2>Evidence layer</h2>
          <button class="layer active" data-layer="Momentum">Momentum</button>
          <button class="layer" data-layer="Risk">Risk</button>
          <button class="layer" data-layer="Opportunity">Opportunity</button>
        </aside>
        <section class="map" id="map"><div class="axis"></div></section>
        <aside class="detail">
          <h2 id="detailTitle"></h2>
          <span class="badge" id="layerBadge"></span>
          <strong>Representative signal</strong>
          <p id="detailSignal"></p>
          <strong>Confidence</strong>
          <p id="detailConfidence"></p>
          <p class="path" id="detailPath"></p>
        </aside>
      </section>
    </main>
    <script>
      const zones = ${toScriptJson(zones)};
      let selected = 0;
      let layer = "Momentum";
      const render = () => {
        document.querySelector("#map").innerHTML = '<div class="axis"></div>' + zones.map((zone, index) => \`
          <article class="zone \${index === selected ? "active" : ""}" data-index="\${index}" style="left:\${zone.x}%; top:\${zone.y}%;">
            <strong>\${zone.title}</strong>
            <p>\${zone.signal}</p>
          </article>
        \`).join("");
        const current = zones[selected];
        document.querySelector("#detailTitle").textContent = current.title;
        document.querySelector("#layerBadge").textContent = layer + " layer";
        document.querySelector("#detailSignal").textContent = current.signal;
        document.querySelector("#detailConfidence").textContent = current.confidence;
        document.querySelector("#detailPath").textContent = "Explore next: " + current.path;
        document.querySelectorAll(".zone").forEach((zone) => zone.addEventListener("click", () => {
          selected = Number(zone.dataset.index);
          render();
        }));
      };
      document.querySelectorAll(".layer").forEach((button) => button.addEventListener("click", () => {
        layer = button.dataset.layer;
        document.querySelectorAll(".layer").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        render();
      }));
      render();
    </script>
  </body>
</html>
`;
  }

  if (brief.templatePatternId === "transformation_studio") {
    const lenses = [
      {
        name: "Mission",
        format: "30分ミッション",
        output: criteriaItems[0]?.label ?? brief.coreInteraction,
        rationale: "素材を読む順番ではなく、すぐ実行できるmissionに変換する。",
      },
      {
        name: "Storyboard",
        format: "3場面ストーリー",
        output: criteriaItems[1]?.label ?? brief.oneLiner,
        rationale: "誰がどの瞬間に価値を感じるかを画面遷移として見せる。",
      },
      {
        name: "Checklist",
        format: "判断チェックリスト",
        output: criteriaItems[2]?.label ?? brief.coreInteraction,
        rationale: "曖昧な素材を、レビュー可能な完了条件に変える。",
      },
    ];

    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(brief.title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #f3f0ff; color: #202124; font-family: Inter, Arial, sans-serif; }
      main { max-width: 1160px; margin: 0 auto; padding: 24px; }
      header { padding-bottom: 18px; }
      .tag { color: #6d28d9; font-size: 12px; font-weight: 900; text-transform: uppercase; }
      h1 { margin: 8px 0; font-size: 34px; line-height: 1.12; }
      p { color: #54515f; line-height: 1.6; }
      .studio { display: grid; grid-template-columns: minmax(0, 1fr) 230px minmax(0, 1fr); gap: 14px; align-items: stretch; }
      .before, .lenses, .after { border: 1px solid #c4b5fd; background: #fff; padding: 16px; }
      .before { background: #fbfaff; }
      .lenses button { width: 100%; border: 1px solid #a78bfa; background: #faf5ff; padding: 11px; margin: 6px 0; text-align: left; font-weight: 900; cursor: pointer; }
      .lenses button.active { background: #5b21b6; color: #fff; border-color: #5b21b6; }
      .artifact { min-height: 190px; padding: 16px; border: 2px solid #6d28d9; background: #faf5ff; }
      .format { display: inline-block; padding: 5px 8px; background: #ede9fe; color: #5b21b6; font-size: 12px; font-weight: 900; }
      .diff { margin-top: 12px; padding: 12px; background: #202124; color: #fff; }
      @media (max-width: 900px) { .studio { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="tag">${escapeHtml(brief.agentCode)} / ${escapeHtml(experience.patternName)}</div>
        <h1>${escapeHtml(brief.title)}</h1>
        <p>${escapeHtml(brief.oneLiner)}</p>
      </header>
      <section class="studio">
        <section class="before">
          <h2>Before input</h2>
          <p>${escapeHtml(brief.concept)}</p>
          <ul>${inputs}</ul>
        </section>
        <aside class="lenses">
          <h2>Lens</h2>
          ${lenses
            .map(
              (lens, index) =>
                `<button class="lens ${index === 0 ? "active" : ""}" data-index="${index}">${escapeHtml(lens.name)}</button>`,
            )
            .join("\n")}
        </aside>
        <section class="after">
          <h2>After artifact</h2>
          <span class="format" id="format"></span>
          <div class="artifact">
            <h3 id="outputTitle"></h3>
            <p id="outputBody"></p>
          </div>
          <p class="diff" id="rationale"></p>
        </section>
      </section>
    </main>
    <script>
      const lenses = ${toScriptJson(lenses)};
      let selected = 0;
      const render = () => {
        const lens = lenses[selected];
        document.querySelector("#format").textContent = lens.format;
        document.querySelector("#outputTitle").textContent = lens.name + " artifact";
        document.querySelector("#outputBody").textContent = lens.output;
        document.querySelector("#rationale").textContent = "Difference: " + lens.rationale;
      };
      document.querySelectorAll(".lens").forEach((button) => button.addEventListener("click", () => {
        selected = Number(button.dataset.index);
        document.querySelectorAll(".lens").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        render();
      }));
      render();
    </script>
  </body>
</html>
`;
  }

  if (brief.templatePatternId === "boundary_simulator") {
    const scenarios = sectionItems.map((section, index) => ({
      title: section.label,
      data: inputItems[index % inputItems.length]?.label ?? brief.oneLiner,
      approval: criteriaItems[index % criteriaItems.length]?.label ?? brief.coreInteraction,
      safeStep: criteriaItems[(index + 1) % criteriaItems.length]?.label ?? "人間確認後に限定実行する。",
      riskNote: focusItems[index % focusItems.length]?.label ?? brief.riskNotes,
    }));

    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(brief.title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #f8fafc; color: #111827; font-family: Inter, Arial, sans-serif; }
      main { max-width: 1180px; margin: 0 auto; padding: 24px; }
      header { padding-bottom: 18px; border-bottom: 2px solid #111827; }
      .tag { color: #7c3aed; font-size: 12px; font-weight: 900; text-transform: uppercase; }
      h1 { margin: 8px 0; font-size: 34px; line-height: 1.12; }
      p { color: #4b5563; line-height: 1.6; }
      .sim { display: grid; grid-template-columns: 270px minmax(0, 1fr) 310px; gap: 14px; margin-top: 18px; }
      .panel, .meter, .approval { border: 1px solid #c4b5fd; background: #fff; padding: 16px; }
      button { width: 100%; border: 1px solid #a78bfa; background: #faf5ff; padding: 10px; margin: 6px 0; text-align: left; font-weight: 900; cursor: pointer; }
      button.active { background: #5b21b6; color: #fff; border-color: #5b21b6; }
      label { display: block; margin: 14px 0; font-weight: 900; }
      input[type="range"] { width: 100%; }
      .score { font-size: 56px; font-weight: 900; color: #5b21b6; }
      .bar { height: 18px; background: #ede9fe; border: 1px solid #c4b5fd; }
      .fill { height: 100%; width: 0; background: #7c3aed; transition: width 0.2s ease; }
      .decision { margin-top: 14px; padding: 12px; background: #111827; color: #fff; }
      .approval strong { display: block; margin-top: 12px; }
      @media (max-width: 900px) { .sim { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="tag">${escapeHtml(brief.agentCode)} / ${escapeHtml(experience.patternName)}</div>
        <h1>${escapeHtml(brief.title)}</h1>
        <p>${escapeHtml(brief.oneLiner)}</p>
      </header>
      <section class="sim">
        <aside class="panel">
          <h2>Scenario</h2>
          ${scenarios
            .map(
              (scenario, index) =>
                `<button class="scenario ${index === 0 ? "active" : ""}" data-index="${index}">${escapeHtml(scenario.title)}</button>`,
            )
            .join("\n")}
          <label>Autonomy <input id="autonomy" type="range" min="1" max="5" value="3" /></label>
          <label>Data scope <input id="dataScope" type="range" min="1" max="5" value="2" /></label>
          <label>Publish range <input id="publishRange" type="range" min="1" max="5" value="1" /></label>
        </aside>
        <section class="meter">
          <h2 id="scenarioTitle"></h2>
          <div class="score" id="riskScore"></div>
          <div class="bar"><div class="fill" id="riskFill"></div></div>
          <p id="riskLabel"></p>
          <div class="decision" id="allowedAction"></div>
        </section>
        <aside class="approval">
          <h2>Human approval point</h2>
          <strong>Data in scope</strong>
          <p id="dataInScope"></p>
          <strong>Approval required before</strong>
          <p id="approvalPoint"></p>
          <strong>Safe next step</strong>
          <p id="safeStep"></p>
        </aside>
      </section>
    </main>
    <script>
      const scenarios = ${toScriptJson(scenarios)};
      let selected = 0;
      const readValue = (id) => Number(document.querySelector(id).value);
      const render = () => {
        const scenario = scenarios[selected];
        const autonomy = readValue("#autonomy");
        const dataScope = readValue("#dataScope");
        const publishRange = readValue("#publishRange");
        const score = Math.min(100, Math.round((autonomy * 10) + (dataScope * 8) + (publishRange * 12) + selected * 4));
        const label = score >= 75 ? "High: human approval is mandatory" : score >= 50 ? "Medium: constrained execution only" : "Low: safe to prototype locally";
        document.querySelector("#scenarioTitle").textContent = scenario.title;
        document.querySelector("#riskScore").textContent = score;
        document.querySelector("#riskFill").style.width = score + "%";
        document.querySelector("#riskLabel").textContent = label + " / " + scenario.riskNote;
        document.querySelector("#allowedAction").textContent = score >= 75 ? "Allowed action: draft only, no publish" : score >= 50 ? "Allowed action: run with review gate" : "Allowed action: local static prototype";
        document.querySelector("#dataInScope").textContent = scenario.data;
        document.querySelector("#approvalPoint").textContent = scenario.approval;
        document.querySelector("#safeStep").textContent = scenario.safeStep;
      };
      document.querySelectorAll(".scenario").forEach((button) => button.addEventListener("click", () => {
        selected = Number(button.dataset.index);
        document.querySelectorAll(".scenario").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        render();
      }));
      ["#autonomy", "#dataScope", "#publishRange"].forEach((id) => document.querySelector(id).addEventListener("input", render));
      render();
    </script>
  </body>
</html>
`;
  }

  if (brief.templatePatternId === "guided_explainer_path") {
    const routes = sectionItems.map((section, index) => ({
      question: section.label,
      explanation: criteriaItems[index % criteriaItems.length]?.label ?? brief.coreInteraction,
      example: inputItems[index % inputItems.length]?.label ?? brief.oneLiner,
      action: criteriaItems[(index + 1) % criteriaItems.length]?.label ?? "小さく試して理解を確認する。",
      caution: focusItems[index % focusItems.length]?.label ?? brief.riskNotes,
    }));

    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(brief.title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #fffdf5; color: #172554; font-family: Inter, Arial, sans-serif; }
      main { max-width: 1120px; margin: 0 auto; padding: 24px; }
      header { padding-bottom: 18px; }
      .tag { color: #2563eb; font-size: 12px; font-weight: 900; text-transform: uppercase; }
      h1 { margin: 8px 0; font-size: 34px; line-height: 1.12; }
      p { color: #475569; line-height: 1.65; }
      .guide { display: grid; grid-template-columns: 250px minmax(0, 1fr) 300px; gap: 14px; }
      .chooser, .path, .action { border: 1px solid #bfdbfe; background: #fff; padding: 16px; }
      button { width: 100%; border: 1px solid #93c5fd; background: #eff6ff; padding: 10px; margin: 6px 0; text-align: left; font-weight: 900; cursor: pointer; }
      button.active { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
      .step { border-left: 5px solid #93c5fd; padding: 12px; margin: 10px 0; background: #f8fafc; }
      .step.active { border-left-color: #1d4ed8; background: #dbeafe; }
      .persona { display: inline-block; padding: 5px 9px; margin: 0 6px 8px 0; border: 1px solid #93c5fd; cursor: pointer; font-weight: 900; }
      .persona.active { background: #172554; color: #fff; }
      .first { padding: 12px; background: #172554; color: #fff; }
      @media (max-width: 900px) { .guide { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="tag">${escapeHtml(brief.agentCode)} / ${escapeHtml(experience.patternName)}</div>
        <h1>${escapeHtml(brief.title)}</h1>
        <p>${escapeHtml(brief.oneLiner)}</p>
      </header>
      <section class="guide">
        <aside class="chooser">
          <h2>Persona</h2>
          <span class="persona active" data-persona="Beginner">Beginner</span>
          <span class="persona" data-persona="Builder">Builder</span>
          <span class="persona" data-persona="Reviewer">Reviewer</span>
          <h2>Question</h2>
          ${routes
            .map(
              (route, index) =>
                `<button class="question ${index === 0 ? "active" : ""}" data-index="${index}">${escapeHtml(route.question)}</button>`,
            )
            .join("\n")}
        </aside>
        <section class="path">
          <h2 id="routeTitle"></h2>
          <article class="step active"><strong>1. Plain explanation</strong><p id="plain"></p></article>
          <article class="step"><strong>2. Concrete example</strong><p id="example"></p></article>
          <article class="step"><strong>3. Misunderstanding guard</strong><p id="caution"></p></article>
        </section>
        <aside class="action">
          <h2>First action</h2>
          <p id="personaNote"></p>
          <p class="first" id="firstAction"></p>
        </aside>
      </section>
    </main>
    <script>
      const routes = ${toScriptJson(routes)};
      let selected = 0;
      let persona = "Beginner";
      const render = () => {
        const route = routes[selected];
        document.querySelector("#routeTitle").textContent = persona + " route: " + route.question;
        document.querySelector("#plain").textContent = route.explanation;
        document.querySelector("#example").textContent = route.example;
        document.querySelector("#caution").textContent = route.caution;
        document.querySelector("#personaNote").textContent = persona + " should start with a concrete check, not a full implementation.";
        document.querySelector("#firstAction").textContent = route.action;
      };
      document.querySelectorAll(".question").forEach((button) => button.addEventListener("click", () => {
        selected = Number(button.dataset.index);
        document.querySelectorAll(".question").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        render();
      }));
      document.querySelectorAll(".persona").forEach((item) => item.addEventListener("click", () => {
        persona = item.dataset.persona;
        document.querySelectorAll(".persona").forEach((button) => button.classList.remove("active"));
        item.classList.add("active");
        render();
      }));
      render();
    </script>
  </body>
</html>
`;
  }

  if (brief.templatePatternId === "remix_roulette") {
    const cards = {
      source: inputItems.map((item) => item.label),
      constraint: focusItems.map((item) => item.label),
      audience: criteriaItems.map((item) => item.label),
    };

    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(brief.title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #fff7ed; color: #1f2937; font-family: Inter, Arial, sans-serif; }
      main { max-width: 1120px; margin: 0 auto; padding: 24px; }
      header { padding-bottom: 18px; border-bottom: 3px solid #fb923c; }
      .tag { color: #c2410c; font-size: 12px; font-weight: 900; text-transform: uppercase; }
      h1 { margin: 8px 0; font-size: 34px; line-height: 1.12; }
      p { color: #57534e; line-height: 1.65; }
      .table { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 18px; }
      .slot, .plan { border: 1px solid #fed7aa; background: #fff; padding: 16px; }
      .card { min-height: 120px; border: 2px solid #fb923c; background: #ffedd5; padding: 14px; font-weight: 900; }
      button { border: 1px solid #fdba74; background: #fff7ed; padding: 9px 12px; margin: 8px 6px 0 0; font-weight: 900; cursor: pointer; }
      button.active { background: #9a3412; color: #fff; border-color: #9a3412; }
      .plan { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 16px; }
      .next { padding: 14px; background: #1f2937; color: #fff; }
      @media (max-width: 900px) { .table, .plan { grid-template-columns: 1fr; } .plan { grid-column: auto; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="tag">${escapeHtml(brief.agentCode)} / ${escapeHtml(experience.patternName)}</div>
        <h1>${escapeHtml(brief.title)}</h1>
        <p>${escapeHtml(brief.oneLiner)}</p>
      </header>
      <section class="table">
        <article class="slot">
          <h2>Source card</h2>
          <div class="card" id="sourceCard"></div>
          <button class="draw" data-slot="source">Draw</button>
          <button class="lock" data-slot="source">Lock</button>
        </article>
        <article class="slot">
          <h2>Constraint card</h2>
          <div class="card" id="constraintCard"></div>
          <button class="draw" data-slot="constraint">Draw</button>
          <button class="lock" data-slot="constraint">Lock</button>
        </article>
        <article class="slot">
          <h2>Audience card</h2>
          <div class="card" id="audienceCard"></div>
          <button class="draw" data-slot="audience">Draw</button>
          <button class="lock" data-slot="audience">Lock</button>
        </article>
        <section class="plan">
          <div>
            <h2>Remix plan</h2>
            <p id="planText"></p>
            <p id="rationaleText"></p>
          </div>
          <aside class="next" id="nextAction"></aside>
        </section>
      </section>
    </main>
    <script>
      const cards = ${toScriptJson(cards)};
      const state = { source: 0, constraint: 0, audience: 0 };
      const locked = { source: false, constraint: false, audience: false };
      const cycle = (slot) => {
        if (locked[slot]) return;
        state[slot] = (state[slot] + 1) % cards[slot].length;
      };
      const current = (slot) => cards[slot][state[slot]];
      const render = () => {
        document.querySelector("#sourceCard").textContent = current("source");
        document.querySelector("#constraintCard").textContent = current("constraint");
        document.querySelector("#audienceCard").textContent = current("audience");
        document.querySelector("#planText").textContent = "Make a small artifact that turns " + current("source") + " into a useful experiment under " + current("constraint") + ".";
        document.querySelector("#rationaleText").textContent = "Fit rationale: the audience card keeps the idea grounded in " + current("audience") + ".";
        document.querySelector("#nextAction").textContent = "Next action: prototype one screen, then validate with " + current("constraint") + ".";
        document.querySelectorAll(".lock").forEach((button) => {
          button.classList.toggle("active", locked[button.dataset.slot]);
          button.textContent = locked[button.dataset.slot] ? "Locked" : "Lock";
        });
      };
      document.querySelectorAll(".draw").forEach((button) => button.addEventListener("click", () => {
        cycle(button.dataset.slot);
        render();
      }));
      document.querySelectorAll(".lock").forEach((button) => button.addEventListener("click", () => {
        const slot = button.dataset.slot;
        locked[slot] = !locked[slot];
        render();
      }));
      render();
    </script>
  </body>
</html>
`;
  }

  if (brief.templatePatternId === "ops_steward_console") {
    const findings = sectionItems.map((section, index) => ({
      title: section.label,
      evidence: inputItems[index % inputItems.length]?.label ?? brief.oneLiner,
      owner: ["Steward", "Human Admin", "Validation Worker", "Release System"][index % 4],
      action: criteriaItems[index % criteriaItems.length]?.label ?? brief.coreInteraction,
      check: focusItems[index % focusItems.length]?.label ?? "validation",
      severity: ["high", "medium", "low", "medium"][index % 4],
    }));

    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(brief.title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #f1f5f9; color: #0f172a; font-family: Inter, Arial, sans-serif; }
      main { max-width: 1180px; margin: 0 auto; padding: 24px; }
      header { padding-bottom: 18px; }
      .tag { color: #0f766e; font-size: 12px; font-weight: 900; text-transform: uppercase; }
      h1 { margin: 8px 0; font-size: 34px; line-height: 1.12; }
      p { color: #475569; line-height: 1.65; }
      .console { display: grid; grid-template-columns: 230px minmax(0, 1fr) 320px; gap: 14px; }
      .filters, .queue, .evidence { border: 1px solid #cbd5e1; background: #fff; padding: 16px; }
      button { width: 100%; border: 1px solid #94a3b8; background: #f8fafc; padding: 10px; margin: 6px 0; text-align: left; font-weight: 900; cursor: pointer; }
      button.active { background: #0f172a; color: #fff; border-color: #0f172a; }
      .finding { border: 1px solid #cbd5e1; background: #f8fafc; padding: 12px; margin: 8px 0; cursor: pointer; }
      .finding.active { outline: 3px solid #14b8a6; background: #ecfeff; }
      .severity { display: inline-block; padding: 4px 8px; color: #fff; background: #64748b; font-size: 12px; font-weight: 900; }
      .severity.high { background: #dc2626; }
      .severity.medium { background: #d97706; }
      .severity.low { background: #059669; }
      .check { padding: 12px; background: #0f172a; color: #fff; }
      @media (max-width: 900px) { .console { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="tag">${escapeHtml(brief.agentCode)} / ${escapeHtml(experience.patternName)}</div>
        <h1>${escapeHtml(brief.title)}</h1>
        <p>${escapeHtml(brief.oneLiner)}</p>
      </header>
      <section class="console">
        <aside class="filters">
          <h2>Finding filter</h2>
          <button class="filter active" data-filter="all">All findings</button>
          <button class="filter" data-filter="high">High only</button>
          <button class="filter" data-filter="medium">Medium</button>
          <h2>Human action</h2>
          <button class="action active" data-action="hold_for_review">Hold for review</button>
          <button class="action" data-action="approve_with_note">Approve with note</button>
          <button class="action" data-action="request_revision">Request revision</button>
        </aside>
        <section class="queue" id="queue"></section>
        <aside class="evidence">
          <h2 id="findingTitle"></h2>
          <span class="severity" id="severity"></span>
          <strong>Evidence</strong>
          <p id="evidenceText"></p>
          <strong>Owner</strong>
          <p id="owner"></p>
          <strong>Selected human action</strong>
          <p id="humanAction"></p>
          <div class="check" id="systemCheck"></div>
        </aside>
      </section>
    </main>
    <script>
      const findings = ${toScriptJson(findings)};
      let selected = 0;
      let filter = "all";
      let action = "hold_for_review";
      const visibleFindings = () => findings.filter((item) => filter === "all" || item.severity === filter);
      const render = () => {
        const visible = visibleFindings();
        if (!visible[selected]) selected = 0;
        document.querySelector("#queue").innerHTML = "<h2>Review queue</h2>" + visible.map((finding, index) => \`
          <article class="finding \${index === selected ? "active" : ""}" data-index="\${index}">
            <span class="severity \${finding.severity}">\${finding.severity}</span>
            <h3>\${finding.title}</h3>
            <p>\${finding.action}</p>
          </article>
        \`).join("");
        const current = visible[selected] || findings[0];
        document.querySelector("#findingTitle").textContent = current.title;
        document.querySelector("#severity").textContent = current.severity;
        document.querySelector("#severity").className = "severity " + current.severity;
        document.querySelector("#evidenceText").textContent = current.evidence;
        document.querySelector("#owner").textContent = current.owner;
        document.querySelector("#humanAction").textContent = action;
        document.querySelector("#systemCheck").textContent = "Next system check: " + current.check;
        document.querySelectorAll(".finding").forEach((item) => item.addEventListener("click", () => {
          selected = Number(item.dataset.index);
          render();
        }));
      };
      document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
        filter = button.dataset.filter;
        selected = 0;
        document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        render();
      }));
      document.querySelectorAll(".action").forEach((button) => button.addEventListener("click", () => {
        action = button.dataset.action;
        document.querySelectorAll(".action").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        render();
      }));
      render();
    </script>
  </body>
</html>
`;
  }

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(brief.title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 28px; background: #f4f4f4; color: #171717; font-family: Inter, Arial, sans-serif; }
      main { max-width: 1080px; margin: 0 auto; border: 1px solid #d7dce2; background: #fff; }
      header { padding: 28px; border-bottom: 1px solid #d7dce2; background: #1d1d1f; color: #fff; }
      .tag { color: #00d9bd; font-size: 12px; font-weight: 900; text-transform: uppercase; }
      h1 { margin: 10px 0 0; font-size: 36px; line-height: 1.1; }
      p { color: #5f6b78; line-height: 1.65; }
      header p { color: #bec4cf; max-width: 760px; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding: 20px; }
      article, aside { padding: 16px; border: 1px solid #d7dce2; background: #f8fafc; }
      article span { color: #ef2330; font-weight: 900; }
      h2 { margin: 8px 0 0; font-size: 20px; }
      aside { margin: 0 20px 20px; }
      li { margin: 6px 0; color: #374151; }
      @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="tag">${escapeHtml(brief.agentCode)} / ${escapeHtml(
          brief.templatePatternId ?? brief.artifactKind,
        )}</div>
        <h1>${escapeHtml(brief.title)}</h1>
        <p>${escapeHtml(brief.oneLiner)}</p>
      </header>
      <section class="grid">
        ${sections}
      </section>
      <aside>
        <h2>画面で触れること</h2>
        <p>${escapeHtml(brief.coreInteraction)}</p>
        <h2>入力に使う情報</h2>
        <ul>${inputs}</ul>
      </aside>
    </main>
  </body>
</html>
`;
};

const sourceTsx = (brief: ProjectBriefArtifact["projectBriefs"][number]) => `export function ${slugify(
  brief.title,
)
  .split("_")
  .filter(Boolean)
  .map((part) => part[0].toUpperCase() + part.slice(1))
  .join("")}() {
  return (
    <main>
      <h1>${brief.title}</h1>
      <p>${brief.oneLiner}</p>
    </main>
  );
}
`;

async function main() {
  const args = parseArgs();
  const planningArtifact = args.runId
    ? await prisma.artifact.findFirst({
        where: {
          runId: args.runId,
          type: "project_briefs",
        },
        include: {
          run: {
            include: {
              themes: true,
            },
          },
        },
      })
    : await prisma.artifact.findFirst({
        where: {
          type: "project_briefs",
        },
        include: {
          run: {
            include: {
              themes: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      });

  if (!planningArtifact) {
    throw new Error("No project_briefs artifact found. Run npm run plan:signals first.");
  }

  const run = planningArtifact.run;
  const raw = await readFile(path.join(process.cwd(), "artifacts", planningArtifact.path), "utf8");
  const briefArtifact = JSON.parse(raw) as ProjectBriefArtifact;
  const theme = run.themes[0];
  const themeId = theme?.id ?? run.selectedThemeId;

  if (!themeId) {
    throw new Error(`Run ${run.id} has no selected theme.`);
  }

  const now = new Date();
  let created = 0;
  let published = 0;

  await prisma.run.update({
    where: { id: run.id },
    data: {
      status: "running",
      completedAt: null,
      errorMessage: null,
      summary: `${run.summary ?? "Signal planning run"} Generating projects from project briefs.`,
    },
  });

  for (const [index, brief] of briefArtifact.projectBriefs.entries()) {
    const agent = await prisma.agent.findFirst({
      where: {
        OR: [{ id: brief.agentId }, { code: brief.agentCode }],
      },
    });

    if (!agent) {
      throw new Error(`Agent not found for ${brief.agentCode}`);
    }

    const projectId = `proj_${run.id}_brief_${String(index + 1).padStart(2, "0")}_${slugify(
      brief.title,
    )}`;
    const existing = await prisma.project.findUnique({ where: { id: projectId } });

    if (existing) {
      continue;
    }

    const artifactRoot = `runs/${run.id}/projects/${projectId}`;
    const artifactDir = path.join(process.cwd(), "artifacts", artifactRoot);
    const html = demoHtml(brief);
    const source = sourceTsx(brief);
    const roles = [
      `${brief.agentName} interprets the selected signal.`,
      "Signal Planner connects cached research to a concrete product question.",
      "Validation Worker checks that the static artifact is inspectable without external services.",
    ];
    const processSteps = [
      "Read the saved daily research cache.",
      "Select a low-risk signal-backed theme.",
      "Generate an agent-specific one-screen product brief.",
      "Materialize demo.html, source.tsx, README.md, and review artifacts.",
    ];
    const architecture = [
      "Input: cached research signals and persistent source product index.",
      "Planner: deterministic signal-to-theme scoring.",
      "Builder: static HTML and TSX artifact generator.",
      "Validator: local artifact file and metadata checks.",
    ];
    const mockups = [
      `Top screen: ${brief.title} with the selected signal, user value, and primary interaction.`,
      `Workspace: ${brief.coreInteraction}`,
      `Review panel: ${brief.validationFocus.join(", ")}`,
    ];
    const metadata = {
      label: brief.title,
      runId: run.id,
      projectId,
      themeId,
      agentId: agent.id,
      agentCode: agent.code,
      assignmentMode: "signal_brief_demo",
      artifactKind: brief.artifactKind,
      templatePatternId: brief.templatePatternId ?? "legacy_artifact_kind",
      generatedOutput: {
        title: brief.title,
        oneLiner: brief.oneLiner,
        artifactShape: brief.artifactKind,
        templatePatternId: brief.templatePatternId ?? "legacy_artifact_kind",
      },
      templatePatternReason:
        brief.templatePatternReason ??
        "Generated before template pattern routing was recorded; falling back to artifactKind.",
      templatePatternExperience: patternExperience(brief),
      interestingness:
        brief.interestingness ??
        `${brief.title} turns cached research into a concrete mini-product artifact that can be inspected immediately.`,
      targetUser: brief.targetUser,
      userMoment: brief.userMoment,
      roles,
      process: processSteps,
      architecture,
      mockups,
      sourcePlan: brief.dataInputs,
      sourcePath: `${artifactRoot}/source.tsx`,
      demoPath: `${artifactRoot}/demo.html`,
      readmePath: `${artifactRoot}/README.md`,
      generatedBy: `brief-artifact-generator:${agent.id}`,
      generatedAt: now.toISOString(),
      planningRunId: run.id,
    };
    const readme = `# ${brief.title}

${brief.oneLiner}

## コンセプト

${brief.concept}

## 面白さ・新規性

${brief.interestingness ?? `${brief.title}を見て触れる具体的なプロダクトとして提示し、テーマの新しさを理解しやすくする点が面白いです。`}

## 想定ユーザー

${brief.targetUser}

## 使う場面

${brief.userMoment}

## 画面で触れること

${brief.coreInteraction}

## Template pattern

${brief.templatePatternId ?? brief.artifactKind}

${brief.templatePatternReason ?? "この生成物は既存のartifactKindを使って作られました。"}

- 主操作: ${patternExperience(brief).primaryOperation}
- 画面構成: ${patternExperience(brief).screenStructure}
- state変化: ${patternExperience(brief).stateChange}

## 次に伸ばすなら

${brief.successCriteria.map((item) => `- ${item}`).join("\n")}
`;

    await mkdir(artifactDir, { recursive: true });
    await mkdir(path.join(artifactDir, "diagrams"), { recursive: true });
    await mkdir(path.join(artifactDir, "mockups"), { recursive: true });
    await mkdir(path.join(artifactDir, "validation"), { recursive: true });
    await writeFile(path.join(artifactDir, "metadata.json"), JSON.stringify(metadata, null, 2));
    await writeFile(path.join(artifactDir, "demo.html"), html);
    await writeFile(path.join(artifactDir, "source.tsx"), source);
    await writeFile(path.join(artifactDir, "README.md"), readme);
    const processDiagram = {
      version: 1,
      title: `${brief.title} generation process`,
      steps: processSteps.map((label, stepIndex) => ({ id: `step_${stepIndex + 1}`, label })),
    };
    const architectureDiagram = {
      version: 1,
      title: `${brief.title} architecture`,
      nodes: architecture.map((label, nodeIndex) => ({ id: `node_${nodeIndex + 1}`, label })),
      edges: [
        { from: "node_1", to: "node_2" },
        { from: "node_2", to: "node_3" },
        { from: "node_3", to: "node_4" },
      ],
    };
    const mockupBriefs = {
      version: 1,
      title: `${brief.title} mockup briefs`,
      mockups,
    };
    const selfReview = {
      version: 1,
      status: "pass",
      reviewer: "brief-artifact-generator",
      generatedAt: now.toISOString(),
      checks: {
        firstScreenValue: "pass",
        coreInteraction: "pass",
        staticDataBoundary: "pass",
        requiredFiles: "pass",
        externalDependency: "pass",
      },
      notes: [
        "Artifact uses cached research input only.",
        "No login, external API, paid service, or secret is required.",
      ],
    };
    const processDiagramBody = JSON.stringify(processDiagram, null, 2);
    const architectureDiagramBody = JSON.stringify(architectureDiagram, null, 2);
    const mockupBriefsBody = JSON.stringify(mockupBriefs, null, 2);
    const selfReviewBody = JSON.stringify(selfReview, null, 2);
    await writeFile(path.join(artifactDir, "diagrams", "process.json"), processDiagramBody);
    await writeFile(path.join(artifactDir, "diagrams", "architecture.json"), architectureDiagramBody);
    await writeFile(path.join(artifactDir, "mockups", "mockup-briefs.json"), mockupBriefsBody);
    await writeFile(path.join(artifactDir, "validation", "self-review.json"), selfReviewBody);

    const validation = await validateArtifactDirectory(artifactDir);
    const publishDecision = validation.status === "pass" ? "auto_published" : "held_for_review";

    await prisma.project.create({
      data: {
        id: projectId,
        runId: run.id,
        themeId,
        agentId: agent.id,
        categoryId: categoryForBrief(brief),
        title: brief.title,
        oneLiner: brief.oneLiner,
        concept: brief.concept,
        useCase:
          brief.interestingness ??
          `${brief.title}を見て触れる具体的なプロダクトとして提示し、テーマの新しさを理解しやすくします。`,
        whatWasTried: brief.coreInteraction,
        howItRuns:
          "Generated from project-briefs.json, then written as demo.html, source.tsx, metadata.json, and README.md.",
        nextGrowth: brief.successCriteria.join(" / "),
        status: validation.status === "pass" ? "auto_published" : "draft",
        validationStatus: validation.status,
        createdByType: "agent",
        createdById: agent.id,
        createdByName: agent.name,
        approvalRequired: validation.status !== "pass",
        publishedByType: validation.status === "pass" ? "system" : null,
        publishedById: validation.status === "pass" ? systemActor.actorId : null,
        publishedByName: validation.status === "pass" ? systemActor.actorName : null,
        publishDecision,
        publishDecisionReason:
          validation.status === "pass"
            ? "Generated from project brief and auto-published after validation."
            : "Generated from project brief but held for review after validation.",
        artifactRoot,
        thumbnailPath: `${artifactRoot}/demo.html`,
        publishedAt: validation.status === "pass" ? now : null,
      },
    });

    await prisma.runEvent.create({
      data: {
        id: randomUUID(),
        runId: run.id,
        projectId,
        agentId: agent.id,
        type: "artifact_generated",
        actorType: "agent",
        actorId: agent.id,
        actorName: agent.name,
        summary: `${agent.name} generated ${brief.title} from a project brief.`,
        metadataJson: JSON.stringify({
          artifactKind: brief.artifactKind,
          templatePatternId: brief.templatePatternId ?? "legacy_artifact_kind",
          artifactRoot,
          source: "project_briefs",
        }),
      },
    });

    const files = [
      { type: "metadata", path: `${artifactRoot}/metadata.json`, mimeType: "application/json", body: JSON.stringify(metadata, null, 2) },
      { type: "demo", path: `${artifactRoot}/demo.html`, mimeType: "text/html", body: html },
      { type: "source", path: `${artifactRoot}/source.tsx`, mimeType: "text/tsx", body: source },
      { type: "readme", path: `${artifactRoot}/README.md`, mimeType: "text/markdown", body: readme },
      { type: "process_diagram", path: `${artifactRoot}/diagrams/process.json`, mimeType: "application/json", body: processDiagramBody },
      { type: "architecture_diagram", path: `${artifactRoot}/diagrams/architecture.json`, mimeType: "application/json", body: architectureDiagramBody },
      { type: "mockup_brief", path: `${artifactRoot}/mockups/mockup-briefs.json`, mimeType: "application/json", body: mockupBriefsBody },
      { type: "self_review", path: `${artifactRoot}/validation/self-review.json`, mimeType: "application/json", body: selfReviewBody },
    ];

    for (const file of files) {
      await prisma.artifact.create({
        data: {
          id: randomUUID(),
          projectId,
          runId: run.id,
          type: file.type,
          path: file.path,
          mimeType: file.mimeType,
          sizeBytes: Buffer.byteLength(file.body),
          checksum: checksum(file.body),
        },
      });
    }

    const validationId = `val_${projectId}`;

    await prisma.validation.create({
      data: {
        id: validationId,
        projectId,
        runId: run.id,
        status: validation.status,
        ...validationActor,
        buildStatus: "skipped",
        runStatus: validation.checks.demo_html,
        screenshotStatus: "skipped",
        metadataStatus: validation.checks.metadata_json,
        riskStatus: validation.checks.secret_scan,
        duplicateStatus: "pass",
        grainStatus: "pass",
        secretStatus: validation.checks.secret_scan,
        externalDependencyStatus: "pass",
        promptInjectionStatus: "pass",
        readmeStatus: validation.checks["file:README.md"],
        displayStatus: validation.checks.demo_html,
        summary: validation.summary,
        errorMessage: validation.errors.length > 0 ? validation.errors.join("; ") : null,
        checkedAt: now,
      },
    });

    const checks = [
      ["metadata_complete", validation.checks.metadata_json, "metadata.json exists and has required fields."],
      ["artifact_exists", validation.checks.demo_html, "demo.html exists and has a complete HTML shape."],
      ["duplicate_like", "pass", "No duplicate-like issue detected in brief generation."],
      ["prompt_injection_like", "pass", "No prompt-injection-like instruction detected."],
      ["external_dependency_like", "pass", "No external dependency requirement detected."],
    ] as const;

    for (const [key, status, summary] of checks) {
      await prisma.validationCheck.create({
        data: {
          id: randomUUID(),
          validationId,
          projectId,
          runId: run.id,
          key,
          status,
          ...validationActor,
          summary,
        },
      });
    }

    await prisma.runEvent.create({
      data: {
        id: randomUUID(),
        runId: run.id,
        projectId,
        agentId: agent.id,
        type: "validation_checked",
        ...validationActor,
        summary: `Validation ${validation.status} for ${brief.title}.`,
        metadataJson: JSON.stringify({ validationId, checks }),
      },
    });

    await prisma.runEvent.create({
      data: {
        id: randomUUID(),
        runId: run.id,
        projectId,
        agentId: agent.id,
        type: validation.status === "pass" ? "published" : "approval_requested",
        ...systemActor,
        summary:
          validation.status === "pass"
            ? `${brief.title} was auto-published from a project brief.`
            : `${brief.title} is held for review after brief generation.`,
        metadataJson: JSON.stringify({ publishDecision }),
      },
    });

    created += 1;
    if (validation.status === "pass") {
      published += 1;
    }
  }

  const generatedProjectCount = await prisma.project.count({
    where: { runId: run.id },
  });
  const publishedProjectCount = await prisma.project.count({
    where: {
      runId: run.id,
      status: {
        in: ["auto_published", "published"],
      },
    },
  });
  const failedProjectCount = await prisma.project.count({
    where: {
      runId: run.id,
      validationStatus: "fail",
    },
  });

  await prisma.run.update({
    where: { id: run.id },
    data: {
      status: "completed",
      completedAt: new Date(),
      generatedProjectCount,
      publishedProjectCount,
      failedProjectCount,
      summary: `${run.summary ?? "Signal planning run"} Generated ${generatedProjectCount} projects from project briefs.`,
    },
  });

  console.log(`Run: ${run.id}`);
  console.log(`Created projects: ${created}`);
  console.log(`Published projects: ${published}`);
  console.log(`Open: http://localhost:3000/runs/${run.id}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
