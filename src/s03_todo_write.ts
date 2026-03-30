import { baseTools, createBaseHandlers } from "./lib/base-tools";
import { callModel, printAssistantText, runSimpleRepl, WORKDIR, type HistoryMessage } from "./lib/runtime";

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

class TodoManager {
  items: Array<{ id: string; text: string; status: "pending" | "in_progress" | "completed" }> = [];

  update(items: Array<Record<string, unknown>>) {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }
    let inProgressCount = 0;
    this.items = items.map((item, index) => {
      const id = String(item.id ?? index + 1);
      const text = String(item.text ?? "").trim();
      const status = String(item.status ?? "pending") as "pending" | "in_progress" | "completed";
      if (!text) {
        throw new Error(`Item ${id}: text required`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }
      if (status === "in_progress") {
        inProgressCount += 1;
      }
      return { id, text, status };
    });
    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }
    return this.render();
  }

  render() {
    if (this.items.length === 0) {
      return "No todos.";
    }
    const done = this.items.filter((item) => item.status === "completed").length;
    return `${this.items
      .map((item) => `${{ pending: "[ ]", in_progress: "[>]", completed: "[x]" }[item.status]} #${item.id}: ${item.text}`)
      .join("\n")}\n\n(${done}/${this.items.length} completed)`;
  }
}

const TODO = new TodoManager();
const TOOLS = [
  ...baseTools,
  {
    name: "todo",
    description: "Update task list. Track progress on multi-step tasks.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
];

const BASE = createBaseHandlers();

async function executeTool(block: any) {
  if (block.name === "todo") {
    return TODO.update(block.input.items ?? []);
  }
  const handler = BASE[block.name as keyof typeof BASE];
  return handler ? handler(block.input) : `Unknown tool: ${block.name}`;
}

async function agentLoop(messages: HistoryMessage[]) {
  let roundsSinceTodo = 0;
  while (true) {
    const response = await callModel({ system: SYSTEM, messages, tools: TOOLS });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }
    const results = [];
    let usedTodo = false;
    for (const block of response.content ?? []) {
      if (block.type !== "tool_use") {
        continue;
      }
      let output: string;
      try {
        output = String(await executeTool(block));
      } catch (error: any) {
        output = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      if (block.name === "todo") {
        usedTodo = true;
      }
    }
    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }
    messages.push({ role: "user", content: results });
  }
}

await runSimpleRepl({
  prompt: "\u001b[36ms03 >> \u001b[0m",
  onLine: async (_line, history) => {
    await agentLoop(history);
    printAssistantText(history);
  },
});
