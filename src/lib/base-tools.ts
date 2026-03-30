import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { type ToolDefinition, WORKDIR } from "./runtime";

const DANGEROUS_SNIPPETS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

export type BashToolInput = {
  command: string;
};

export type ReadFileToolInput = {
  path: string;
  limit?: number;
};

export type WriteFileToolInput = {
  path: string;
  content: string;
};

export type EditFileToolInput = {
  path: string;
  old_text: string;
  new_text: string;
};

export type BaseToolInputByName = {
  bash: BashToolInput;
  read_file: ReadFileToolInput;
  write_file: WriteFileToolInput;
  edit_file: EditFileToolInput;
};

export type BaseToolHandlers = {
  [K in keyof BaseToolInputByName]: (input: unknown) => Promise<string>;
};

function getErrorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "timedOut" in error && error.timedOut) {
    return "timeout";
  }
  return error instanceof Error ? error.message : String(error);
}

// 将用户传入路径解析到工作区内，并拒绝 ../.. 这类越界路径。
export function safePath(target: string) {
  const resolved = path.resolve(WORKDIR, target);
  const relative = path.relative(WORKDIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${target}`);
  }
  return resolved;
}

export function truncate(text: string, limit = 50000) {
  return text.length > limit ? text.slice(0, limit) : text;
}

// 统一封装 shell 执行，让超时、输出裁剪和基础危险命令拦截
// 在所有 session 中保持一致行为。
export async function runBash(command: string, timeout = 120_000, cwd = WORKDIR) {
  if (DANGEROUS_SNIPPETS.some((snippet) => command.includes(snippet))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const result = await execa(command, {
      shell: true,
      cwd,
      timeout,
      reject: false,
    });
    const combined = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    return truncate(combined || "(no output)");
  } catch (error: unknown) {
    if (getErrorMessage(error) === "timeout") {
      return `Error: Timeout (${Math.floor(timeout / 1000)}s)`;
    }
    return `Error: ${getErrorMessage(error)}`;
  }
}

export async function runRead(target: string, limit?: number) {
  try {
    const text = await readFile(safePath(target), "utf8");
    const lines = text.split(/\r?\n/);
    const clipped =
      limit && limit < lines.length
        ? [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`]
        : lines;
    return truncate(clipped.join("\n"));
  } catch (error: unknown) {
    return `Error: ${getErrorMessage(error)}`;
  }
}

export async function runWrite(target: string, content: string) {
  try {
    const fullPath = safePath(target);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    return `Wrote ${content.length} bytes${target ? ` to ${target}` : ""}`;
  } catch (error: unknown) {
    return `Error: ${getErrorMessage(error)}`;
  }
}

export async function runEdit(target: string, oldText: string, newText: string) {
  try {
    const fullPath = safePath(target);
    const current = await readFile(fullPath, "utf8");
    if (!current.includes(oldText)) {
      return `Error: Text not found in ${target}`;
    }
    await writeFile(fullPath, current.replace(oldText, newText), "utf8");
    return `Edited ${target}`;
  } catch (error: unknown) {
    return `Error: ${getErrorMessage(error)}`;
  }
}

export const bashTool: ToolDefinition = {
  name: "bash",
  description: "Run a shell command.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string" },
    },
    required: ["command"],
  },
};

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read file contents.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer" },
    },
    required: ["path"],
  },
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "Write content to file.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
};

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description: "Replace exact text in file.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" },
    },
    required: ["path", "old_text", "new_text"],
  },
};

export const baseTools = [bashTool, readFileTool, writeFileTool, editFileTool];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 在工具调用边界把 unknown 输入解析成强类型，避免后续实现里到处散落运行时校验。
function parseBashInput(input: unknown): BashToolInput {
  if (!isObject(input) || typeof input.command !== "string") {
    throw new Error("Invalid bash input");
  }
  return { command: input.command };
}

function parseReadFileInput(input: unknown): ReadFileToolInput {
  if (!isObject(input) || typeof input.path !== "string") {
    throw new Error("Invalid read_file input");
  }
  return {
    path: input.path,
    limit: typeof input.limit === "number" ? input.limit : undefined,
  };
}

function parseWriteFileInput(input: unknown): WriteFileToolInput {
  if (!isObject(input) || typeof input.path !== "string" || typeof input.content !== "string") {
    throw new Error("Invalid write_file input");
  }
  return { path: input.path, content: input.content };
}

function parseEditFileInput(input: unknown): EditFileToolInput {
  if (
    !isObject(input) ||
    typeof input.path !== "string" ||
    typeof input.old_text !== "string" ||
    typeof input.new_text !== "string"
  ) {
    throw new Error("Invalid edit_file input");
  }
  return {
    path: input.path,
    old_text: input.old_text,
    new_text: input.new_text,
  };
}

// 各 session 都是按工具名分发，这里把解析器和处理器绑定起来，
// 避免每个教学脚本重复写一遍输入校验。
export function createBaseHandlers(): BaseToolHandlers {
  return {
    bash: async (input) => {
      const parsed = parseBashInput(input);
      return runBash(parsed.command);
    },
    read_file: async (input) => {
      const parsed = parseReadFileInput(input);
      return runRead(parsed.path, parsed.limit);
    },
    write_file: async (input) => {
      const parsed = parseWriteFileInput(input);
      return runWrite(parsed.path, parsed.content);
    },
    edit_file: async (input) => {
      const parsed = parseEditFileInput(input);
      return runEdit(parsed.path, parsed.old_text, parsed.new_text);
    },
  };
}
