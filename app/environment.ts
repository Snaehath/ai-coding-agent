import os from "node:os";
import fs from "node:fs";
import { execSync } from "node:child_process";

export interface GpuInfo {
  name: string;
  totalVramMB: number;
  freeVramMB: number;
  driverVersion?: string;
}

export interface HardwareProfile {
  os: {
    platform: string;
    type: string;
    release: string;
    arch: string;
    hostname: string;
    uptimeSec: number;
  };
  cpu: {
    model: string;
    cores: number;
    speedMHz: number;
  };
  memory: {
    totalGB: number;
    freeGB: number;
    usedGB: number;
    usagePercent: number;
  };
  gpu?: GpuInfo;
  disk: {
    workspaceDrive: string;
    freeGB?: number;
  };
  network: {
    isOnline: boolean;
    primaryIp?: string;
  };
  runtime: {
    name: string;
    version: string;
    nodeVersion: string;
    pid: number;
    memoryRssMB: number;
    memoryHeapMB: number;
  };
  recommendedModelId: string;
  recommendationReason: string;
}

// 1. Detect OS
export function getOsInfo() {
  return {
    platform: process.platform,
    type: os.type(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptimeSec: Math.round(os.uptime()),
  };
}

// 2. Detect CPU
export function getCpuInfo() {
  const cpus = os.cpus();
  return {
    model: cpus[0]?.model || "Unknown CPU",
    cores: cpus.length,
    speedMHz: cpus[0]?.speed || 0,
  };
}

// 3. Detect Memory
export function getMemoryInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalGB: Math.round((total / 1024 / 1024 / 1024) * 10) / 10,
    freeGB: Math.round((free / 1024 / 1024 / 1024) * 10) / 10,
    usedGB: Math.round((used / 1024 / 1024 / 1024) * 10) / 10,
    usagePercent: Math.round((used / total) * 100),
  };
}

// 4. Detect GPU & VRAM (nvidia-smi or Windows WMI)
export function getGpuInfo(): GpuInfo | undefined {
  // Try nvidia-smi first (standard across Windows & Linux with NVIDIA GPUs)
  try {
    const output = execSync(
      "nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader,nounits",
      { stdio: "pipe", timeout: 2000 },
    ).toString().trim();

    if (output) {
      const parts = output.split(",").map((s) => s.trim());
      if (parts.length >= 3) {
        return {
          name: parts[0],
          totalVramMB: parseInt(parts[1], 10) || 0,
          freeVramMB: parseInt(parts[2], 10) || 0,
          driverVersion: parts[3],
        };
      }
    }
  } catch {
    /* nvidia-smi not found or non-nvidia */
  }

  // Fallback for Windows WMI query
  if (process.platform === "win32") {
    try {
      const wmic = execSync(
        "powershell -Command \"Get-CimInstance Win32_VideoController | Select-Object -First 1 Name, AdapterRAM\"",
        { stdio: "pipe", timeout: 2500 },
      ).toString().trim();
      const nameMatch = wmic.match(/Name\s+:\s+(.+)/i);
      const ramMatch = wmic.match(/AdapterRAM\s+:\s+(\d+)/i);
      if (nameMatch) {
        const bytes = ramMatch ? parseInt(ramMatch[1], 10) : 0;
        const mb = bytes > 0 ? Math.round(bytes / 1024 / 1024) : 4096; // fallback estimate
        return {
          name: nameMatch[1].trim(),
          totalVramMB: mb,
          freeVramMB: Math.round(mb * 0.5), // estimated available
        };
      }
    } catch {
      /* wmi unavailable */
    }
  }

  return undefined;
}

// 5. Detect Disk Space
export function getDiskInfo() {
  const cwd = process.cwd();
  const drive = process.platform === "win32" ? cwd.slice(0, 2) : "/";
  return {
    workspaceDrive: drive,
  };
}

// 6. Detect Network
export function getNetworkInfo() {
  const ifaces = os.networkInterfaces();
  let primaryIp: string | undefined;

  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (!iface.internal && iface.family === "IPv4") {
        primaryIp = iface.address;
        break;
      }
    }
    if (primaryIp) break;
  }

  return {
    isOnline: Boolean(primaryIp),
    primaryIp,
  };
}

// 7. Detect Runtime
export function getRuntimeInfo() {
  const mem = process.memoryUsage();
  return {
    name: typeof Bun !== "undefined" ? "Bun" : "Node.js",
    version: typeof Bun !== "undefined" ? Bun.version : process.version,
    nodeVersion: process.version,
    pid: process.pid,
    memoryRssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    memoryHeapMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
  };
}

// 8. Hardware-Aware Model Orchestrator
export function recommendModelForHardware(gpu?: GpuInfo, ramGB?: number): { id: string; reason: string } {
  const freeVramMB = gpu?.freeVramMB || 0;
  const totalVramMB = gpu?.totalVramMB || 0;
  const effectiveVramGB = totalVramMB > 0 ? totalVramMB / 1024 : 0;

  if (effectiveVramGB > 0 && effectiveVramGB <= 4.0) {
    // 4 GB VRAM limitation profile (ideal for 3B - 4B models)
    if (freeVramMB < 1800) {
      return {
        id: "granite",
        reason: `Tight VRAM (${(freeVramMB / 1024).toFixed(1)} GB available on ${gpu?.name || "GPU"}). Granite 4.2 3B is ultra-compact and lightning fast.`,
      };
    }
    return {
      id: "gemma",
      reason: `4 GB VRAM profile (${(effectiveVramGB).toFixed(1)} GB ${gpu?.name || "GPU"}). Gemma 3 Tools 4B provides vision input + tool calling without exceeding VRAM.`,
    };
  }

  if (effectiveVramGB > 4.0 && effectiveVramGB < 8.0) {
    return {
      id: "qwen",
      reason: `Moderate VRAM (${effectiveVramGB.toFixed(1)} GB GPU). Qwen 2.5 Coder 7B gives high coding accuracy.`,
    };
  }

  if (effectiveVramGB >= 8.0) {
    return {
      id: "liquid",
      reason: `High VRAM headroom (${effectiveVramGB.toFixed(1)} GB GPU). Liquid LFM 2.5 8B provides maximum reasoning capacity.`,
    };
  }

  // CPU / RAM fallback
  const sysRam = ramGB || 16;
  if (sysRam >= 16) {
    return {
      id: "qwen",
      reason: `16 GB System RAM. Qwen 2.5 Coder 7B balanced performance.`,
    };
  }

  return {
    id: "granite",
    reason: `Low RAM / CPU execution. Granite 4.2 3B recommended for zero lag.`,
  };
}

// Comprehensive Hardware & Environment Snapshot
export function getFullHardwareProfile(): HardwareProfile {
  const osInfo = getOsInfo();
  const cpu = getCpuInfo();
  const memory = getMemoryInfo();
  const gpu = getGpuInfo();
  const disk = getDiskInfo();
  const network = getNetworkInfo();
  const runtime = getRuntimeInfo();

  const rec = recommendModelForHardware(gpu, memory.totalGB);

  return {
    os: osInfo,
    cpu,
    memory,
    gpu,
    disk,
    network,
    runtime,
    recommendedModelId: rec.id,
    recommendationReason: rec.reason,
  };
}

// Render formatted environment report
export function renderEnvironmentReport(): string {
  const p = getFullHardwareProfile();

  const gpuLine = p.gpu
    ? `  • GPU                      : ${p.gpu.name} (${(p.gpu.totalVramMB / 1024).toFixed(1)} GB Total, ${(p.gpu.freeVramMB / 1024).toFixed(1)} GB Available)`
    : "  • GPU                      : Integrated / CPU Only";

  return [
    `🌍 System & Environment Awareness Profile:`,
    `  • Operating System         : ${p.os.type} ${p.os.release} (${p.os.platform} / ${p.os.arch})`,
    `  • CPU                      : ${p.cpu.model} (${p.cpu.cores} logical cores)`,
    `  • System Memory            : ${p.memory.totalGB} GB RAM (${p.memory.freeGB} GB Free, ${p.memory.usagePercent}% used)`,
    gpuLine,
    `  • Runtime                  : ${p.runtime.name} ${p.runtime.version} (PID: ${p.runtime.pid}, RSS: ${p.runtime.memoryRssMB} MB)`,
    `  • Network Status           : ${p.network.isOnline ? `Online (${p.network.primaryIp})` : "Offline"}`,
    `\n💡 Hardware-Aware Model Orchestrator Recommendation:`,
    `  • Recommended Model        : ⚡ ${p.recommendedModelId}`,
    `  • Reason                   : ${p.recommendationReason}`,
  ].join("\n");
}
