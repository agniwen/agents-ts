import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { baseTools, createBaseHandlers } from "./lib/base-tools";
import { callModel, printAssistantText, runSimpleRepl, WORKDIR, type HistoryMessage } from "./lib/runtime";

const SKILLS_DIR = path.join(WORKDIR, "skills");

class SkillLoader {
  skills = new Map<string, { meta: Record<string, string>; body: string; path: string }>();

  async loadAll() {
    try {
      const stack = [SKILLS_DIR];
      while (stack.length > 0) {
        const current = stack.pop()!;
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            stack.push(fullPath);
          } else if (entry.isFile() && entry.name === "SKILL.md") {
            const text = await readFile(fullPath, "utf8");
            const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
            const meta: Record<string, string> = {};
            const body = match ? match[2].trim() : text;
            for (const line of (match?.[1] ?? "").split("\n")) {
              const index = line.indexOf(":");
              if (index >= 0) {
                meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
              }
            }
            const name = meta.name ?? path.basename(path.dirname(fullPath));
            this.skills.set(name, { meta, body, path: fullPath });
          }
        }
      }
    } catch {
      return;
    }
  }

  descriptions() {
    if (this.skills.size === 0) {
      return "(no skills available)";
    }
    return [...this.skills.entries()]
      .map(([name, skill]) => {
        const tags = skill.meta.tags ? ` [${skill.meta.tags}]` : "";
        return `  - ${name}: ${skill.meta.description ?? "No description"}${tags}`;
      })
      .join("\n");
  }

  getContent(name: string) {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${[...this.skills.keys()].join(", ")}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const loader = new SkillLoader();
await loader.loadAll();

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${loader.descriptions()}`;

const TOOLS = [
  ...baseTools,
  {
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
];

const BASE = createBaseHandlers();

async function executeTool(block: any) {
  if (block.name === "load_skill") {
    return loader.getContent(String(block.input.name));
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
  prompt: "\u001b[36ms05 >> \u001b[0m",
  onLine: async (_line, history) => {
    await agentLoop(history);
    printAssistantText(history);
  },
});
