// Common Database Safety Guardrails (Strict Read-Only Enforcement)

const FORBIDDEN_KEYWORDS = [
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\bdrop\b/i,
  /\balter\b/i,
  /\btruncate\b/i,
  /\bcreate\b/i,
  /\breplace\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\bexecute\b/i,
  /\bcopy\b/i,
  /\bcall\b/i,
  /\bdo\b/i,
  /\bvacuum\b/i,
  /\bmerge\b/i,
  /\battach\b/i,
  /\bdetach\b/i,
  /\binto\b\s+outfile/i,
  /\binto\b\s+dumpfile/i,
  /\bload_file\b/i,
  /\bpragma\s+writable_schema\b/i,
];

export function validateReadOnlyQuery(rawQuery: string): {
  valid: boolean;
  error?: string;
  cleanQuery: string;
} {
  const clean = rawQuery.trim();
  if (!clean) {
    return { valid: false, error: "Empty query provided.", cleanQuery: "" };
  }

  // Strip block and line comments to prevent hiding mutations
  const stripped = clean
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ") // MySQL line comment
    .trim();

  // Check forbidden keywords
  for (const pattern of FORBIDDEN_KEYWORDS) {
    if (pattern.test(stripped)) {
      return {
        valid: false,
        error: `Permission Denied: Mutating keyword (${pattern.source}) detected. Only read-only queries (SELECT, WITH, EXPLAIN) are permitted.`,
        cleanQuery: "",
      };
    }
  }

  // Must begin with SELECT, WITH, EXPLAIN, or read-only PRAGMA / SHOW / DESCRIBE
  if (!/^(select|with|explain|show|describe|desc|pragma)\b/i.test(stripped)) {
    return {
      valid: false,
      error:
        "Permission Denied: Query must begin with SELECT, WITH, EXPLAIN, SHOW, or DESCRIBE.",
      cleanQuery: "",
    };
  }

  return { valid: true, cleanQuery: clean };
}
