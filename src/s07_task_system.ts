import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { baseTools, createBaseHandlers } from "./lib/base-tools";
import { callModel, printAssistantText, runSimpleRepl, WORKDIR, type HistoryMessage } from "./lib/runtime";

const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

class TaskManager {
  nextId = 1;

  async init() {
    await mkdir(TASKS_DIR, { recursive: true });
    const entries = await this.listFiles();
    const ids = entries
      .map((name) => Number(name.match(/^task_(\d+)\.json$/)?.[1] ?? 0))
      .filter(Boolean);
    this.nextId = (ids.length ? Math.max(...ids) : 0) + 1;
  }

  async listFiles() {
    try {
      return (await import("node:fs/promises")).readdir(TASKS_DIR);
    } catch {
      return [];
    }
  }

  filePath(taskId: number) {
    return path.join(TASKS_DIR, `task_${taskId}.json`);
  }

  async load(taskId: number) {
    const file = this.filePath(taskId);
    const text = await readFile(file, "utf8").catch(() => "");
    if (!text) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(text);
  }

  async save(task: Record<string, any>) {
    await writeFile(this.filePath(Number(task.id)), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }

  async create(subject: string, description = "") {
    const task = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [] as number[],
      blocks: [] as number[],
      owner: "",
    };
    this.nextId += 1;
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async get(taskId: number) {
    return JSON.stringify(await this.load(taskId), null, 2);
  }

  async clearDependency(completedId: number) {
    for (const file of await this.listFiles()) {
      if (!file.startsWith("task_")) {
        continue;
      }
      const task = JSON.parse(await readFile(path.join(TASKS_DIR, file), "utf8"));
      if (Array.isArray(task.blockedBy) && task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((item: number) => item !== completedId);
        await this.save(task);
      }
    }
  }

  async update(taskId: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]) {
    const task = await this.load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
      if (status === "completed") {
        await this.clearDependency(taskId);
      }
    }
    if (addBlockedBy?.length) {
      task.blockedBy = [...new Set([...(task.blockedBy ?? []), ...addBlockedBy])];
    }
    if (addBlocks?.length) {
      task.blocks = [...new Set([...(task.blocks ?? []), ...addBlocks])];
      for (const blockedId of addBlocks) {
        try {
          const blocked = await this.load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            await this.save(blocked);
          }
        } catch {
          continue;
        }
      }
    }
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async listAll() {
    const tasks = [];
    for (const file of (await this.listFiles()).filter((name) => name.startsWith("task_")).sort()) {
      tasks.push(JSON.parse(await readFile(path.join(TASKS_DIR, file), "utf8")));
    }
    if (tasks.length === 0) {
      return "No tasks.";
    }
    return tasks
      .map((task) => {
        const markers: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
        const marker = markers[String(task.status)] ?? "[?]";
        const blocked = task.blockedBy?.length ? ` (blocked by: ${JSON.stringify(task.blockedBy)})` : "";
        return `${marker} #${task.id}: ${task.subject}${blocked}`;
      })
      .join("\n");
  }
}

const tasks = new TaskManager();
await tasks.init();

const TOOLS = [
  ...baseTools,
  {
    name: "task_create",
    description: "Create a new task.",
    input_schema: {
      type: "object",
      properties: { subject: { type: "string" }, description: { type: "string" } },
      required: ["subject"],
    },
  },
  {
    name: "task_update",
    description: "Update a task's status or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        addBlockedBy: { type: "array", items: { type: "integer" } },
        addBlocks: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  { name: "task_list", description: "List all tasks with status summary.", input_schema: { type: "object", properties: {} } },
  {
    name: "task_get",
    description: "Get full details of a task by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
];

const BASE = createBaseHandlers();

async function executeTool(block: any) {
  if (block.name === "task_create") {
    return tasks.create(String(block.input.subject), String(block.input.description ?? ""));
  }
  if (block.name === "task_update") {
    return tasks.update(
      Number(block.input.task_id),
      block.input.status == null ? undefined : String(block.input.status),
      Array.isArray(block.input.addBlockedBy) ? block.input.addBlockedBy.map(Number) : undefined,
      Array.isArray(block.input.addBlocks) ? block.input.addBlocks.map(Number) : undefined,
    );
  }
  if (block.name === "task_list") {
    return tasks.listAll();
  }
  if (block.name === "task_get") {
    return tasks.get(Number(block.input.task_id));
  }
  const handler = BASE[block.name as keyof typeof BASE];
  return handler ? handler(block.input) : `Unknown tool: ${block.name}`;
}

async function agentLoop(messages: HistoryMessage[]) {
  while (true) {
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
  prompt: "\u001b[36ms07 >> \u001b[0m",
  onLine: async (_line, history) => {
    await agentLoop(history);
    printAssistantText(history);
  },
});
