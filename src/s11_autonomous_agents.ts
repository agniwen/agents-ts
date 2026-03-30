import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import dayjs from "dayjs";
import { baseTools, createBaseHandlers } from "./lib/base-tools";
import { callModel, printAssistantText, runSimpleRepl, WORKDIR, type HistoryMessage } from "./lib/runtime";

const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SYSTEM = `You are a team lead at ${WORKDIR}. Teammates are autonomous -- they find work themselves.`;
const VALID_MSG_TYPES = ["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"] as const;
const POLL_INTERVAL = 5_000;
const IDLE_TIMEOUT = 60_000;

type Tracker = Record<string, Record<string, any>>;
const shutdownRequests: Tracker = {};
const planRequests: Tracker = {};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MessageBus {
  async init() {
    await mkdir(INBOX_DIR, { recursive: true });
  }

  async send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>) {
    if (!VALID_MSG_TYPES.includes(msgType as (typeof VALID_MSG_TYPES)[number])) {
      return `Error: Invalid type '${msgType}'. Valid: ${VALID_MSG_TYPES.join(", ")}`;
    }
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

async function scanUnclaimedTasks() {
  await mkdir(TASKS_DIR, { recursive: true });
  const unclaimed = [];
  for (const file of (await readdir(TASKS_DIR)).filter((name) => name.startsWith("task_")).sort()) {
    const task = JSON.parse(await readFile(path.join(TASKS_DIR, file), "utf8"));
    if (task.status === "pending" && !task.owner && (!task.blockedBy || task.blockedBy.length === 0)) {
      unclaimed.push(task);
    }
  }
  return unclaimed;
}

async function claimTask(taskId: number, owner: string) {
  const file = path.join(TASKS_DIR, `task_${taskId}.json`);
  try {
    const task = JSON.parse(await readFile(file, "utf8"));
    task.owner = owner;
    task.status = "in_progress";
    await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    return `Claimed task #${taskId} for ${owner}`;
  } catch {
    return `Error: Task ${taskId} not found`;
  }
}

function makeIdentityBlock(name: string, role: string, teamName: string): HistoryMessage {
  return {
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
  };
}

class TeammateManager {
  configPath = path.join(TEAM_DIR, "config.json");
  config: { team_name: string; members: Array<{ name: string; role: string; status: string }> } = {
    team_name: "default",
    members: [],
  };

  constructor(private readonly bus: MessageBus) {}

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

  async loop(name: string, role: string, prompt: string) {
    const teamName = this.config.team_name;
    const system = `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. Use idle tool when you have no more work. You will auto-claim new tasks.`;
    const messages: HistoryMessage[] = [{ role: "user", content: prompt }];
    const base = createBaseHandlers();
    const tools = [
      ...baseTools,
      {
        name: "send_message",
        description: "Send message to a teammate.",
        input_schema: {
          type: "object",
          properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } },
          required: ["to", "content"],
        },
      },
      { name: "read_inbox", description: "Read and drain your inbox.", input_schema: { type: "object", properties: {} } },
      {
        name: "shutdown_response",
        description: "Respond to a shutdown request.",
        input_schema: {
          type: "object",
          properties: { request_id: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } },
          required: ["request_id", "approve"],
        },
      },
      {
        name: "plan_approval",
        description: "Submit a plan for lead approval.",
        input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
      },
      { name: "idle", description: "Signal that you have no more work. Enters idle polling phase.", input_schema: { type: "object", properties: {} } },
      { name: "claim_task", description: "Claim a task from the task board by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
    ];

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
          await this.setStatus(name, "idle");
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
            output = "Entering idle phase. Will poll for new tasks.";
          } else if (block.name === "send_message") {
            output = await this.bus.send(name, String(block.input.to), String(block.input.content), String(block.input.msg_type ?? "message"));
          } else if (block.name === "read_inbox") {
            output = JSON.stringify(await this.bus.readInbox(name), null, 2);
          } else if (block.name === "shutdown_response") {
            const requestId = String(block.input.request_id);
            shutdownRequests[requestId] = {
              ...(shutdownRequests[requestId] ?? {}),
              status: block.input.approve ? "approved" : "rejected",
            };
            await this.bus.send(name, "lead", String(block.input.reason ?? ""), "shutdown_response", {
              request_id: requestId,
              approve: Boolean(block.input.approve),
            });
            output = `Shutdown ${block.input.approve ? "approved" : "rejected"}`;
          } else if (block.name === "plan_approval") {
            const requestId = randomUUID().slice(0, 8);
            planRequests[requestId] = { from: name, plan: String(block.input.plan ?? ""), status: "pending" };
            await this.bus.send(name, "lead", String(block.input.plan ?? ""), "plan_approval_response", {
              request_id: requestId,
              plan: String(block.input.plan ?? ""),
            });
            output = `Plan submitted (request_id=${requestId}). Waiting for approval.`;
          } else if (block.name === "claim_task") {
            output = await claimTask(Number(block.input.task_id), name);
          } else {
            const handler = base[block.name as keyof typeof base];
            output = handler ? String(await handler(block.input)) : `Unknown tool: ${block.name}`;
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
      const polls = Math.floor(IDLE_TIMEOUT / POLL_INTERVAL);
      for (let index = 0; index < polls; index += 1) {
        await sleep(POLL_INTERVAL);
        const inbox = await this.bus.readInbox(name);
        if (inbox.length > 0) {
          for (const message of inbox) {
            if (message.type === "shutdown_request") {
              await this.setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(message) });
          }
          resume = true;
          break;
        }
        const unclaimed = await scanUnclaimedTasks();
        if (unclaimed.length > 0) {
          const task = unclaimed[0];
          await claimTask(Number(task.id), name);
          if (messages.length <= 3) {
            messages.unshift({ role: "assistant", content: `I am ${name}. Continuing.` });
            messages.unshift(makeIdentityBlock(name, role, teamName));
          }
          messages.push({
            role: "user",
            content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description ?? ""}</auto-claimed>`,
          });
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

const bus = new MessageBus();
await bus.init();
const team = new TeammateManager(bus);
await team.init();
const BASE = createBaseHandlers();

async function handleShutdownRequest(teammate: string) {
  const requestId = randomUUID().slice(0, 8);
  shutdownRequests[requestId] = { target: teammate, status: "pending" };
  await bus.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", { request_id: requestId });
  return `Shutdown request ${requestId} sent to '${teammate}'`;
}

async function handlePlanReview(requestId: string, approve: boolean, feedback = "") {
  const request = planRequests[requestId];
  if (!request) {
    return `Error: Unknown plan request_id '${requestId}'`;
  }
  request.status = approve ? "approved" : "rejected";
  await bus.send("lead", String(request.from), feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${request.status} for '${request.from}'`;
}

function checkShutdownStatus(requestId: string) {
  return JSON.stringify(shutdownRequests[requestId] ?? { error: "not found" });
}

const TOOLS = [
  ...baseTools,
  {
    name: "spawn_teammate",
    description: "Spawn an autonomous teammate.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } },
      required: ["name", "role", "prompt"],
    },
  },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object", properties: {} } },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } },
      required: ["to", "content"],
    },
  },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {} } },
  { name: "broadcast", description: "Send a message to all teammates.", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "Request a teammate to shut down.", input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "shutdown_response", description: "Check shutdown request status.", input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] } },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan.",
    input_schema: {
      type: "object",
      properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } },
      required: ["request_id", "approve"],
    },
  },
  { name: "idle", description: "Enter idle state (for lead -- rarely used).", input_schema: { type: "object", properties: {} } },
  { name: "claim_task", description: "Claim a task from the board by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];

async function executeTool(block: any) {
  if (block.name === "spawn_teammate") {
    return team.spawn(String(block.input.name), String(block.input.role), String(block.input.prompt));
  }
  if (block.name === "list_teammates") {
    return team.listAll();
  }
  if (block.name === "send_message") {
    return bus.send("lead", String(block.input.to), String(block.input.content), String(block.input.msg_type ?? "message"));
  }
  if (block.name === "read_inbox") {
    return JSON.stringify(await bus.readInbox("lead"), null, 2);
  }
  if (block.name === "broadcast") {
    return bus.broadcast("lead", String(block.input.content), team.memberNames());
  }
  if (block.name === "shutdown_request") {
    return handleShutdownRequest(String(block.input.teammate));
  }
  if (block.name === "shutdown_response") {
    return checkShutdownStatus(String(block.input.request_id));
  }
  if (block.name === "plan_approval") {
    return handlePlanReview(String(block.input.request_id), Boolean(block.input.approve), String(block.input.feedback ?? ""));
  }
  if (block.name === "idle") {
    return "Lead does not idle.";
  }
  if (block.name === "claim_task") {
    return claimTask(Number(block.input.task_id), "lead");
  }
  const handler = BASE[block.name as keyof typeof BASE];
  return handler ? handler(block.input) : `Unknown tool: ${block.name}`;
}

async function agentLoop(messages: HistoryMessage[]) {
  while (true) {
    const inbox = await bus.readInbox("lead");
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
  prompt: "\u001b[36ms11 >> \u001b[0m",
  onCommand: async (line) => {
    if (line === "/team") {
      console.log(team.listAll());
      return true;
    }
    if (line === "/inbox") {
      console.log(JSON.stringify(await bus.readInbox("lead"), null, 2));
      return true;
    }
    if (line === "/tasks") {
      await mkdir(TASKS_DIR, { recursive: true });
      for (const file of (await readdir(TASKS_DIR)).filter((name) => name.startsWith("task_")).sort()) {
        const task = JSON.parse(await readFile(path.join(TASKS_DIR, file), "utf8"));
        const markers: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
        const marker = markers[String(task.status)] ?? "[?]";
        const owner = task.owner ? ` @${task.owner}` : "";
        console.log(`  ${marker} #${task.id}: ${task.subject}${owner}`);
      }
      return true;
    }
    return false;
  },
  onLine: async (_line, history) => {
    await agentLoop(history);
    printAssistantText(history);
  },
});
