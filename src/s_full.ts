import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import dayjs from "dayjs";
import { baseTools, createBaseHandlers, runBash } from "./lib/base-tools";
import { callModel, extractText, printAssistantText, runSimpleRepl, WORKDIR, type HistoryMessage } from "./lib/runtime";

const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOKEN_THRESHOLD = 100_000;
const POLL_INTERVAL = 5_000;
const IDLE_TIMEOUT = 60_000;
const VALID_MSG_TYPES = ["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"] as const;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TodoManager {
  items: Array<{ content: string; status: string; activeForm: string }> = [];

  update(items: Array<Record<string, unknown>>) {
    let inProgress = 0;
    const next = items.map((item, index) => {
      const content = String(item.content ?? "").trim();
      const status = String(item.status ?? "pending");
      const activeForm = String(item.activeForm ?? "").trim();
      if (!content) {
        throw new Error(`Item ${index}: content required`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${index}: invalid status '${status}'`);
      }
      if (!activeForm) {
        throw new Error(`Item ${index}: activeForm required`);
      }
      if (status === "in_progress") {
        inProgress += 1;
      }
      return { content, status, activeForm };
    });
    if (next.length > 20) {
      throw new Error("Max 20 todos");
    }
    if (inProgress > 1) {
      throw new Error("Only one in_progress allowed");
    }
    this.items = next;
    return this.render();
  }

  render() {
    if (this.items.length === 0) {
      return "No todos.";
    }
    const markers: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    const done = this.items.filter((item) => item.status === "completed").length;
    return `${this.items
      .map((item) => `${markers[item.status] ?? "[?]"} ${item.content}${item.status === "in_progress" ? ` <- ${item.activeForm}` : ""}`)
      .join("\n")}\n\n(${done}/${this.items.length} completed)`;
  }

  hasOpenItems() {
    return this.items.some((item) => item.status !== "completed");
  }
}

class SkillLoader {
  skills = new Map<string, { meta: Record<string, string>; body: string }>();

  async init() {
    const stack = [SKILLS_DIR];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: any[] = [];
      try {
        entries = (await readdir(current, { withFileTypes: true } as any)) as any[];
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name === "SKILL.md") {
          const text = await readFile(fullPath, "utf8");
          const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
          const meta: Record<string, string> = {};
          for (const line of (match?.[1] ?? "").split("\n")) {
            const idx = line.indexOf(":");
            if (idx >= 0) {
              meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            }
          }
          const name = meta.name ?? path.basename(path.dirname(fullPath));
          this.skills.set(name, { meta, body: match?.[2]?.trim() ?? text });
        }
      }
    }
  }

  descriptions() {
    if (this.skills.size === 0) {
      return "(no skills)";
    }
    return [...this.skills.entries()].map(([name, skill]) => `  - ${name}: ${skill.meta.description ?? "-"}`).join("\n");
  }

  load(name: string) {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${[...this.skills.keys()].join(", ")}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

class BackgroundManager {
  tasks = new Map<string, { status: string; command: string; result: string | null }>();
  notifications: Array<{ task_id: string; status: string; result: string }> = [];

  run(command: string, timeout = 120_000) {
    const taskId = randomUUID().slice(0, 8);
    this.tasks.set(taskId, { status: "running", command, result: null });
    void this.execute(taskId, command, timeout);
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  async execute(taskId: string, command: string, timeout: number) {
    const result = await runBash(command, timeout);
    const status = result.startsWith("Error:") ? "error" : "completed";
    this.tasks.set(taskId, { status, command, result });
    this.notifications.push({ task_id: taskId, status, result: result.slice(0, 500) });
  }

  check(taskId?: string) {
    if (taskId) {
      const task = this.tasks.get(taskId);
      return task ? `[${task.status}] ${task.result ?? "(running)"}` : `Unknown: ${taskId}`;
    }
    return [...this.tasks.entries()].map(([id, task]) => `${id}: [${task.status}] ${task.command.slice(0, 60)}`).join("\n") || "No bg tasks.";
  }

  drain() {
    const items = [...this.notifications];
    this.notifications = [];
    return items;
  }
}

class TaskManager {
  nextId = 1;

  async init() {
    await mkdir(TASKS_DIR, { recursive: true });
    const ids = (await readdir(TASKS_DIR))
      .map((name) => Number(name.match(/^task_(\d+)\.json$/)?.[1] ?? 0))
      .filter(Boolean);
    this.nextId = (ids.length ? Math.max(...ids) : 0) + 1;
  }

  filePath(taskId: number) {
    return path.join(TASKS_DIR, `task_${taskId}.json`);
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
    const task = { id: this.nextId, subject, description, status: "pending", owner: null, blockedBy: [], blocks: [] };
    this.nextId += 1;
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async get(taskId: number) {
    return JSON.stringify(await this.load(taskId), null, 2);
  }

  async update(taskId: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]) {
    const task = await this.load(taskId);
    if (status) {
      task.status = status;
      if (status === "completed") {
        for (const file of (await readdir(TASKS_DIR)).filter((name) => name.startsWith("task_"))) {
          const item = JSON.parse(await readFile(path.join(TASKS_DIR, file), "utf8"));
          if (Array.isArray(item.blockedBy) && item.blockedBy.includes(taskId)) {
            item.blockedBy = item.blockedBy.filter((id: number) => id !== taskId);
            await this.save(item);
          }
        }
      }
      if (status === "deleted") {
        await import("node:fs/promises").then(({ unlink }) => unlink(this.filePath(taskId)).catch(() => undefined));
        return `Task ${taskId} deleted`;
      }
    }
    if (addBlockedBy?.length) {
      task.blockedBy = [...new Set([...(task.blockedBy ?? []), ...addBlockedBy])];
    }
    if (addBlocks?.length) {
      task.blocks = [...new Set([...(task.blocks ?? []), ...addBlocks])];
    }
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async listAll() {
    const tasks = [];
    for (const file of (await readdir(TASKS_DIR)).filter((name) => name.startsWith("task_")).sort()) {
      const text = await readFile(path.join(TASKS_DIR, file), "utf8");
      if (!text.trim()) {
        continue;
      }
      tasks.push(JSON.parse(text));
    }
    if (tasks.length === 0) {
      return "No tasks.";
    }
    const markers: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    return tasks
      .map((task) => `${markers[String(task.status)] ?? "[?]"} #${task.id}: ${task.subject}${task.owner ? ` @${task.owner}` : ""}${task.blockedBy?.length ? ` (blocked by: ${JSON.stringify(task.blockedBy)})` : ""}`)
      .join("\n");
  }

  async claim(taskId: number, owner: string) {
    const task = await this.load(taskId);
    task.owner = owner;
    task.status = "in_progress";
    await this.save(task);
    return `Claimed task #${taskId} for ${owner}`;
  }
}

class MessageBus {
  async init() {
    await mkdir(INBOX_DIR, { recursive: true });
  }

  async send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>) {
    await appendFile(
      path.join(INBOX_DIR, `${to}.jsonl`),
      `${JSON.stringify({ type: msgType, from: sender, content, timestamp: dayjs().unix(), ...(extra ?? {}) })}\n`,
      "utf8",
    );
    return `Sent ${msgType} to ${to}`;
  }

  async readInbox(name: string) {
    const file = path.join(INBOX_DIR, `${name}.jsonl`);
    try {
      const text = await readFile(file, "utf8");
      await writeFile(file, "", "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  async broadcast(sender: string, content: string, teammates: string[]) {
    let count = 0;
    for (const teammate of teammates) {
      if (teammate === sender) {
        continue;
      }
      await this.send(sender, teammate, content, "broadcast");
      count += 1;
    }
    return `Broadcast to ${count} teammates`;
  }
}

const shutdownRequests: Record<string, Record<string, any>> = {};
const planRequests: Record<string, Record<string, any>> = {};

class TeammateManager {
  configPath = path.join(TEAM_DIR, "config.json");
  config: { team_name: string; members: Array<{ name: string; role: string; status: string }> } = { team_name: "default", members: [] };

  constructor(private readonly bus: MessageBus, private readonly taskManager: TaskManager) {}

  async init() {
    await mkdir(TEAM_DIR, { recursive: true });
    try {
      this.config = JSON.parse(await readFile(this.configPath, "utf8"));
    } catch {
      await this.save();
    }
  }

  async save() {
    await writeFile(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, "utf8");
  }

  find(name: string) {
    return this.config.members.find((member) => member.name === name);
  }

  async setStatus(name: string, status: string) {
    const member = this.find(name);
    if (member) {
      member.status = status;
      await this.save();
    }
  }

  async spawn(name: string, role: string, prompt: string) {
    const member = this.find(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    await this.save();
    void this.loop(name, role, prompt);
    return `Spawned '${name}' (role: ${role})`;
  }

  async scanUnclaimedTasks() {
    const tasks = [];
    for (const file of (await readdir(TASKS_DIR)).filter((name) => name.startsWith("task_")).sort()) {
      const text = await readFile(path.join(TASKS_DIR, file), "utf8");
      if (!text.trim()) {
        continue;
      }
      const task = JSON.parse(text);
      if (task.status === "pending" && !task.owner && (!task.blockedBy || task.blockedBy.length === 0)) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  async loop(name: string, role: string, prompt: string) {
    const teamName = this.config.team_name;
    const system = `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. Use idle when done with current work. You may auto-claim tasks.`;
    const messages: HistoryMessage[] = [{ role: "user", content: prompt }];
    const tools = [
      ...baseTools,
      { name: "send_message", description: "Send message.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
      { name: "idle", description: "Signal no more work.", input_schema: { type: "object", properties: {} } },
      { name: "claim_task", description: "Claim task by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
    ];
    const base = createBaseHandlers();
    while (true) {
      for (let round = 0; round < 50; round += 1) {
        const inbox = await this.bus.readInbox(name);
        for (const message of inbox) {
          if (message.type === "shutdown_request") {
            await this.setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(message) });
        }
        let response: any;
        try {
          response = await callModel({ system, messages, tools });
        } catch {
          await this.setStatus(name, "shutdown");
          return;
        }
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") {
          break;
        }
        const results = [];
        let idleRequested = false;
        for (const block of response.content ?? []) {
          if (block.type !== "tool_use") {
            continue;
          }
          let output: string;
          if (block.name === "idle") {
            idleRequested = true;
            output = "Entering idle phase.";
          } else if (block.name === "claim_task") {
            output = await this.taskManager.claim(Number(block.input.task_id), name);
          } else if (block.name === "send_message") {
            output = await this.bus.send(name, String(block.input.to), String(block.input.content));
          } else {
            const handler = base[block.name as keyof typeof base];
            output = handler ? String(await handler(block.input)) : "Unknown";
          }
          console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
          results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        }
        messages.push({ role: "user", content: results });
        if (idleRequested) {
          break;
        }
      }
      await this.setStatus(name, "idle");
      let resume = false;
      for (let index = 0; index < Math.floor(IDLE_TIMEOUT / POLL_INTERVAL); index += 1) {
        await sleep(POLL_INTERVAL);
        const inbox = await this.bus.readInbox(name);
        if (inbox.length > 0) {
          for (const message of inbox) {
            messages.push({ role: "user", content: JSON.stringify(message) });
          }
          resume = true;
          break;
        }
        const unclaimed = await this.scanUnclaimedTasks();
        if (unclaimed.length > 0) {
          const task = unclaimed[0];
          await this.taskManager.claim(Number(task.id), name);
          if (messages.length <= 3) {
            messages.unshift({ role: "assistant", content: `I am ${name}. Continuing.` });
            messages.unshift({ role: "user", content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>` });
          }
          messages.push({ role: "user", content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description ?? ""}</auto-claimed>` });
          messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });
          resume = true;
          break;
        }
      }
      if (!resume) {
        await this.setStatus(name, "shutdown");
        return;
      }
      await this.setStatus(name, "working");
    }
  }

  listAll() {
    if (this.config.members.length === 0) {
      return "No teammates.";
    }
    return [`Team: ${this.config.team_name}`, ...this.config.members.map((member) => `  ${member.name} (${member.role}): ${member.status}`)].join("\n");
  }

  memberNames() {
    return this.config.members.map((member) => member.name);
  }
}

const TODO = new TodoManager();
const SKILLS = new SkillLoader();
await SKILLS.init();
const TASK_MGR = new TaskManager();
await TASK_MGR.init();
const BG = new BackgroundManager();
const BUS = new MessageBus();
await BUS.init();
const TEAM = new TeammateManager(BUS, TASK_MGR);
await TEAM.init();
const BASE = createBaseHandlers();

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${SKILLS.descriptions()}`;

async function runSubagent(prompt: string, agentType = "Explore") {
  const tools =
    agentType === "Explore"
      ? baseTools.filter((tool) => tool.name === "bash" || tool.name === "read_file")
      : [...baseTools];
  const messages: HistoryMessage[] = [{ role: "user", content: prompt }];
  let response: any = null;
  for (let index = 0; index < 30; index += 1) {
    response = await callModel({ messages, tools });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      break;
    }
    const results = [];
    for (const block of response.content ?? []) {
      if (block.type !== "tool_use") {
        continue;
      }
      const handler = BASE[block.name as keyof typeof BASE];
      const output = handler ? String(await handler(block.input)) : "Unknown tool";
      results.push({ type: "tool_result", tool_use_id: block.id, content: output.slice(0, 50000) });
    }
    messages.push({ role: "user", content: results });
  }
  return extractText(response?.content) || `(subagent ${agentType} produced no summary)`;
}

function estimateTokens(messages: HistoryMessage[]) {
  return JSON.stringify(messages).length / 4;
}

function microCompact(messages: HistoryMessage[]) {
  const results: Array<{ type: "tool_result"; content?: unknown }> = [];
  for (const message of messages) {
    if (message.role === "user" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "tool_result") {
          results.push(part as { type: "tool_result"; content?: unknown });
        }
      }
    }
  }
  for (const part of results.slice(0, -3)) {
    if (typeof part.content === "string" && part.content.length > 100) {
      part.content = "[cleared]";
    }
  }
}

async function autoCompact(messages: HistoryMessage[]) {
  await mkdir(TRANSCRIPT_DIR, { recursive: true });
  const transcript = path.join(TRANSCRIPT_DIR, `transcript_${dayjs().format("YYYYMMDD_HHmmss")}.jsonl`);
  await writeFile(transcript, `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`, "utf8");
  const response = await callModel({
    messages: [{ role: "user", content: `Summarize for continuity:\n${JSON.stringify(messages).slice(0, 80_000)}` }],
    maxTokens: 2000,
  });
  const summary = (response.content?.[0] as any)?.text ?? "";
  return [
    { role: "user" as const, content: `[Compressed. Transcript: ${transcript}]\n${summary}` },
    { role: "assistant" as const, content: "Understood. Continuing with summary context." },
  ];
}

async function handleShutdownRequest(teammate: string) {
  const requestId = randomUUID().slice(0, 8);
  shutdownRequests[requestId] = { target: teammate, status: "pending" };
  await BUS.send("lead", teammate, "Please shut down.", "shutdown_request", { request_id: requestId });
  return `Shutdown request ${requestId} sent to '${teammate}'`;
}

async function handlePlanReview(requestId: string, approve: boolean, feedback = "") {
  const request = planRequests[requestId];
  if (!request) {
    return `Error: Unknown plan request_id '${requestId}'`;
  }
  request.status = approve ? "approved" : "rejected";
  await BUS.send("lead", String(request.from), feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${request.status} for '${request.from}'`;
}

const TOOLS = [
  ...baseTools,
  {
    name: "TodoWrite",
    description: "Update task tracking list.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              activeForm: { type: "string" },
            },
            required: ["content", "status", "activeForm"],
          },
        },
      },
      required: ["items"],
    },
  },
  { name: "task", description: "Spawn a subagent for isolated exploration or work.", input_schema: { type: "object", properties: { prompt: { type: "string" }, agent_type: { type: "string" } }, required: ["prompt"] } },
  { name: "load_skill", description: "Load specialized knowledge by name.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "compress", description: "Manually compress conversation context.", input_schema: { type: "object", properties: {} } },
  { name: "background_run", description: "Run command in background thread.", input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] } },
  { name: "check_background", description: "Check background task status.", input_schema: { type: "object", properties: { task_id: { type: "string" } } } },
  { name: "task_create", description: "Create a persistent file task.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_get", description: "Get task details by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or dependencies.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] }, add_blocked_by: { type: "array", items: { type: "integer" } }, add_blocks: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object", properties: {} } },
  { name: "spawn_teammate", description: "Spawn a persistent autonomous teammate.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object", properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {} } },
  { name: "broadcast", description: "Send message to all teammates.", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "Request a teammate to shut down.", input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "plan_approval", description: "Approve or reject a teammate's plan.", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
  { name: "idle", description: "Enter idle state.", input_schema: { type: "object", properties: {} } },
  { name: "claim_task", description: "Claim a task from the board.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];

async function executeTool(block: any) {
  if (block.name === "TodoWrite") {
    return TODO.update(block.input.items ?? []);
  }
  if (block.name === "task") {
    return runSubagent(String(block.input.prompt), String(block.input.agent_type ?? "Explore"));
  }
  if (block.name === "load_skill") {
    return SKILLS.load(String(block.input.name));
  }
  if (block.name === "compress") {
    return "Compressing...";
  }
  if (block.name === "background_run") {
    return BG.run(String(block.input.command), block.input.timeout == null ? 120_000 : Number(block.input.timeout));
  }
  if (block.name === "check_background") {
    return BG.check(block.input.task_id == null ? undefined : String(block.input.task_id));
  }
  if (block.name === "task_create") {
    return TASK_MGR.create(String(block.input.subject), String(block.input.description ?? ""));
  }
  if (block.name === "task_get") {
    return TASK_MGR.get(Number(block.input.task_id));
  }
  if (block.name === "task_update") {
    return TASK_MGR.update(
      Number(block.input.task_id),
      block.input.status == null ? undefined : String(block.input.status),
      Array.isArray(block.input.add_blocked_by) ? block.input.add_blocked_by.map(Number) : undefined,
      Array.isArray(block.input.add_blocks) ? block.input.add_blocks.map(Number) : undefined,
    );
  }
  if (block.name === "task_list") {
    return TASK_MGR.listAll();
  }
  if (block.name === "spawn_teammate") {
    return TEAM.spawn(String(block.input.name), String(block.input.role), String(block.input.prompt));
  }
  if (block.name === "list_teammates") {
    return TEAM.listAll();
  }
  if (block.name === "send_message") {
    return BUS.send("lead", String(block.input.to), String(block.input.content), String(block.input.msg_type ?? "message"));
  }
  if (block.name === "read_inbox") {
    return JSON.stringify(await BUS.readInbox("lead"), null, 2);
  }
  if (block.name === "broadcast") {
    return BUS.broadcast("lead", String(block.input.content), TEAM.memberNames());
  }
  if (block.name === "shutdown_request") {
    return handleShutdownRequest(String(block.input.teammate));
  }
  if (block.name === "plan_approval") {
    return handlePlanReview(String(block.input.request_id), Boolean(block.input.approve), String(block.input.feedback ?? ""));
  }
  if (block.name === "idle") {
    return "Lead does not idle.";
  }
  if (block.name === "claim_task") {
    return TASK_MGR.claim(Number(block.input.task_id), "lead");
  }
  const handler = BASE[block.name as keyof typeof BASE];
  return handler ? handler(block.input) : `Unknown tool: ${block.name}`;
}

async function agentLoop(messages: HistoryMessage[]) {
  let roundsWithoutTodo = 0;
  while (true) {
    microCompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[auto-compact triggered]");
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }
    const notifications = BG.drain();
    if (notifications.length > 0) {
      messages.push({ role: "user", content: `<background-results>\n${notifications.map((item) => `[bg:${item.task_id}] ${item.status}: ${item.result}`).join("\n")}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }
    const inbox = await BUS.readInbox("lead");
    if (inbox.length > 0) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }
    const response = await callModel({ system: SYSTEM, messages, tools: TOOLS });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }
    const results = [];
    let usedTodo = false;
    let manualCompress = false;
    for (const block of response.content ?? []) {
      if (block.type !== "tool_use") {
        continue;
      }
      if (block.name === "compress") {
        manualCompress = true;
      }
      let output: string;
      try {
        output = String(await executeTool(block));
      } catch (error: any) {
        output = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      if (block.name === "TodoWrite") {
        usedTodo = true;
      }
    }
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }
    messages.push({ role: "user", content: results });
    if (manualCompress) {
      console.log("[manual compact]");
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }
  }
}

await runSimpleRepl({
  prompt: "\u001b[36ms_full >> \u001b[0m",
  onCommand: async (line, history) => {
    if (line === "/compact") {
      if (history.length > 0) {
        console.log("[manual compact via /compact]");
        history.splice(0, history.length, ...(await autoCompact(history)));
      }
      return true;
    }
    if (line === "/tasks") {
      console.log(await TASK_MGR.listAll());
      return true;
    }
    if (line === "/team") {
      console.log(TEAM.listAll());
      return true;
    }
    if (line === "/inbox") {
      console.log(JSON.stringify(await BUS.readInbox("lead"), null, 2));
      return true;
    }
    return false;
  },
  onLine: async (_line, history) => {
    await agentLoop(history);
    printAssistantText(history);
  },
});
