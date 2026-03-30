import { bashTool, runBash } from "./lib/base-tools";
import { callModel, printAssistantText, runSimpleRepl, WORKDIR, type HistoryMessage } from "./lib/runtime";

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use bash to solve tasks. Act, don't explain.`;
const TOOLS = [bashTool];

async function agentLoop(messages: HistoryMessage[]) {
  while (true) {
    const response = await callModel({ system: SYSTEM, messages, tools: TOOLS });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }
    const results = [];
    for (const block of response.content ?? []) {
      if (block.type === "tool_use") {
        const input = block.input as { command?: string };
        console.log(`\u001b[33m$ ${input.command ?? ""}\u001b[0m`);
        const output = await runBash(String(input.command ?? ""));
        console.log(output.slice(0, 200));
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

await runSimpleRepl({
  prompt: "\u001b[36ms01 >> \u001b[0m",
  onLine: async (_line, history) => {
    await agentLoop(history);
    printAssistantText(history);
  },
});
