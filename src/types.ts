export interface ProcessStats {
  cpuPercent: number;
  memoryMb: number;
  uptimeSeconds: number;
  threads: number;
}

export interface ProcessStatsResponse {
  stats: ProcessStats;
}

export interface DockerContainerStats {
  cpuPercent?: string;
  memoryUsage?: string;
  memoryLimit?: string;
  memoryPercent?: string;
  networkIo?: string;
  blockIo?: string;
  pids?: string;
}

export interface LogSource {
  type: 'file' | 'journal' | 'pm2' | 'docker-logs';
  label: string;
  path?: string;
  command?: string;
  unit?: string;
}

export interface DetectedProcess {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  cwd: string;
  projectName: string;
  ports: number[];
  type: 'node' | 'bun' | 'python' | 'docker' | 'other';
  uptimeSeconds: number;
  memoryMb: number;
  cpuPercent: number;
  domain?: DomainMapping;
}

export interface ProcessDetails {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  cwd: string;
  projectName: string;
  type: DetectedProcess['type'];
  ports: number[];
  env: Record<string, string>;
  stats: ProcessStats;
  startTime: string;
  logSources: LogSource[];
}

export interface DockerContainer {
  id: string;
  names: string;
  image: string;
  status: string;
  ports: string;
  publicPorts?: number[];
  projectName: string;
  type: 'docker';
  domain?: DomainMapping;
}

export interface DomainMapping {
  id: string;
  subdomain: string;
  fullDomain: string;
  target: string;
  port: number;
  projectName: string;
  processType: 'process' | 'docker';
  createdAt: string;
  dnsRecordId?: string;
}

export interface AppConfig {
  auth: {
    username: string;
    passwordHash: string;
  };
  domains: DomainMapping[];
  settings: {
    scanIntervalMs: number;
    protectedPids: number[];
    protectedPorts: number[];
    ignoredPatterns: string[];
  };
}
