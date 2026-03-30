import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import dayjs from "dayjs";
import { baseTools, createBaseHandlers } from "./lib/base-tools";
import { callModel, printAssistantText, runSimpleRepl, WORKDIR, type HistoryMessage } from "./lib/runtime";

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;
const THRESHOLD = 50_000;
const KEEP_RECENT = 3;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");

function estimateTokens(messages: HistoryMessage[]) {
  return JSON.stringify(messages).length / 4;
}

function microCompact(messages: HistoryMessage[]) {
  const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content?: unknown }> = [];
  const toolNameMap = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          toolNameMap.set(block.id, block.name);
        }
      }
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "tool_result" && typeof part.tool_use_id === "string") {
          toolResults.push(part as { type: "tool_result"; tool_use_id: string; content?: unknown });
        }
      }
    }
  }
  for (const result of toolResults.slice(0, -KEEP_RECENT)) {
    if (typeof result.content === "string" && result.content.length > 100) {
      const toolName = toolNameMap.get(result.tool_use_id) ?? "unknown";
      result.content = `[Previous: used ${toolName}]`;
    }
  }
}

async function autoCompact(messages: HistoryMessage[]) {
  await mkdir(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${dayjs().format("YYYYMMDD_HHmmss")}.jsonl`);
  await writeFile(
    transcriptPath,
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    "utf8",
  );
  console.log(`[transcript saved: ${transcriptPath}]`);
  const conversation = JSON.stringify(messages).slice(0, 80_000);
  const summaryResponse = await callModel({
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: 1) What was accomplished, 2) Current state, 3) Key decisions made. Be concise but preserve critical details.\n\n" +
          conversation,
      },
    ],
    maxTokens: 2000,
  });
  const summary = (summaryResponse.content?.[0] as any)?.text ?? "";
  return [
    {
      role: "user" as const,
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    {
      role: "assistant" as const,
      content: "Understood. I have the context from the summary. Continuing.",
    },
  ];
}

const TOOLS = [
  ...baseTools,
  {
    name: "compact",
    description: "Trigger manual conversation compression.",
    input_schema: {
      type: "object",
      properties: {
        focus: { type: "string" },
      },
    },
  },
];

const BASE = createBaseHandlers();

async function agentLoop(messages: HistoryMessage[]) {
  while (true) {
    microCompact(messages);
    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }
    const response = await callModel({ system: SYSTEM, messages, tools: TOOLS });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }
    const results = [];
    let manualCompact = false;
    for (const block of response.content ?? []) {
      if (block.type !== "tool_use") {
        continue;
      }
      let output: string;
      if (block.name === "compact") {
        manualCompact = true;
        output = "Compressing...";
      } else {
        const handler = BASE[block.name as keyof typeof BASE];
        try {
          output = handler ? String(await handler(block.input)) : `Unknown tool: ${block.name}`;
        } catch (error: any) {
          output = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
    if (manualCompact) {
      console.log("[manual compact]");
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }
  }
}

await runSimpleRepl({
  prompt: "\u001b[36ms06 >> \u001b[0m",
  onLine: async (_line, history) => {
    await agentLoop(history);
    printAssistantText(history);
  },
});
