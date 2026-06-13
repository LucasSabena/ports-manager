import { $ } from 'bun';
import { readdir, readFile, readlink, stat } from 'fs/promises';
import * as path from 'path';
import type { DetectedProcess, DockerContainer, DockerContainerStats, LogSource, ProcessStats } from './types';

interface PortMapping {
  pid: number;
  port: number;
  localAddress: string;
}

let clockTickHz = 0;

async function getClockTickHz(): Promise<number> {
  if (clockTickHz) return clockTickHz;
  try {
    const out = await $`getconf CLK_TCK`.text();
    clockTickHz = parseInt(out.trim(), 10) || 100;
  } catch {
    clockTickHz = 100;
  }
  return clockTickHz;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const cpuSamples = new Map<number, { totalTicks: number; time: number }>();

function detectRuntime(cmd: string): DetectedProcess['type'] {
  const lower = cmd.toLowerCase();
  if (lower.includes('bun')) return 'bun';
  if (lower.includes('node') || lower.includes('next') || lower.includes('nuxt') || lower.includes('vite') || lower.includes('react-scripts') || lower.includes('astro')) return 'node';
  if (lower.includes('python') || lower.includes('uvicorn') || lower.includes('fastapi') || lower.includes('flask') || lower.includes('django')) return 'python';
  return 'other';
}

function getProjectName(cwd: string, cmd: string): string {
  // 1. Try to find project name from the cwd
  if (cwd === '/app') {
    return 'app';
  }
  if (cwd && cwd !== '?' && cwd !== (process.env.HOME || '/home/user')) {
    const parts = cwd.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || 'unknown';
    // Avoid generic names; try one level up if needed
    if (!['src', 'app', 'server', 'node_modules', 'bin', 'dist', 'build'].includes(last)) {
      return last;
    }
    if (parts.length > 1) {
      const parent = parts[parts.length - 2];
      if (parent && !['home', 'root', 'opt', 'usr'].includes(parent)) {
        return parent;
      }
    }
  }

  // 2. Try to find project name from script path in command
  const scriptMatch = cmd.match(/\s(\S+\/(?:src|app|server|index)\.[jt]sx?)/);
  if (scriptMatch) {
    const scriptPath = scriptMatch[1];
    const parts = scriptPath.split('/').filter(Boolean);
    for (let i = parts.length - 2; i >= 0; i--) {
      if (!['src', 'app', 'server', 'node_modules', 'bin', 'dist', 'build'].includes(parts[i])) {
        return parts[i];
      }
    }
  }

  // 3. Fallback: use the first meaningful token from command
  const tokens = cmd.split(/\s+/).filter((t) => t && !t.match(/^(node|bun|python|npm|pnpm|yarn|next|nuxt|vite)$/i));
  const token = tokens[0];
  if (token) {
    const parts = token.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'unknown';
  }

  return 'unknown';
}

function hexToIp(hex: string): string {
  if (hex.length === 8) {
    const bytes = hex.match(/.{2}/g)?.map((b) => parseInt(b, 16)).reverse() || [];
    return bytes.join('.');
  }
  // IPv6
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 8) {
    const part = hex.slice(i, i + 8);
    const bytes: string[] = [];
    for (let j = 0; j < 8; j += 2) {
      bytes.unshift(part.slice(j, j + 2));
    }
    groups.push(bytes.join(''));
  }
  return groups.join(':');
}

export async function getListeningPorts(): Promise<PortMapping[]> {
  try {
    const output = await $`ss -tlnp`.text();
    const lines = output.split('\n').slice(1);
    const mappings: PortMapping[] = [];

    for (const line of lines) {
      const match = line.match(/^\s*\S+\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s+.*users:\(\("([^"]+)",pid=(\d+)/);
      if (match) {
        const [, localAddress, portStr, , pidStr] = match;
        mappings.push({
          pid: parseInt(pidStr, 10),
          port: parseInt(portStr, 10),
          localAddress,
        });
      }
    }
    return mappings;
  } catch {
    return [];
  }
}

function parseCmdline(buffer: Buffer): string {
  return buffer.toString('utf-8').replace(/\0/g, ' ').trim();
}

const SENSITIVE_ENV_KEYS = /token|key|secret|password|pass|credential|auth|private|api_key|apikey/i;

function sanitizeEnvValue(key: string, value: string): string {
  return SENSITIVE_ENV_KEYS.test(key) ? '***' : value;
}

export async function getProcessEnv(pid: number): Promise<Record<string, string>> {
  try {
    const buffer = await readFile(`/proc/${pid}/environ`);
    const env: Record<string, string> = {};
    const entries = buffer.toString('utf-8').split('\0');
    for (const entry of entries) {
      if (!entry) continue;
      const idx = entry.indexOf('=');
      if (idx === -1) continue;
      const key = entry.slice(0, idx);
      const value = entry.slice(idx + 1);
      env[key] = sanitizeEnvValue(key, value);
    }
    return env;
  } catch {
    return {};
  }
}

export async function getProcessStats(pid: number): Promise<ProcessStats> {
  try {
    const [statContent, statusContent, uptimeContent] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf-8').catch(() => ''),
      readFile(`/proc/${pid}/status`, 'utf-8').catch(() => ''),
      readFile('/proc/uptime', 'utf-8').catch(() => ''),
    ]);

    let utime = 0;
    let stime = 0;
    let starttime = 0;

    const openParen = statContent.indexOf('(');
    const closeParen = statContent.indexOf(')');
    if (openParen > 0 && closeParen > openParen) {
      const restStr = statContent.slice(closeParen + 2);
      const rest = restStr.split(' ');
      // rest indices: 0=state, 1=ppid, ..., 11=utime(field 14), 12=stime(field 15), 13=cutime, 14=cstime, 15=priority, 16=nice, 17=num_threads(field 20), 18=itrealvalue, 19=starttime(field 22)
      utime = parseInt(rest[11], 10) || 0;
      stime = parseInt(rest[12], 10) || 0;
      starttime = parseInt(rest[19], 10) || 0;
    }

    let memoryMb = 0;
    const rssMatch = statusContent.match(/VmRSS:\s+(\d+)\s+kB/);
    if (rssMatch) {
      memoryMb = Math.round(parseInt(rssMatch[1], 10) / 1024);
    }

    let threads = 0;
    const threadsMatch = statusContent.match(/Threads:\s+(\d+)/);
    if (threadsMatch) {
      threads = parseInt(threadsMatch[1], 10);
    }

    const hz = await getClockTickHz();
    const hostUptime = parseFloat(uptimeContent.split(' ')[0]) || 0;
    const uptimeSeconds = Math.max(0, hostUptime - starttime / hz);

    const totalTicks = utime + stime;
    const now = Date.now();
    let cpuPercent = 0;
    const prev = cpuSamples.get(pid);
    if (prev) {
      const deltaTicks = totalTicks - prev.totalTicks;
      const deltaMs = now - prev.time;
      if (deltaMs > 0) {
        cpuPercent = (deltaTicks / hz) / (deltaMs / 1000) * 100;
      }
    }
    cpuSamples.set(pid, { totalTicks, time: now });

    return {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memoryMb,
      uptimeSeconds: Math.round(uptimeSeconds),
      threads,
    };
  } catch {
    return { cpuPercent: 0, memoryMb: 0, uptimeSeconds: 0, threads: 0 };
  }
}

export async function findLogSources(cwd: string, projectName: string): Promise<LogSource[]> {
  const sources: LogSource[] = [];

  if (cwd && cwd !== '?' && await pathExists(cwd)) {
    const matches: { path: string; mtime: Date }[] = [];
    const logPattern = /\.(log|out|err)$/;

    try {
      for (const entry of await readdir(cwd, { withFileTypes: true })) {
        if (entry.isFile() && logPattern.test(entry.name)) {
          const p = path.resolve(cwd, entry.name);
          const s = await stat(p);
          matches.push({ path: p, mtime: s.mtime });
        }
      }
      for (const entry of await readdir(cwd, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const subdir = path.resolve(cwd, entry.name);
          for (const sub of await readdir(subdir, { withFileTypes: true })) {
            if (sub.isFile() && logPattern.test(sub.name)) {
              const p = path.resolve(subdir, sub.name);
              const s = await stat(p);
              matches.push({ path: p, mtime: s.mtime });
            }
          }
        }
      }
    } catch { /* ignore */ }

    matches.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    for (const m of matches.slice(0, 10)) {
      sources.push({ type: 'file', label: path.basename(m.path), path: m.path });
    }
  }

  try {
    const output = await $`systemctl --user list-units --full --all`.text();
    const unitName = `app-${projectName}.service`;
    if (output.includes(unitName)) {
      sources.push({ type: 'journal', label: unitName, unit: unitName });
    }
  } catch { /* ignore */ }

  try {
    const home = process.env.HOME || '/root';
    const pm2Dir = path.join(home, '.pm2', 'logs');
    if (await pathExists(pm2Dir)) {
      const entries = await readdir(pm2Dir, { withFileTypes: true });
      const pm2Matches = entries.filter((e) => e.isFile() && e.name.startsWith(projectName) && e.name.endsWith('.log'));
      if (pm2Matches.length > 0) {
        const files = await Promise.all(
          pm2Matches.map(async (e) => {
            const p = path.join(pm2Dir, e.name);
            const s = await stat(p);
            return { path: p, mtime: s.mtime };
          })
        );
        files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
        const latest = files[0];
        sources.push({ type: 'pm2', label: path.basename(latest.path), path: latest.path });
      }
    }
  } catch { /* ignore */ }

  return sources;
}

export async function getProcessOpenFiles(pid: number): Promise<string[]> {
  try {
    const fds = await readdir(`/proc/${pid}/fd`);
    const links = await Promise.all(
      fds.map(async (fd) => {
        try {
          return await readlink(`/proc/${pid}/fd/${fd}`);
        } catch {
          return null;
        }
      })
    );
    return links.filter((l): l is string => !!l);
  } catch {
    return [];
  }
}

export async function killProcessGraceful(pid: number): Promise<{ success: boolean; error?: string }> {
  try {
    await $`kill -TERM ${pid}`;
    await Bun.sleep(2000);
    try {
      process.kill(pid, 0);
      await $`kill -KILL ${pid}`;
    } catch {
      // process already gone
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function getProcessDetails(pid: number): Promise<Partial<DetectedProcess> & { startTime?: string } | null> {
  try {
    const [cmdline, cwd, statContent, statusContent] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.from('')),
      readlink(`/proc/${pid}/cwd`).catch(() => '?'),
      readFile(`/proc/${pid}/stat`, 'utf-8').catch(() => ''),
      readFile(`/proc/${pid}/status`, 'utf-8').catch(() => ''),
    ]);

    const cmd = parseCmdline(cmdline);
    if (!cmd) return null;

    // Parse stat: comm is in parentheses, may contain spaces
    let ppid = 0;
    let starttime = 0;
    let name = 'unknown';
    const openParen = statContent.indexOf('(');
    const closeParen = statContent.indexOf(')');
    if (openParen > 0 && closeParen > openParen) {
      name = statContent.slice(openParen + 1, closeParen);
      const restStr = statContent.slice(closeParen + 2);
      const rest = restStr.split(' ');
      // rest[0] = state, rest[1] = ppid, ..., rest[19] = starttime
      ppid = parseInt(rest[1], 10) || 0;
      starttime = parseInt(rest[19], 10) || 0;
    }

    // Memory usage (VmRSS in kB)
    let memoryMb = 0;
    const rssMatch = statusContent.match(/VmRSS:\s+(\d+)\s+kB/);
    if (rssMatch) {
      memoryMb = Math.round(parseInt(rssMatch[1], 10) / 1024);
    }

    // Uptime cannot be reliably calculated from inside a container because
    // /proc/stat and /proc/uptime reflect the container's procfs, not the host.
    // We leave it at 0 and skip rendering it in the UI.
    const uptimeSeconds = 0;
    const cpuPercent = 0;

    const type = detectRuntime(cmd);
    const projectName = getProjectName(cwd, cmd);

    let startTime = '';
    try {
      const uptimeContent = await readFile('/proc/uptime', 'utf-8');
      const hostUptime = parseFloat(uptimeContent.split(' ')[0]) || 0;
      const hz = await getClockTickHz();
      const bootTime = Date.now() / 1000 - hostUptime;
      const processStartTime = bootTime + starttime / hz;
      startTime = new Date(processStartTime * 1000).toISOString();
    } catch {
      // leave empty
    }

    return {
      pid,
      ppid,
      name,
      cmd,
      cwd,
      projectName,
      type,
      uptimeSeconds,
      memoryMb,
      cpuPercent,
      startTime,
    };
  } catch {
    return null;
  }
}

export async function detectProcesses(): Promise<DetectedProcess[]> {
  const ports = await getListeningPorts();
  const processMap = new Map<number, DetectedProcess>();

  for (const mapping of ports) {
    if (processMap.has(mapping.pid)) {
      const existing = processMap.get(mapping.pid)!;
      if (!existing.ports.includes(mapping.port)) {
        existing.ports.push(mapping.port);
      }
      continue;
    }

    const details = await getProcessDetails(mapping.pid);
    if (!details) continue;

    processMap.set(mapping.pid, {
      ...details,
      ports: [mapping.port],
    } as DetectedProcess);
  }

  return Array.from(processMap.values()).sort((a, b) => a.pid - b.pid);
}

export function getContainerPublicPorts(portsStr: string): number[] {
  const ports: number[] = [];
  const regex = /(\d+)->\d+\/(?:tcp|udp)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(portsStr)) !== null) {
    ports.push(parseInt(match[1], 10));
  }
  return [...new Set(ports)];
}

export async function detectDockerContainers(): Promise<DockerContainer[]> {
  try {
    const output = await $`docker ps --format {{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}`.text();
    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        const [id, names, image, status, ports] = parts;
        const portsStr = ports || '';
        return {
          id: id.slice(0, 12),
          names: names || '',
          image: image || '',
          status: status || '',
          ports: portsStr,
          publicPorts: getContainerPublicPorts(portsStr),
          projectName: names ? names.split(',')[0] : '',
          type: 'docker' as const,
        };
      });
  } catch {
    return [];
  }
}

export async function killProcess(pid: number): Promise<{ success: boolean; error?: string }> {
  return killProcessGraceful(pid);
}

export async function killDockerContainer(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    await $`docker stop ${id}`;
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function getDockerContainerEnv(id: string): Promise<Record<string, string>> {
  try {
    const output = await $`docker inspect --format '{{.Config.Env}}' ${id}`.text();
    const env: Record<string, string> = {};
    const trimmed = output.trim();
    if (trimmed.length > 2 && trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1);
      const entries = inner.split(' ').filter(Boolean);
      for (const entry of entries) {
        const idx = entry.indexOf('=');
        if (idx === -1) continue;
        const key = entry.slice(0, idx);
        const value = entry.slice(idx + 1);
        env[key] = sanitizeEnvValue(key, value);
      }
    }
    return env;
  } catch {
    return {};
  }
}

export async function getDockerContainerStats(id: string): Promise<DockerContainerStats> {
  try {
    const output = await $`docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}' ${id}`.text();
    const line = output.trim().split('\n')[0];
    if (!line) return {};
    const [cpuPercent, memoryUsage, memoryPercent, networkIo, blockIo, pids] = line.split('|');
    return {
      cpuPercent: cpuPercent?.trim(),
      memoryUsage: memoryUsage?.trim(),
      memoryLimit: memoryUsage?.split('/')[1]?.trim(),
      memoryPercent: memoryPercent?.trim(),
      networkIo: networkIo?.trim(),
      blockIo: blockIo?.trim(),
      pids: pids?.trim(),
    };
  } catch {
    return {};
  }
}

export async function getDockerContainerStartTime(id: string): Promise<string | undefined> {
  try {
    const output = await $`docker inspect --format '{{.State.StartedAt}}' ${id}`.text();
    const startTime = output.trim();
    return startTime && startTime !== '0001-01-01T00:00:00Z' ? startTime : undefined;
  } catch {
    return undefined;
  }
}

export async function getDockerContainerCreatedAt(id: string): Promise<string | undefined> {
  try {
    const output = await $`docker inspect --format '{{.Created}}' ${id}`.text();
    const createdAt = output.trim();
    return createdAt && createdAt !== '0001-01-01T00:00:00Z' ? createdAt : undefined;
  } catch {
    return undefined;
  }
}

export async function getDockerContainerLogs(id: string): Promise<string[]> {
  try {
    const output = await $`docker logs ${id} --tail 200`.text();
    return output.split('\n');
  } catch {
    return [];
  }
}
