import { baseTools, createBaseHandlers, runBash } from "./lib/base-tools";
import { callModel, printAssistantText, runSimpleRepl, WORKDIR, type HistoryMessage } from "./lib/runtime";

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

class BackgroundManager {
  tasks = new Map<string, { status: string; result: string | null; command: string }>();
  queue: Array<{ task_id: string; status: string; command: string; result: string }> = [];

  run(command: string) {
    const taskId = Math.random().toString(36).slice(2, 10);
    this.tasks.set(taskId, { status: "running", result: null, command });
    void this.execute(taskId, command);
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  async execute(taskId: string, command: string) {
    let status = "completed";
    let result = await runBash(command, 300_000);
    if (result.startsWith("Error: Timeout")) {
      status = "timeout";
    } else if (result.startsWith("Error:")) {
      status = "error";
    }
    this.tasks.set(taskId, { status, result, command });
    this.queue.push({
      task_id: taskId,
      status,
      command: command.slice(0, 80),
      result: result.slice(0, 500),
    });
  }

  check(taskId?: string) {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) {
        return `Error: Unknown task ${taskId}`;
      }
      return `[${task.status}] ${task.command.slice(0, 60)}\n${task.result ?? "(running)"}`;
    }
    const lines = [...this.tasks.entries()].map(([id, task]) => `${id}: [${task.status}] ${task.command.slice(0, 60)}`);
    return lines.join("\n") || "No background tasks.";
  }

  drainNotifications() {
    const notifications = [...this.queue];
    this.queue = [];
    return notifications;
  }
}

const background = new BackgroundManager();
const TOOLS = [
  ...baseTools,
  {
    name: "background_run",
    description: "Run command in background thread. Returns task_id immediately.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "Check background task status. Omit task_id to list all.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
    },
  },
];

const BASE = createBaseHandlers();

async function executeTool(block: any) {
  if (block.name === "background_run") {
    return background.run(String(block.input.command));
  }
  if (block.name === "check_background") {
    return background.check(block.input.task_id == null ? undefined : String(block.input.task_id));
  }
  const handler = BASE[block.name as keyof typeof BASE];
  return handler ? handler(block.input) : `Unknown tool: ${block.name}`;
}

async function agentLoop(messages: HistoryMessage[]) {
  while (true) {
    const notifications = background.drainNotifications();
    if (notifications.length > 0 && messages.length > 0) {
      const notificationText = notifications
        .map((item) => `[bg:${item.task_id}] ${item.status}: ${item.result}`)
        .join("\n");
      messages.push({
        role: "user",
        content: `<background-results>\n${notificationText}\n</background-results>`,
      });
      messages.push({ role: "assistant", content: "Noted background results." });
    }
    const response = await callModel({ system: SYSTEM, messages, tools: TOOLS });
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
      try {
        output = String(await executeTool(block));
      } catch (error: any) {
        output = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}

await runSimpleRepl({
  prompt: "\u001b[36ms08 >> \u001b[0m",
  onLine: async (_line, history) => {
    await agentLoop(history);
    printAssistantText(history);
  },
});
