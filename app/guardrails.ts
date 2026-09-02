import path from "node:path";
import os from "node:os";

// Patterns for dangerous or destructive shell commands
const DANGEROUS_COMMAND_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  // Destructive file deletion
  {
    regex:
      /\b(rm\s+-[rf]{1,2}\s+[\\/~]|\bdel\s+[\/\\][sfq]\s+[A-Za-z]:[\\\/]|rmdir\s+[\/\\][sq]\s+[A-Za-z]:[\\\/])/i,
    reason: "Attempted recursive deletion of root or system drive.",
  },
  {
    regex: /\b(format\s+[A-Za-z]:|mkfs(\.[a-z0-9]+)?\s+)/i,
    reason: "Attempted disk formatting command.",
  },
  // Fork bombs & resource exhaustion
  {
    regex: /(:(){ :\|:& };:|%\s*0\s*\|\s*%\s*0)/,
    reason: "Fork bomb or denial-of-service command detected.",
  },
  // System shutdown / reboot
  {
    regex: /\b(shutdown(\.exe)?\s+[\/\-][sr]|reboot|init\s+0|halt|poweroff)\b/i,
    reason: "System shutdown or reboot command blocked.",
  },
  // Windows registry wiping
  {
    regex: /\b(reg\s+delete\s+HKEY_LOCAL_MACHINE\\SYSTEM|reg\s+delete\s+HKLM)/i,
    reason: "Attempted modification/deletion of critical Windows Registry keys.",
  },
];

// Sensitive path blocks (system keys, cloud credentials, root directories)
const SENSITIVE_PATH_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /[\\/]\.ssh[\\/](id_rsa|id_ecdsa|id_ed25519|known_hosts)/i,
    reason: "Access to private SSH keys is blocked for security.",
  },
  {
    regex: /[\\/]\.aws[\\/](credentials|config)/i,
    reason: "Access to AWS cloud credentials is blocked for security.",
  },
  {
    regex: /^[A-Za-z]:\\(?:Windows|Windows\\System32|Boot|pagefile\.sys)/i,
    reason: "Access to Windows System directory is blocked.",
  },
  {
    regex: /^\/(?:etc\/(?:passwd|shadow|sudoers)|boot|proc|sys)\b/i,
    reason: "Access to critical Unix root directories is blocked.",
  },
];

// Secret patterns for redaction (API keys, tokens, private keys)
const SECRET_PATTERNS: RegExp[] = [
  /sk-(?:ant|or|proj|live)?[a-zA-Z0-9_\-]{20,}/g, // OpenAI, Anthropic, OpenRouter keys
  /gh[pousr]_[A-Za-z0-9_]{36,}/g, // GitHub tokens
  /AKIA[0-9A-Z]{16}/g, // AWS Access Key ID
  /-----BEGIN\s+(?:RSA|OPENSSH|EC|DSA)?\s*PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA|OPENSSH|EC|DSA)?\s*PRIVATE\s+KEY-----/g,
];

// Check if a file path is safe to access
export function validatePathSafety(filePath: string): {
  safe: boolean;
  reason?: string;
} {
  if (!filePath) return { safe: true };

  const normalized = path.normalize(filePath);

  for (const p of SENSITIVE_PATH_PATTERNS) {
    if (p.regex.test(normalized)) {
      return { safe: false, reason: p.reason };
    }
  }

  return { safe: true };
}

// Check if a bash command is safe to execute
export function validateCommandSafety(command: string): {
  safe: boolean;
  reason?: string;
} {
  if (!command) return { safe: true };

  const trimmed = command.trim();

  // Check destructive command patterns
  for (const p of DANGEROUS_COMMAND_PATTERNS) {
    if (p.regex.test(trimmed)) {
      return { safe: false, reason: p.reason };
    }
  }

  // Check commands targeting sensitive keys / credentials
  for (const sp of SENSITIVE_PATH_PATTERNS) {
    if (sp.regex.test(trimmed)) {
      return {
        safe: false,
        reason: `Command attempts to access protected resource. ${sp.reason}`,
      };
    }
  }

  return { safe: true };
}

// Redact API keys and private tokens from logs & responses
export function sanitizeSecrets(text: string): string {
  if (!text) return "";
  let sanitized = text;

  for (const pat of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pat, "[REDACTED_SECRET]");
  }

  // Also redact current OPENROUTER_API_KEY if present in text
  const currentKey = process.env.OPENROUTER_API_KEY;
  if (currentKey && currentKey.length > 8) {
    sanitized = sanitized.replaceAll(currentKey, "[REDACTED_API_KEY]");
  }

  return sanitized;
}

// Loop detector to prevent runaway agent loops
export function createToolLoopDetector(maxRepeatThreshold: number = 3) {
  let lastSignature = "";
  let repeatCount = 0;

  return {
    check(toolName: string, args: Record<string, any>): {
      isLooping: boolean;
      repeatCount: number;
    } {
      const signature = `${toolName}:${JSON.stringify(args)}`;
      if (signature === lastSignature) {
        repeatCount++;
      } else {
        lastSignature = signature;
        repeatCount = 1;
      }

      return {
        isLooping: repeatCount >= maxRepeatThreshold,
        repeatCount,
      };
    },
    reset() {
      lastSignature = "";
      repeatCount = 0;
    },
  };
}
