import assert from "node:assert/strict";
import { parseGeminiResponseJson } from "./llm-pipeline/gemini-response-parser";

const test = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
};

test("parses quoted _OR_ marker leaked inside a JSON string", () => {
  const parsed = parseGeminiResponseJson({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                notes: ['Make critique concrete rather "_OR_" generic.'],
              }).replace('\\"_OR_\\"', '"_OR_"'),
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  }) as { notes: string[] };

  assert.deepEqual(parsed.notes, ["Make critique concrete rather than generic."]);
});

test("preserves ordinary strict JSON", () => {
  const parsed = parseGeminiResponseJson('{"status":"ok","count":2}') as {
    status: string;
    count: number;
  };

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.count, 2);
});

test("repairs escaped commas in nested JSON file content", () => {
  const parsed = parseGeminiResponseJson({
    candidates: [
      {
        content: {
          parts: [
            {
              text: `{
                "files": [
                  {
                    "path": "metadata.json",
                    "content": "{\\"process\\":\\"done\\"\\,  "architecture\\":\\"Next.js\\"}"
                  }
                ]
              }`,
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  }) as { files: Array<{ path: string; content: string }> };

  assert.equal(parsed.files[0]?.path, "metadata.json");
  assert.match(parsed.files[0]?.content ?? "", /"architecture":"Next\.js"/);
});

test("extracts fenced JSON even when explanatory prose surrounds it", () => {
  const parsed = parseGeminiResponseJson({
    candidates: [
      {
        content: {
          parts: [
            {
              text: `Here is the builder plan:

\`\`\`json
{
  "status": "ok",
  "files": [
    { "path": "app/page.tsx", "purpose": "main", "content": "export default function Page() { return <main>Ready</main>; }" }
  ]
}
\`\`\`

The plan above is ready.`,
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  }) as { status: string; files: Array<{ path: string }> };

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.files[0]?.path, "app/page.tsx");
});

test("extracts the first balanced JSON object before trailing commentary braces", () => {
  const parsed = parseGeminiResponseJson({
    candidates: [
      {
        content: {
          parts: [
            {
              text: `{"status":"ok","note":"done"}\n\nSummary: use {placeholder} in docs only.`,
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  }) as { status: string; note: string };

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.note, "done");
});

test("repairs trailing commas before object and array closers", () => {
  const parsed = parseGeminiResponseJson({
    candidates: [
      {
        content: {
          parts: [
            {
              text: `{
                "status": "ok",
                "items": [
                  "first",
                  "second",
                ],
              }`,
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  }) as { status: string; items: string[] };

  assert.deepEqual(parsed.items, ["first", "second"]);
});
