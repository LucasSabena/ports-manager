import { $ } from 'bun';

export interface ServerStats {
  cpuPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryPercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
  diskPercent: number;
  loadAverage: number[];
  temperatures?: Record<string, number>;
  ip?: string;
  hosts?: ServerHost[];
}

export interface ServerHost {
  label: string;
  host: string;
  kind: 'tailscale' | 'lan' | 'route' | 'other';
}

function parseMeminfo(content: string, key: string): number {
  const match = content.match(new RegExp(`${key}:\\s+(\\d+)\\s+kB`));
  return match ? parseInt(match[1], 10) : 0;
}

export async function getServerStats(): Promise<ServerStats> {
  try {
    const [meminfo, stat, df, uptime, sensors] = await Promise.all([
      $`cat /proc/meminfo`.text().catch(() => ''),
      $`cat /proc/stat`.text().catch(() => ''),
      $`df -B1 /`.text().catch(() => ''),
      $`uptime`.text().catch(() => ''),
      $`sensors -j 2>/dev/null || echo '{}'`.text().catch(() => '{}'),
    ]);

    const memoryTotalKb = parseMeminfo(meminfo, 'MemTotal');
    const memoryAvailableKb = parseMeminfo(meminfo, 'MemAvailable');
    const memoryUsedKb = memoryTotalKb - memoryAvailableKb;
    const memoryTotalMb = Math.round(memoryTotalKb / 1024);
    const memoryUsedMb = Math.round(memoryUsedKb / 1024);
    const memoryPercent = memoryTotalKb ? Math.round((memoryUsedKb / memoryTotalKb) * 100) : 0;

    const cpuPercent = calculateCpuPercent(stat);

    const diskLines = df.split('\n').filter(Boolean);
    const diskLine = diskLines[1] || '';
    const diskParts = diskLine.trim().split(/\s+/);
    const diskTotalBytes = parseInt(diskParts[1] || '0', 10);
    const diskUsedBytes = parseInt(diskParts[2] || '0', 10);
    const diskTotalGb = Math.round(diskTotalBytes / (1024 * 1024 * 1024));
    const diskUsedGb = Math.round(diskUsedBytes / (1024 * 1024 * 1024));
    const diskPercent = diskTotalBytes ? Math.round((diskUsedBytes / diskTotalBytes) * 100) : 0;

    const loadMatch = uptime.match(/load average[s]?:\s+([\d.,]+)\s*,?\s*([\d.,]+)?\s*,?\s*([\d.,]+)?/);
    const loadAverage = loadMatch
      ? [loadMatch[1], loadMatch[2], loadMatch[3]]
          .filter(Boolean)
          .map((v) => parseFloat(v.replace(',', '.')))
      : [];

    const temperatures = parseSensors(sensors);

    const hosts = await getServerHosts();
    const serverIp = hosts[0]?.host || '';

    return {
      cpuPercent,
      memoryUsedMb,
      memoryTotalMb,
      memoryPercent,
      diskUsedGb,
      diskTotalGb,
      diskPercent,
      loadAverage,
      temperatures,
      ip: serverIp,
      hosts,
    };
  } catch (error) {
    console.error('Failed to get server stats:', error);
    return {
      cpuPercent: 0,
      memoryUsedMb: 0,
      memoryTotalMb: 0,
      memoryPercent: 0,
      diskUsedGb: 0,
      diskTotalGb: 0,
      diskPercent: 0,
      loadAverage: [],
    };
  }
}

function classifyHost(ip: string): ServerHost['kind'] {
  const parts = ip.split('.').map((part) => parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return 'other';
  const [a, b] = parts;
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 'lan';
  return 'other';
}

function labelForHost(ip: string, kind: ServerHost['kind'], iface?: string): string {
  if (kind === 'tailscale') return 'Tailscale';
  if (kind === 'lan') return iface ? `LAN ${iface}` : 'LAN';
  if (kind === 'route') return 'Red';
  return iface ? `Host ${iface}` : 'Host';
}

async function getServerHosts(): Promise<ServerHost[]> {
  const hosts = new Map<string, ServerHost>();

  const add = (ip: string, kind?: ServerHost['kind'], iface?: string) => {
    if (!ip || ip.startsWith('127.')) return;
    const detectedKind = kind || classifyHost(ip);
    const existing = hosts.get(ip);
    if (!existing) {
      hosts.set(ip, {
        host: ip,
        kind: detectedKind,
        label: labelForHost(ip, detectedKind, iface),
      });
      return;
    }

    const weight: Record<ServerHost['kind'], number> = { tailscale: 0, lan: 1, route: 2, other: 3 };
    if (weight[detectedKind] < weight[existing.kind]) {
      hosts.set(ip, {
        host: ip,
        kind: detectedKind,
        label: labelForHost(ip, detectedKind, iface),
      });
    }
  };

  const routeOutput = await $`ip route get 1.1.1.1`.text().catch(() => '');
  const routeMatch = routeOutput.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
  if (routeMatch) add(routeMatch[1], 'route');

  const addrOutput = await $`ip -4 -o addr show scope global`.text().catch(() => '');
  for (const line of addrOutput.split('\n').filter(Boolean)) {
    const match = line.match(/^\d+:\s+([^:\s]+).*?\sinet\s+(\d+\.\d+\.\d+\.\d+)\/\d+/);
    if (!match) continue;
    if (/^(docker|br-|veth|virbr|podman|cni)/.test(match[1])) continue;
    add(match[2], classifyHost(match[2]), match[1]);
  }

  return Array.from(hosts.values()).sort((a, b) => {
    const weight: Record<ServerHost['kind'], number> = { tailscale: 0, lan: 1, route: 2, other: 3 };
    return weight[a.kind] - weight[b.kind] || a.label.localeCompare(b.label);
  });
}

let lastCpuStats: { user: number; nice: number; system: number; idle: number; iowait: number; irq: number; softirq: number; steal: number; total: number; time: number } | null = null;

function calculateCpuPercent(statContent: string): number {
  const match = statContent.match(/^cpu\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)/m);
  if (!match) return 0;

  const [, user, nice, system, idle, iowait, irq, softirq, steal] = match.slice(1).map((v) => parseInt(v, 10));
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  const now = Date.now();

  if (!lastCpuStats) {
    lastCpuStats = { user, nice, system, idle, iowait, irq, softirq, steal, total, time: now };
    return 0;
  }

  const totalDiff = total - lastCpuStats.total;
  const idleDiff = idle - lastCpuStats.idle;
  const percent = totalDiff ? Math.round(((totalDiff - idleDiff) / totalDiff) * 100) : 0;

  lastCpuStats = { user, nice, system, idle, iowait, irq, softirq, steal, total, time: now };
  return Math.max(0, Math.min(100, percent));
}

function parseSensors(sensorsJson: string): Record<string, number> | undefined {
  try {
    const data = JSON.parse(sensorsJson);
    const temps: Record<string, number> = {};
    for (const [chip, values] of Object.entries(data)) {
      if (typeof values !== 'object' || values === null) continue;
      for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
        if (key.includes('input') && typeof value === 'number') {
          const labelKey = key.replace('input', 'label');
          const label = (values as Record<string, unknown>)[labelKey];
          const name = typeof label === 'string' && label ? `${chip}/${label}` : `${chip}/${key}`;
          temps[name] = Math.round(value * 10) / 10;
        }
      }
    }
    return Object.keys(temps).length > 0 ? temps : undefined;
  } catch {
    return undefined;
  }
}
