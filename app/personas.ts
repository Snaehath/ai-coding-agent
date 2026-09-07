import fs from "node:fs";
import path from "node:path";

export const PERSONAS_DIR = path.resolve(process.cwd(), ".agents", "personas");

export interface AgentPersona {
  id: string;
  name: string;
  aliases?: string[];
  description: string;
  tone?: string;
  systemPrompt: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

// Built-in fallback personas if directory is empty
const BUILTIN_PERSONAS: AgentPersona[] = [
  {
    id: "dba",
    name: "Principal Database Architect",
    aliases: ["database", "db", "sql"],
    description: "Expert in relational databases, indexing strategy, query plans, and schema optimization.",
    tone: "Direct, performance-critical, analytical",
    systemPrompt: `You are a Principal Database Architect with 20+ years of high-scale OLTP & OLAP experience.
When solving database and SQL problems:
1. Execution Plans First: Always analyze query cost, index selectivity (B-Tree, GIN, composite), and avoid sequential table scans.
2. In-Engine Aggregation: Compute SUM, COUNT, and GROUP BY on the database side instead of pulling raw row sets into memory.
3. Safety & Transactions: Never suggest unindexed UPDATE/DELETE statements. Check transaction boundaries and lock contention.
4. Schema Integrity: Propose foreign key cascades, unique constraints, and appropriate data types.
5. Be direct, authoritative, and concise. Omit conversational filler.`,
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Tree",
      "Find",
      "ToolSearch",
      "ToolsAvailable",
    ],
  },
];

// Load all personas from .agents/personas/*.json
export function loadAllPersonas(): AgentPersona[] {
  const personas: AgentPersona[] = [...BUILTIN_PERSONAS];
  const registeredIds = new Set(personas.map((p) => p.id.toLowerCase()));

  if (fs.existsSync(PERSONAS_DIR)) {
    const files = fs.readdirSync(PERSONAS_DIR);
    for (const f of files) {
      if (f.endsWith(".json")) {
        try {
          const content = fs.readFileSync(path.join(PERSONAS_DIR, f), "utf-8");
          const parsed = JSON.parse(content) as AgentPersona;
          if (parsed && parsed.id && parsed.name && parsed.systemPrompt) {
            const lowerId = parsed.id.toLowerCase();
            if (registeredIds.has(lowerId)) {
              // Override builtin with custom file definition
              const idx = personas.findIndex((p) => p.id.toLowerCase() === lowerId);
              if (idx !== -1) personas[idx] = parsed;
            } else {
              personas.push(parsed);
              registeredIds.add(lowerId);
            }
          }
        } catch {
          // Ignore malformed persona file
        }
      }
    }
  }

  return personas;
}

// Resolve persona by id or alias
export function resolvePersona(idOrAlias?: string): AgentPersona | null {
  if (!idOrAlias) return null;
  const target = idOrAlias.toLowerCase().trim();
  const all = loadAllPersonas();

  for (const p of all) {
    if (p.id.toLowerCase() === target) return p;
    if (p.aliases?.some((a) => a.toLowerCase() === target)) return p;
    if (p.name.toLowerCase().includes(target)) return p;
  }

  return null;
}
