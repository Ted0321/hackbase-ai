import "./load-local-env";

const required = ["OPENAI_API_KEY"] as const;
const optional = {
  OPENAI_MODEL: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
};

const missing = required.filter((key) => !process.env[key]);

console.log("LLM planner readiness");
console.log(`OPENAI_MODEL: ${optional.OPENAI_MODEL}`);
console.log(`OPENAI_API_KEY: ${missing.includes("OPENAI_API_KEY") ? "missing" : "set"}`);

if (missing.length > 0) {
  console.log("Status: dry-run only. plan:signals:llm will write a prompt and skip API execution.");
  process.exitCode = 0;
} else {
  console.log("Status: ready. pipeline:signals -- --planner llm can materialize an LLM planning run.");
}
