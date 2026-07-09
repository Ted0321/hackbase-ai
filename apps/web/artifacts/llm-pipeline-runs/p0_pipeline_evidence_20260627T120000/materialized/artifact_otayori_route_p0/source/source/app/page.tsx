"use client";

import { useMemo, useState } from "react";

type ActionStatus = "ready" | "due_soon" | "needs_confirmation";
type ReviewMark = "unreviewed" | "ready" | "follow_up";

type NoticeAction = {
  id: string;
  title: string;
  actor: string;
  dueDate: string;
  materials: string[];
  status: ActionStatus;
  sourceQuote: string;
  confidence: "high" | "medium" | "low";
  uncertainty: string;
};

const noticeText =
  "Field Day is scheduled for next Tuesday. Please return the attendance form by Friday. Students should bring indoor shoes in case of rain. Lunch details will be announced separately.";

const actions: NoticeAction[] = [
  {
    id: "attendance",
    title: "Submit attendance form",
    actor: "Guardian",
    dueDate: "Friday",
    materials: ["attendance form"],
    status: "due_soon",
    sourceQuote: "Please return the attendance form by Friday.",
    confidence: "high",
    uncertainty: "None",
  },
  {
    id: "shoes",
    title: "Prepare indoor shoes",
    actor: "Child",
    dueDate: "Event morning",
    materials: ["indoor shoes"],
    status: "ready",
    sourceQuote: "Students should bring indoor shoes in case of rain.",
    confidence: "medium",
    uncertainty: "Only needed if rain plan is used.",
  },
  {
    id: "lunch",
    title: "Confirm lunch plan",
    actor: "Guardian",
    dueDate: "Before event day",
    materials: ["lunch notice"],
    status: "needs_confirmation",
    sourceQuote: "Lunch details will be announced separately.",
    confidence: "low",
    uncertainty: "Wait for the separate lunch announcement.",
  },
];

const filters = [
  { id: "all", label: "All actions" },
  { id: "due_soon", label: "Due soon" },
  { id: "needs_confirmation", label: "Needs confirmation" },
] as const;

export default function OtayoriRoutePage() {
  const [filter, setFilter] = useState<(typeof filters)[number]["id"]>("all");
  const [selectedActionId, setSelectedActionId] = useState(actions[0].id);
  const [reviewMarks, setReviewMarks] = useState<Record<string, ReviewMark>>({});

  const visibleActions = useMemo(
    () => actions.filter((action) => filter === "all" || action.status === filter),
    [filter],
  );
  const selectedAction = actions.find((action) => action.id === selectedActionId) ?? actions[0];
  const readyCount = Object.values(reviewMarks).filter((mark) => mark === "ready").length;
  const followUpCount = Object.values(reviewMarks).filter((mark) => mark === "follow_up").length;

  const markAction = (actionId: string, mark: ReviewMark) => {
    setReviewMarks((current) => ({ ...current, [actionId]: mark }));
    setSelectedActionId(actionId);
  };

  return (
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", padding: 24, color: "#182026" }}>
      <header style={{ marginBottom: 20 }}>
        <p style={{ margin: 0, color: "#5c6a72", fontSize: 14 }}>Static artifact / source-linked planning</p>
        <h1 style={{ margin: "4px 0", fontSize: 36 }}>Otayori Route</h1>
        <p style={{ margin: 0, maxWidth: 760 }}>
          Turn a long notice into action cards, visible evidence, and unresolved confirmation questions.
        </p>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 0.9fr) minmax(340px, 1.1fr)",
          gap: 18,
          alignItems: "start",
        }}
      >
        <aside style={{ border: "1px solid #d7dde2", borderRadius: 8, padding: 16, background: "#f7f9fb" }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Source notice</h2>
          <p style={{ lineHeight: 1.65 }}>{noticeText}</p>
          <dl data-proof="review-summary" style={{ display: "grid", gap: 8, margin: 0 }}>
            <div>
              <dt style={{ fontWeight: 700 }}>Boundary</dt>
              <dd style={{ margin: 0 }}>Static sample data only. Human review required.</dd>
            </div>
            <div>
              <dt style={{ fontWeight: 700 }}>Review state</dt>
              <dd style={{ margin: 0 }}>
                {readyCount} ready / {followUpCount} follow-up / {actions.length - readyCount - followUpCount} unreviewed
              </dd>
            </div>
          </dl>
        </aside>

        <section style={{ display: "grid", gap: 14 }}>
          <nav aria-label="Action filters" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                style={{
                  border: "1px solid #98a7b3",
                  borderRadius: 6,
                  padding: "8px 12px",
                  background: filter === item.id ? "#1e5f74" : "#ffffff",
                  color: filter === item.id ? "#ffffff" : "#182026",
                  cursor: "pointer",
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div style={{ display: "grid", gap: 10 }}>
            {visibleActions.map((action) => (
              <article
                key={action.id}
                style={{
                  border: action.id === selectedAction.id ? "2px solid #1e5f74" : "1px solid #d7dde2",
                  borderRadius: 8,
                  padding: 14,
                  background: "#ffffff",
                }}
              >
                <button
                  type="button"
                  onClick={() => setSelectedActionId(action.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    border: 0,
                    background: "transparent",
                    padding: 0,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <strong>{action.title}</strong>
                  <p style={{ margin: "6px 0" }}>
                    {action.actor} / {action.dueDate} / {action.confidence} confidence
                  </p>
                </button>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button data-proof="mark-ready" type="button" onClick={() => markAction(action.id, "ready")}>
                    Mark ready
                  </button>
                  <button type="button" onClick={() => markAction(action.id, "follow_up")}>
                    Needs follow-up
                  </button>
                  <span>Current: {reviewMarks[action.id] ?? "unreviewed"}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>

      <section data-proof="selected-evidence" style={{ marginTop: 18, border: "1px solid #d7dde2", borderRadius: 8, padding: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Selected evidence</h2>
        <p>
          <strong>{selectedAction.title}</strong>
        </p>
        <blockquote style={{ borderLeft: "4px solid #1e5f74", margin: 0, paddingLeft: 12 }}>
          {selectedAction.sourceQuote}
        </blockquote>
        <p>Materials: {selectedAction.materials.join(", ")}</p>
        <p>Uncertainty: {selectedAction.uncertainty}</p>
      </section>
    </main>
  );
}
