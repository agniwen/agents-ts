import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import dayjs from "dayjs";
import { execa } from "execa";
import { baseTools, createBaseHandlers, runBash } from "./lib/base-tools";
import { callModel, printAssistantText, runSimpleRepl, WORKDIR, type HistoryMessage } from "./lib/runtime";

async function detectRepoRoot(cwd: string) {
  try {
    const result = await execa("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 10_000,
      reject: false,
    });
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

const REPO_ROOT = (await detectRepoRoot(WORKDIR)) ?? WORKDIR;
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task + worktree tools for multi-task work. For parallel or risky changes: create tasks, allocate worktree lanes, run commands in those lanes, then choose keep/remove for closeout. Use worktree_events when you need lifecycle visibility.`;

class EventBus {
  constructor(private readonly eventLogPath: string) {}

  async init() {
    await mkdir(path.dirname(this.eventLogPath), { recursive: true });
    try {
      await readFile(this.eventLogPath, "utf8");
    } catch {
      await writeFile(this.eventLogPath, "", "utf8");
    }
  }

  async emit(event: string, task: Record<string, any> = {}, worktree: Record<string, any> = {}, error?: string) {
    const payload = { event, ts: dayjs().unix(), task, worktree, ...(error ? { error } : {}) };
    const existing = await readFile(this.eventLogPath, "utf8").catch(() => "");
    await writeFile(this.eventLogPath, `${existing}${JSON.stringify(payload)}\n`, "utf8");
  }

  async listRecent(limit = 20) {
    const lines = (await readFile(this.eventLogPath, "utf8").catch(() => ""))
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, 200)));
    return JSON.stringify(
      lines.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { event: "parse_error", raw: line };
        }
      }),
      null,
      2,
    );
  }
}

class TaskManager {
  dir = path.join(REPO_ROOT, ".tasks");
  nextId = 1;

  async init() {
    await mkdir(this.dir, { recursive: true });
    const ids = (await readdir(this.dir))
      .map((name) => Number(name.match(/^task_(\d+)\.json$/)?.[1] ?? 0))
      .filter(Boolean);
    this.nextId = (ids.length ? Math.max(...ids) : 0) + 1;
  }

  filePath(taskId: number) {
    return path.join(this.dir, `task_${taskId}.json`);
  }

  async exists(taskId: number) {
    try {
      await readFile(this.filePath(taskId), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  async load(taskId: number) {
    const text = await readFile(this.filePath(taskId), "utf8").catch(() => "");
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
      owner: "",
      worktree: "",
      blockedBy: [],
      created_at: dayjs().unix(),
      updated_at: dayjs().unix(),
    };
    this.nextId += 1;
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async get(taskId: number) {
    return JSON.stringify(await this.load(taskId), null, 2);
  }

  async update(taskId: number, status?: string, owner?: string) {
    const task = await this.load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
    }
    if (owner != null) {
      task.owner = owner;
    }
    task.updated_at = dayjs().unix();
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async bindWorktree(taskId: number, worktree: string, owner = "") {
    const task = await this.load(taskId);
    task.worktree = worktree;
    if (owner) {
      task.owner = owner;
    }
    if (task.status === "pending") {
      task.status = "in_progress";
    }
    task.updated_at = dayjs().unix();
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async unbindWorktree(taskId: number) {
    const task = await this.load(taskId);
    task.worktree = "";
    task.updated_at = dayjs().unix();
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async listAll() {
    const tasks = [];
    for (const file of (await readdir(this.dir)).filter((name) => name.startsWith("task_")).sort()) {
      tasks.push(JSON.parse(await readFile(path.join(this.dir, file), "utf8")));
    }
    if (tasks.length === 0) {
      return "No tasks.";
    }
    return tasks
      .map((task) => {
        const markers: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
        const marker = markers[String(task.status)] ?? "[?]";
        const owner = task.owner ? ` owner=${task.owner}` : "";
        const wt = task.worktree ? ` wt=${task.worktree}` : "";
        return `${marker} #${task.id}: ${task.subject}${owner}${wt}`;
      })
      .join("\n");
  }
}

class WorktreeManager {
  dir = path.join(REPO_ROOT, ".worktrees");
  indexPath = path.join(this.dir, "index.json");
  gitAvailable = false;

  constructor(private readonly tasks: TaskManager, private readonly events: EventBus) {}

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      await readFile(this.indexPath, "utf8");
    } catch {
      await writeFile(this.indexPath, `${JSON.stringify({ worktrees: [] }, null, 2)}\n`, "utf8");
    }
    this.gitAvailable = Boolean(await detectRepoRoot(REPO_ROOT));
  }

  async runGit(args: string[]) {
    if (!this.gitAvailable) {
      throw new Error("Not in a git repository. worktree tools require git.");
    }
    const result = await execa("git", args, { cwd: REPO_ROOT, timeout: 120_000, reject: false });
    if (result.exitCode !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`.trim() || `git ${args.join(" ")} failed`);
    }
    return `${result.stdout}\n${result.stderr}`.trim() || "(no output)";
  }

  async loadIndex() {
    return JSON.parse(await readFile(this.indexPath, "utf8"));
  }

  async saveIndex(data: Record<string, any>) {
    await writeFile(this.indexPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  async find(name: string) {
    const index = await this.loadIndex();
    return (index.worktrees ?? []).find((worktree: any) => worktree.name === name);
  }

  validateName(name: string) {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
    }
  }

  async create(name: string, taskId?: number, baseRef = "HEAD") {
    this.validateName(name);
    if (await this.find(name)) {
      throw new Error(`Worktree '${name}' already exists in index`);
    }
    if (taskId != null && !(await this.tasks.exists(taskId))) {
      throw new Error(`Task ${taskId} not found`);
    }
    const worktreePath = path.join(this.dir, name);
    const branch = `wt/${name}`;
    await this.events.emit("worktree.create.before", taskId != null ? { id: taskId } : {}, { name, base_ref: baseRef });
    try {
      await this.runGit(["worktree", "add", "-b", branch, worktreePath, baseRef]);
      const entry = {
        name,
        path: worktreePath,
        branch,
        task_id: taskId,
        status: "active",
        created_at: dayjs().unix(),
      };
      const index = await this.loadIndex();
      index.worktrees.push(entry);
      await this.saveIndex(index);
      if (taskId != null) {
        await this.tasks.bindWorktree(taskId, name);
      }
      await this.events.emit("worktree.create.after", taskId != null ? { id: taskId } : {}, entry);
      return JSON.stringify(entry, null, 2);
    } catch (error: any) {
      await this.events.emit("worktree.create.failed", taskId != null ? { id: taskId } : {}, { name, base_ref: baseRef }, error.message);
      throw error;
    }
  }

  async listAll() {
    const items = (await this.loadIndex()).worktrees ?? [];
    if (items.length === 0) {
      return "No worktrees in index.";
    }
    return items
      .map((item: any) => `[${item.status ?? "unknown"}] ${item.name} -> ${item.path} (${item.branch ?? "-"})${item.task_id ? ` task=${item.task_id}` : ""}`)
      .join("\n");
  }

  async status(name: string) {
    const worktree = await this.find(name);
    if (!worktree) {
      return `Error: Unknown worktree '${name}'`;
    }
    const result = await execa("git", ["status", "--short", "--branch"], {
      cwd: worktree.path,
      timeout: 60_000,
      reject: false,
    });
    return `${result.stdout}\n${result.stderr}`.trim() || "Clean worktree";
  }

  async run(name: string, command: string) {
    const worktree = await this.find(name);
    if (!worktree) {
      return `Error: Unknown worktree '${name}'`;
    }
    return runBash(command, 300_000, worktree.path);
  }

  async keep(name: string) {
    const index = await this.loadIndex();
    let kept: any = null;
    for (const item of index.worktrees ?? []) {
      if (item.name === name) {
        item.status = "kept";
        item.kept_at = dayjs().unix();
        kept = item;
      }
    }
    await this.saveIndex(index);
    await this.events.emit("worktree.keep", kept?.task_id != null ? { id: kept.task_id } : {}, { name, path: kept?.path ?? "", status: "kept" });
    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }

  async remove(name: string, force = false, completeTask = false) {
    const worktree = await this.find(name);
    if (!worktree) {
      return `Error: Unknown worktree '${name}'`;
    }
    await this.events.emit("worktree.remove.before", worktree.task_id != null ? { id: worktree.task_id } : {}, { name, path: worktree.path });
    try {
      await this.runGit(["worktree", "remove", ...(force ? ["--force"] : []), worktree.path]);
      if (completeTask && worktree.task_id != null) {
        const before = JSON.parse(await this.tasks.get(worktree.task_id));
        await this.tasks.update(worktree.task_id, "completed");
        await this.tasks.unbindWorktree(worktree.task_id);
        await this.events.emit("task.completed", { id: worktree.task_id, subject: before.subject, status: "completed" }, { name });
      }
      const index = await this.loadIndex();
      for (const item of index.worktrees ?? []) {
        if (item.name === name) {
          item.status = "removed";
          item.removed_at = dayjs().unix();
        }
      }
      await this.saveIndex(index);
      await this.events.emit("worktree.remove.after", worktree.task_id != null ? { id: worktree.task_id } : {}, { name, path: worktree.path, status: "removed" });
      return `Removed worktree '${name}'`;
    } catch (error: any) {
      await this.events.emit("worktree.remove.failed", worktree.task_id != null ? { id: worktree.task_id } : {}, { name, path: worktree.path }, error.message);
      throw error;
    }
  }
}

const tasks = new TaskManager();
await tasks.init();
const events = new EventBus(path.join(REPO_ROOT, ".worktrees", "events.jsonl"));
await events.init();
const worktrees = new WorktreeManager(tasks, events);
await worktrees.init();
const BASE = createBaseHandlers();

const TOOLS = [
  ...baseTools,
  { name: "task_create", description: "Create a new task on the shared task board.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_list", description: "List all tasks with status, owner, and worktree binding.", input_schema: { type: "object", properties: {} } },
  { name: "task_get", description: "Get task details by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or owner.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, owner: { type: "string" } }, required: ["task_id"] } },
  { name: "task_bind_worktree", description: "Bind a task to a worktree name.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, worktree: { type: "string" }, owner: { type: "string" } }, required: ["task_id", "worktree"] } },
  { name: "worktree_create", description: "Create a git worktree and optionally bind it to a task.", input_schema: { type: "object", properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } }, required: ["name"] } },
  { name: "worktree_list", description: "List worktrees tracked in .worktrees/index.json.", input_schema: { type: "object", properties: {} } },
  { name: "worktree_status", description: "Show git status for one worktree.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_run", description: "Run a shell command in a named worktree directory.", input_schema: { type: "object", properties: { name: { type: "string" }, command: { type: "string" } }, required: ["name", "command"] } },
  { name: "worktree_remove", description: "Remove a worktree and optionally mark its bound task completed.", input_schema: { type: "object", properties: { name: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" } }, required: ["name"] } },
  { name: "worktree_keep", description: "Mark a worktree as kept in lifecycle state without removing it.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_events", description: "List recent worktree/task lifecycle events from .worktrees/events.jsonl.", input_schema: { type: "object", properties: { limit: { type: "integer" } } } },
];

async function executeTool(block: any) {
  if (block.name === "task_create") {
    return tasks.create(String(block.input.subject), String(block.input.description ?? ""));
  }
  if (block.name === "task_list") {
    return tasks.listAll();
  }
  if (block.name === "task_get") {
    return tasks.get(Number(block.input.task_id));
  }
  if (block.name === "task_update") {
    return tasks.update(Number(block.input.task_id), block.input.status == null ? undefined : String(block.input.status), block.input.owner == null ? undefined : String(block.input.owner));
  }
  if (block.name === "task_bind_worktree") {
    return tasks.bindWorktree(Number(block.input.task_id), String(block.input.worktree), String(block.input.owner ?? ""));
  }
  if (block.name === "worktree_create") {
    return worktrees.create(String(block.input.name), block.input.task_id == null ? undefined : Number(block.input.task_id), String(block.input.base_ref ?? "HEAD"));
  }
  if (block.name === "worktree_list") {
    return worktrees.listAll();
  }
  if (block.name === "worktree_status") {
    return worktrees.status(String(block.input.name));
  }
  if (block.name === "worktree_run") {
    return worktrees.run(String(block.input.name), String(block.input.command));
  }
  if (block.name === "worktree_keep") {
    return worktrees.keep(String(block.input.name));
  }
  if (block.name === "worktree_remove") {
    return worktrees.remove(String(block.input.name), Boolean(block.input.force), Boolean(block.input.complete_task));
  }
  if (block.name === "worktree_events") {
    return events.listRecent(block.input.limit == null ? 20 : Number(block.input.limit));
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

console.log(`Repo root for s12: ${REPO_ROOT}`);
if (!worktrees.gitAvailable) {
  console.log("Note: Not in a git repo. worktree_* tools will return errors.");
}

await runSimpleRepl({
  prompt: "\u001b[36ms12 >> \u001b[0m",
  onLine: async (_line, history) => {
    await agentLoop(history);
    printAssistantText(history);
  },
});
