import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages";
import dotenv from "dotenv";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

export const WORKDIR = process.cwd();
export const MODEL = process.env.MODEL_ID ?? "";

if (!MODEL) {
  throw new Error("MODEL_ID is required");
}

export const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

export type JsonObject = Record<string, unknown>;

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolResultBlock = {
  type: "tool_result";
  content: string;
  tool_use_id: string;
};

export type TextResultBlock = {
  type: "text";
  text: string;
};

export type UserContentBlock = {
  type: string;
  [key: string]: unknown;
};

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string | Array<ContentBlock | UserContentBlock>;
};

export type ToolDefinition = {
  name: string;
  description?: string;
  input_schema: {
    type: string;
    properties?: unknown;
    required?: string[];
  };
};

// Anthropic SDK 的消息和工具类型比教学案例实际需要更复杂。
// 这里做一层包装，把应用侧类型保持简单，并把 SDK 类型转换集中在一处。
export async function callModel(params: {
  system?: string;
  messages: HistoryMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
}): Promise<Message> {
  const request: MessageCreateParamsNonStreaming = {
    model: MODEL,
    system: params.system,
    messages: params.messages as MessageParam[],
    tools: params.tools as MessageCreateParamsNonStreaming["tools"],
    max_tokens: params.maxTokens ?? 8000,
  };
  return client.messages.create(request);
}

// assistant 内容里可能同时包含 text、tool_use 等多种 block；
// 这里只提取可读文本，保证 REPL 输出时不会把工具块也当成正文打印。
export function extractText(content: HistoryMessage["content"] | Message["content"] | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.join("");
}

// 基于 readline 的最小 REPL 外壳：显示提示符、读取一行输入、
// 交给 agent loop 处理，再持续下一轮直到用户退出。
export async function runSimpleRepl(params: {
  prompt: string;
  onLine: (line: string, history: HistoryMessage[]) => Promise<void>;
  onCommand?: (line: string, history: HistoryMessage[]) => Promise<boolean>;
}) {
  const rl = createInterface({ input, output });
  const history: HistoryMessage[] = [];
  try {
    while (true) {
      const line = await rl.question(params.prompt);
      const trimmed = line.trim();
      if (!trimmed || trimmed.toLowerCase() === "q" || trimmed.toLowerCase() === "exit") {
        break;
      }
      if (params.onCommand) {
        const handled = await params.onCommand(trimmed, history);
        if (handled) {
          continue;
        }
      }
      history.push({ role: "user", content: line });
      await params.onLine(line, history);
      console.log("");
    }
  } finally {
    rl.close();
  }
}

export function printAssistantText(history: HistoryMessage[]) {
  const last = history.at(-1);
  const text = extractText(last?.content);
  if (text) {
    console.log(text);
  }
}
