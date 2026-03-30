import { baseTools, createBaseHandlers } from "./lib/base-tools";
import { callModel, extractText, printAssistantText, runSimpleRepl, WORKDIR, type HistoryMessage } from "./lib/runtime";

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks.`;
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

const CHILD_TOOLS = [...baseTools];
const PARENT_TOOLS = [
  ...CHILD_TOOLS,
  {
    name: "task",
    description: "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: { type: "string" },
      },
      required: ["prompt"],
    },
  },
];

const BASE = createBaseHandlers();

async function runSubagent(prompt: string) {
  const messages: HistoryMessage[] = [{ role: "user", content: prompt }];
  let finalResponse: any = null;
  for (let index = 0; index < 30; index += 1) {
    finalResponse = await callModel({
      system: SUBAGENT_SYSTEM,
      messages,
      tools: CHILD_TOOLS,
    });
    messages.push({ role: "assistant", content: finalResponse.content });
    if (finalResponse.stop_reason !== "tool_use") {
      break;
    }
    const results = [];
    for (const block of finalResponse.content ?? []) {
      if (block.type !== "tool_use") {
        continue;
      }
      const handler = BASE[block.name as keyof typeof BASE];
      const output = handler ? await handler(block.input) : `Unknown tool: ${block.name}`;
      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output).slice(0, 50000) });
    }
    messages.push({ role: "user", content: results });
  }
  return extractText(finalResponse?.content) || "(no summary)";
}

async function agentLoop(messages: HistoryMessage[]) {
  while (true) {
    const response = await callModel({ system: SYSTEM, messages, tools: PARENT_TOOLS });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }
    const results = [];
    for (const block of response.content ?? []) {
      if (block.type !== "tool_use") {
        continue;
      }
      let output: string;
      if (block.name === "task") {
        const input = block.input as { prompt?: string; description?: string };
        const description = String(input.description ?? "subtask");
        console.log(`> task (${description}): ${String(input.prompt ?? "").slice(0, 80)}`);
        output = await runSubagent(String(input.prompt ?? ""));
      } else {
        const handler = BASE[block.name as keyof typeof BASE];
        output = handler ? String(await handler(block.input)) : `Unknown tool: ${block.name}`;
      }
      console.log(`  ${output.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}

await runSimpleRepl({
  prompt: "\u001b[36ms04 >> \u001b[0m",
  onLine: async (_line, history) => {
    await agentLoop(history);
    printAssistantText(history);
  },
});
