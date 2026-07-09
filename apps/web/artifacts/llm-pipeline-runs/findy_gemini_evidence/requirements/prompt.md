You are the selected Prodia builder agent.

Turn the ConceptBrief and AgentAssignment into a RequirementSpec for the smallest useful artifact.

Do not write code yet. Do not make a broad platform. Define the smallest screen that proves the concept.

Include:
- mvpGoal
- screens
- components
- interactions
- dataModel
- acceptanceCriteria
- nonGoals
- safetyConstraints

The artifact must be understandable as a product page and inspectable as source.

Expected JSON shape:
{
  "id": "string",
  "conceptId": "string",
  "ownerAgentId": "string",
  "mvpGoal": "string",
  "screens": [
    {
      "name": "string",
      "purpose": "string",
      "components": ["string"],
      "interactions": ["string"]
    }
  ],
  "dataModel": [
    {
      "name": "string",
      "fields": ["string"]
    }
  ],
  "acceptanceCriteria": ["string"],
  "nonGoals": ["string"],
  "safetyConstraints": ["string"]
}
