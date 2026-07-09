import React, { useState } from "react";
import { agentRecommendations, consolidatedActions, incidentReport } from "../data/product";

const PRIMARY_ACTION_TITLE = "Identify & Terminate Long-Running Queries";
const SELECTED_ACTION_EVIDENCE = "選択されたアクション: Identify & Terminate Long-Running Queries";
const RECOMMENDED_BY_EVIDENCE = "担当AI: Db Expert, Ops Expert";

interface AgentRecommendationProps {
  recommendation: typeof agentRecommendations[0];
}

const AgentOpinionPanel: React.FC<AgentRecommendationProps> = ({ recommendation }) => (
  <div className="agent-panel">
    <h3 className="agent-role">専門家AI: {recommendation.agentRole}</h3>
    <p>
      <strong>分析:</strong> {recommendation.issueAnalysis}
    </p>
    <p>
      <strong>リスク:</strong> {recommendation.riskAssessment}
    </p>
    <p>
      <strong>解決策:</strong> {recommendation.proposedSolution}
    </p>
    <p className="confidence">確信度: {(recommendation.confidenceScore * 100).toFixed(0)}%</p>
    {recommendation.evidenceUsed && recommendation.evidenceUsed.length > 0 && (
      <p className="evidence">参照: {recommendation.evidenceUsed.join(", ")}</p>
    )}
  </div>
);

interface ConflictingViewsProps {
  recommendations: typeof agentRecommendations;
}

const ConflictingViewsHighlight: React.FC<ConflictingViewsProps> = ({ recommendations }) => {
  const conflictMessages = recommendations.flatMap((rec) =>
    rec.conflictPoints.map((point) => `${rec.agentRole} vs. ${point}`),
  );

  if (conflictMessages.length === 0) return null;

  return (
    <div className="conflicting-views">
      <h4>対立する見解</h4>
      <ul>
        {conflictMessages.map((message, index) => (
          <li key={index}>{message}</li>
        ))}
      </ul>
    </div>
  );
};

interface NextActionSelectorProps {
  onSelectAction: (actionId: string) => void;
  selectedActionId: string | null;
  isApproved: boolean;
}

const NextActionSelector: React.FC<NextActionSelectorProps> = ({
  onSelectAction,
  selectedActionId,
  isApproved,
}) => (
  <div className="next-action-selector">
    <h3>次の一手を選択</h3>
    <div className="action-options">
      {consolidatedActions.map((action) => (
        <button
          key={action.actionId}
          data-proof="select-action"
          className={`action-button ${selectedActionId === action.actionId ? "selected" : ""}`}
          onClick={() => onSelectAction(action.actionId)}
          disabled={isApproved}
          type="button"
        >
          {action.actionTitle}
          <span className={`risk-tag risk-${action.riskLevel.toLowerCase().split(" ")[0]}`}>
            {action.riskLevel}
          </span>
        </button>
      ))}
    </div>
  </div>
);

interface DecisionSummaryProps {
  selectedAction: typeof consolidatedActions[0] | null;
}

const DecisionSummary: React.FC<DecisionSummaryProps> = ({ selectedAction }) => {
  if (!selectedAction) return null;

  const recommendedBy = selectedAction.recommendedByAgents
    .map((agent) =>
      agent
        .split("_")
        .slice(1)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
    )
    .join(", ");
  const selectedActionLabel =
    selectedAction.actionTitle === PRIMARY_ACTION_TITLE
      ? SELECTED_ACTION_EVIDENCE
      : `選択されたアクション: ${selectedAction.actionTitle}`;
  const recommendedByLabel =
    selectedAction.actionTitle === PRIMARY_ACTION_TITLE ? RECOMMENDED_BY_EVIDENCE : `担当AI: ${recommendedBy}`;

  return (
    <div className="decision-summary" data-proof="final-action-display">
      <h2>{selectedActionLabel}</h2>
      <p>{selectedAction.description}</p>
      <p>{recommendedByLabel}</p>
      <p>
        リスクレベル:{" "}
        <span className={`risk-tag risk-${selectedAction.riskLevel.toLowerCase().split(" ")[0]}`}>
          {selectedAction.riskLevel}
        </span>
      </p>
      <p className="approved-status">
        <span data-proof="human-approved-indicator" className="approved-icon">
          Approved by human operator
        </span>
        <br />
        This decision moves the incident response into the next phase.
        <br />
        Final decider: <span data-proof="final-decider">Human Operator</span>
      </p>
    </div>
  );
};

const ProductWorkspace: React.FC = () => {
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [isApproved, setIsApproved] = useState(false);

  const handleSelectAction = (actionId: string) => {
    setSelectedActionId(actionId);
    setIsApproved(true);
  };

  const selectedAction = consolidatedActions.find((action) => action.actionId === selectedActionId) ?? null;

  return (
    <div className="workspace">
      <div className="incident-summary-card">
        <h2 className="incident-title">インシデント: {incidentReport.title}</h2>
        <p className="incident-description">{incidentReport.description}</p>
        <pre className="log-snippet">
          <code>{incidentReport.logSnippet}</code>
        </pre>
        <p>
          <strong>発生時刻:</strong> {new Date(incidentReport.discoveredAt).toLocaleString()}
        </p>
        <p>
          <strong>最終更新:</strong> {new Date(incidentReport.lastUpdatedAt).toLocaleString()}
        </p>
        <p>
          <strong>深刻度:</strong>{" "}
          <span className={`severity-tag severity-${incidentReport.severity.toLowerCase()}`}>
            {incidentReport.severity}
          </span>
        </p>
      </div>

      <div className="agent-opinions-grid">
        {agentRecommendations.map((recommendation) => (
          <AgentOpinionPanel key={recommendation.agentId} recommendation={recommendation} />
        ))}
      </div>

      <ConflictingViewsHighlight recommendations={agentRecommendations} />

      <NextActionSelector
        onSelectAction={handleSelectAction}
        selectedActionId={selectedActionId}
        isApproved={isApproved}
      />

      {isApproved && <DecisionSummary selectedAction={selectedAction} />}
    </div>
  );
};

export default ProductWorkspace;
