import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import dayjs from "dayjs";
import { baseTools, createBaseHandlers } from "./lib/base-tools";
import { callModel, printAssistantText, runSimpleRepl, WORKDIR, type HistoryMessage } from "./lib/runtime";

const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;
const VALID_MSG_TYPES = ["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"] as const;

class MessageBus {
  async init() {
    await mkdir(INBOX_DIR, { recursive: true });
  }

  async send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>) {
    if (!VALID_MSG_TYPES.includes(msgType as any)) {
      return `Error: Invalid type '${msgType}'. Valid: ${VALID_MSG_TYPES.join(", ")}`;
    }
    const payload = {
      type: msgType,
      from: sender,
      content,
      timestamp: dayjs().unix(),
      ...(extra ?? {}),
    };
    await appendFile(path.join(INBOX_DIR, `${to}.jsonl`), `${JSON.stringify(payload)}\n`, "utf8");
    return `Sent ${msgType} to ${to}`;
  }

  async readInbox(name: string) {
    const inboxPath = path.join(INBOX_DIR, `${name}.jsonl`);
    try {
      const text = await readFile(inboxPath, "utf8");
      await writeFile(inboxPath, "", "utf8");
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

  findMember(name: string) {
    return this.config.members.find((member) => member.name === name);
  }

  async spawn(name: string, role: string, prompt: string) {
    const existing = this.findMember(name);
    if (existing) {
      if (!["idle", "shutdown"].includes(existing.status)) {
        return `Error: '${name}' is currently ${existing.status}`;
      }
      existing.status = "working";
      existing.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    await this.save();
    void this.loop(name, role, prompt);
    return `Spawned '${name}' (role: ${role})`;
  }

  async loop(name: string, role: string, prompt: string) {
    const system = `You are '${name}', role: ${role}, at ${WORKDIR}. Use send_message to communicate. Complete your task.`;
    const messages: HistoryMessage[] = [{ role: "user", content: prompt }];
    const tools = [
      ...baseTools,
      {
        name: "send_message",
        description: "Send message to a teammate.",
        input_schema: {
          type: "object",
          properties: {
            to: { type: "string" },
            content: { type: "string" },
            msg_type: { type: "string", enum: [...VALID_MSG_TYPES] },
          },
          required: ["to", "content"],
        },
      },
      { name: "read_inbox", description: "Read and drain your inbox.", input_schema: { type: "object", properties: {} } },
    ];
    const base = createBaseHandlers();
    for (let round = 0; round < 50; round += 1) {
      const inbox = await this.bus.readInbox(name);
      for (const message of inbox) {
        messages.push({ role: "user", content: JSON.stringify(message) });
      }
      let response: any;
      try {
        response = await callModel({ system, messages, tools });
      } catch {
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") {
        break;
      }
      const results = [];
      for (const block of response.content ?? []) {
        if (block.type !== "tool_use") {
          continue;
        }
        let output: string;
        if (block.name === "send_message") {
          output = await this.bus.send(name, String(block.input.to), String(block.input.content), String(block.input.msg_type ?? "message"));
        } else if (block.name === "read_inbox") {
          output = JSON.stringify(await this.bus.readInbox(name), null, 2);
        } else {
          const handler = base[block.name as keyof typeof base];
          output = handler ? String(await handler(block.input)) : `Unknown tool: ${block.name}`;
        }
        console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
      messages.push({ role: "user", content: results });
    }
    const member = this.findMember(name);
    if (member && member.status !== "shutdown") {
      member.status = "idle";
      await this.save();
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

const TOOLS = [
  ...baseTools,
  {
    name: "spawn_teammate",
    description: "Spawn a persistent teammate that runs in its own thread.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } },
      required: ["name", "role", "prompt"],
    },
  },
  { name: "list_teammates", description: "List all teammates with name, role, status.", input_schema: { type: "object", properties: {} } },
  {
    name: "send_message",
    description: "Send a message to a teammate's inbox.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: [...VALID_MSG_TYPES] },
      },
      required: ["to", "content"],
    },
  },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {} } },
  {
    name: "broadcast",
    description: "Send a message to all teammates.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
];

const BASE = createBaseHandlers();

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
  prompt: "\u001b[36ms09 >> \u001b[0m",
  onCommand: async (line) => {
    if (line === "/team") {
      console.log(team.listAll());
      return true;
    }
    if (line === "/inbox") {
      console.log(JSON.stringify(await bus.readInbox("lead"), null, 2));
      return true;
    }
    return false;
  },
  onLine: async (_line, history) => {
    await agentLoop(history);
    printAssistantText(history);
  },
});
