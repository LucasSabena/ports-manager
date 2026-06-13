import { $ } from 'bun';
import { readdir, readFile, stat, mkdir, unlink } from 'fs/promises';
import { createWriteStream, readFileSync } from 'fs';
import * as path from 'path';
import type { AppConfig, Project } from './types';
import { getListeningPorts, getProcessListeningPorts, getServerIp } from './detector';

const CONFIG_PATH = process.env.CONFIG_PATH || '/app/data/config.json';
const LOG_DIR = process.env.LOG_DIR || '/app/data/logs';
const MAX_LOG_BUFFER_LINES = 1000;
const PORT_DETECTION_TIMEOUT_MS = 15000;
const PORT_DETECTION_INTERVAL_MS = 500;
const KILL_GRACE_PERIOD_MS = 2000;

const SCAN_PARENT_DIRS = [
  '/host/Proyectos',
  '/host/projects',
  '/host/dev',
  '/host',
  '/app',
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.npm',
  '.local',
  '.config',
  '.bun',
  '.cargo',
  '.dotnet',
  '.pnpm',
  '.next',
  'dist',
  'build',
  'out',
  '.openchamber',
  '. Playwright',
  '.nuxt',
  '.astro',
  '.svelte-kit',
  '.turbo',
]);

interface SubprocessHandle {
  proc: ReturnType<typeof Bun.spawn>;
  pid: number;
}

let appConfig: AppConfig | null = null;
let saveConfigFn: ((config: AppConfig) => Promise<void>) | null = null;

const projectMap = new Map<string, Project>();
const runningHandles = new Map<string, SubprocessHandle>();
const logBuffers = new Map<string, string[]>();
const logFiles = new Map<string, string>();
const logSubscriptions = new Map<string, Set<(line: string) => void>>();

export function initProjectManager(
  config: AppConfig,
  saveFn: (config: AppConfig) => Promise<void>
): void {
  appConfig = config;
  saveConfigFn = saveFn;
  if (config.projects) {
    for (const project of config.projects) {
      projectMap.set(project.id, project);
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function generateProjectId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'project';
  let id = base;
  let counter = 1;
  while (projectMap.has(id)) {
    id = `${base}-${counter++}`;
  }
  return id;
}

async function readJsonFile<T>(p: string): Promise<T | null> {
  try {
    const content = await readFile(p, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function readJsonFileSync<T>(p: string): T | null {
  try {
    const content = readFileSync(p, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function detectPackageManager(cwd: string, files: string[]): Project['packageManager'] {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lock') || files.includes('bun.lockb')) return 'bun';
  if (files.includes('package-lock.json')) return 'npm';
  return 'npm';
}

function pickScript(scripts: Record<string, string> | undefined): string | undefined {
  if (!scripts) return undefined;
  const preferred = ['dev', 'start', 'serve'];
  for (const name of preferred) {
    if (scripts[name]) return name;
  }
  return Object.keys(scripts)[0];
}

function buildBunCommand(cwd: string): string | undefined {
  const pkg = readJsonFileSync<{ scripts?: Record<string, string> }>(path.join(cwd, 'package.json'));
  if (!pkg) return undefined;
  const script = pickScript(pkg.scripts);
  if (!script) return undefined;
  return `bun run ${script}`;
}

function buildNodeCommand(cwd: string, packageManager: Project['packageManager']): string | undefined {
  const pkg = readJsonFileSync<{ scripts?: Record<string, string> }>(path.join(cwd, 'package.json'));
  if (!pkg) return undefined;
  const script = pickScript(pkg.scripts);
  if (!script) return undefined;
  if (packageManager === 'bun') return `bun run ${script}`;
  // Prefer npm inside the container because node is available and handles pnpm/yarn node_modules
  return `npm run ${script}`;
}

async function detectNodeProject(cwd: string, files: string[]): Promise<Project | null> {
  if (!files.includes('package.json')) return null;
  const pkg = readJsonFileSync<{ name?: string; scripts?: Record<string, string> }>(path.join(cwd, 'package.json'));
  if (!pkg) return null;
  const name = pkg.name || path.basename(cwd);
  const packageManager = detectPackageManager(cwd, files);
  // Prefer bun run inside the container because bun is available and handles node projects
  const command = buildBunCommand(cwd) || buildNodeCommand(cwd, packageManager);
  const id = generateProjectId(name);
  return {
    id,
    name,
    cwd,
    command,
    packageManager,
    type: packageManager === 'bun' ? 'bun' : 'node',
    autoDetect: true,
  };
}

async function detectPythonProject(cwd: string, files: string[]): Promise<Project | null> {
  const hasAppPy = files.includes('app.py');
  const hasMainPy = files.includes('main.py');
  const hasRequirements = files.includes('requirements.txt');
  if (!hasAppPy && !hasMainPy && !hasRequirements) return null;

  const name = path.basename(cwd);
  let command: string | undefined;
  if (hasAppPy) command = 'python app.py';
  else if (hasMainPy) command = 'python main.py';

  return {
    id: generateProjectId(name),
    name,
    cwd,
    command,
    type: 'python',
    autoDetect: true,
  };
}

async function scanDirectory(baseDir: string, depth: number, detected: Project[], seenCwds: Set<string>): Promise<void> {
  if (depth <= 0) return;
  if (!(await pathExists(baseDir))) return;
  const baseName = path.basename(baseDir);
  if (baseName.startsWith('.') || SKIP_DIRS.has(baseName)) return;

  const parts = baseDir.split('/');
  if (parts.some((part) => part.startsWith('.') || SKIP_DIRS.has(part))) return;

  try {
    let files: string[] = [];
    try {
      files = await readdir(baseDir);
    } catch { /* ignore inaccessible directories */ }

    const nodeProject = await detectNodeProject(baseDir, files);
    if (nodeProject) {
      if (!seenCwds.has(baseDir)) {
        detected.push(nodeProject);
        seenCwds.add(baseDir);
      }
      return;
    }

    const pythonProject = await detectPythonProject(baseDir, files);
    if (pythonProject) {
      if (!seenCwds.has(baseDir)) {
        detected.push(pythonProject);
        seenCwds.add(baseDir);
      }
      return;
    }

    // No project files here, scan subdirectories
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cwd = path.resolve(baseDir, entry.name);
      await scanDirectory(cwd, depth - 1, detected, seenCwds);
    }
  } catch { /* ignore unreadable directories */ }
}

export async function detectProjectsFromDisk(): Promise<Project[]> {
  const detected: Project[] = [];
  const seenCwds = new Set<string>();

  for (const parent of SCAN_PARENT_DIRS) {
    await scanDirectory(parent, 4, detected, seenCwds);
  }

  return detected.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadProjects(): Promise<Project[]> {
  const saved = appConfig?.projects || [];
  const detected = await detectProjectsFromDisk();

  const merged = new Map<string, Project>();

  // Saved projects take precedence by cwd
  for (const project of saved) {
    merged.set(project.cwd, { ...project });
  }

  for (const project of detected) {
    if (!merged.has(project.cwd)) {
      merged.set(project.cwd, project);
    }
  }

  const projects = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));

  projectMap.clear();
  for (const project of projects) {
    projectMap.set(project.id, project);
  }

  return projects;
}

export async function saveProjects(projects: Project[]): Promise<void> {
  if (!appConfig || !saveConfigFn) {
    throw new Error('Project manager not initialized');
  }
  appConfig.projects = projects;
  await saveConfigFn(appConfig);

  projectMap.clear();
  for (const project of projects) {
    projectMap.set(project.id, project);
  }
}

export async function deleteProject(id: string): Promise<{ success: boolean; error?: string }> {
  const project = projectMap.get(id);
  if (!project) return { success: false, error: 'Project not found' };
  if (project.running?.pid) {
    await stopProject(project);
  }
  const others = getProjects().filter((p) => p.id !== id);
  await saveProjects(others);
  logBuffers.delete(id);
  logFiles.delete(id);
  logSubscriptions.delete(id);
  return { success: true };
}

export function getProjects(): Project[] {
  syncRunningProjects();
  return Array.from(projectMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getRunningProjects(): Project[] {
  return getProjects().filter((p) => p.running);
}

export function getProjectById(id: string): Project | undefined {
  syncRunningProjects();
  return projectMap.get(id);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function syncRunningProjects(): void {
  let changed = false;
  for (const project of projectMap.values()) {
    if (project.running?.pid && !isProcessAlive(project.running.pid)) {
      delete project.running;
      runningHandles.delete(project.id);
      changed = true;
    }
  }
  if (changed && appConfig && saveConfigFn) {
    appConfig.projects = Array.from(projectMap.values());
    saveConfigFn(appConfig).catch(() => { /* ignore */ });
  }
}

async function ensureLogDir(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
}

async function rotateLogFile(projectName: string): Promise<string> {
  await ensureLogDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(LOG_DIR, `${projectName}-${timestamp}.log`);

  // Keep only the latest log file per project; remove older ones
  try {
    const entries = await readdir(LOG_DIR);
    const oldLogs = entries
      .filter((name) => name.startsWith(`${projectName}-`) && name.endsWith('.log'))
      .map((name) => path.join(LOG_DIR, name));
    for (const old of oldLogs) {
      if (old !== logFile) {
        await unlink(old).catch(() => { /* ignore */ });
      }
    }
  } catch { /* ignore */ }

  return logFile;
}

async function getChildPids(pid: number): Promise<number[]> {
  const children: number[] = [];
  try {
    const content = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf-8');
    const pids = content
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((v) => parseInt(v, 10))
      .filter((v) => !Number.isNaN(v));
    for (const childPid of pids) {
      children.push(childPid);
      const grandChildren = await getChildPids(childPid);
      children.push(...grandChildren);
    }
  } catch { /* ignore */ }
  return children;
}

async function waitForPorts(pid: number): Promise<number[]> {
  const deadline = Date.now() + PORT_DETECTION_TIMEOUT_MS;
  const found = new Set<number>();

  while (Date.now() < deadline) {
    const childPids = await getChildPids(pid);
    const pids = new Set([pid, ...childPids]);

    try {
      const mappings = await getProcessListeningPorts(pid);
      for (const port of mappings) {
        found.add(port);
      }

      // Also scan all listening ports to catch children that may not match the parent PID in ss
      const allMappings = await getListeningPorts();
      for (const m of allMappings) {
        if (pids.has(m.pid)) {
          found.add(m.port);
        }
      }
    } catch { /* ignore */ }

    if (found.size > 0) {
      return Array.from(found).sort((a, b) => a - b);
    }

    await Bun.sleep(PORT_DETECTION_INTERVAL_MS);
  }

  return [];
}

function appendLog(projectId: string, line: string): void {
  let buffer = logBuffers.get(projectId);
  if (!buffer) {
    buffer = [];
    logBuffers.set(projectId, buffer);
  }
  buffer.push(line);
  if (buffer.length > MAX_LOG_BUFFER_LINES) {
    buffer.shift();
  }

  const subs = logSubscriptions.get(projectId);
  if (subs) {
    for (const cb of subs) {
      try {
        cb(line);
      } catch { /* ignore subscriber errors */ }
    }
  }
}

async function collectStreams(
  projectId: string,
  proc: ReturnType<typeof Bun.spawn>,
  logFile: string
): Promise<void> {
  const fileStream = createWriteStream(logFile, { flags: 'a' });
  const streams = [proc.stdout, proc.stderr].filter(Boolean) as ReadableStream<Uint8Array>[];

  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let partial = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        partial += decoder.decode(value, { stream: true });
        const lines = partial.split('\n');
        partial = lines.pop() || '';
        for (const line of lines) {
          appendLog(projectId, line);
          fileStream.write(`${line}\n`);
        }
      }
      if (partial) {
        appendLog(projectId, partial);
        fileStream.write(partial);
      }
    } catch { /* ignore stream errors */ }
  };

  await Promise.all(streams.map(collect));
  fileStream.end();
}

export async function startProject(
  project: Project,
  commandOverride?: string
): Promise<{ success: boolean; pid?: number; ports?: number[]; localUrl?: string; networkUrl?: string; error?: string }> {
  if (project.running?.pid) {
    return { success: false, error: 'Project is already running' };
  }

  let command = commandOverride || project.command;
  if (!command) {
    if ((project.type === 'node' || project.type === 'bun')) {
      command = buildBunCommand(project.cwd) || (project.packageManager && buildNodeCommand(project.cwd, project.packageManager));
    }
  }

  if (!command) {
    return { success: false, error: 'No start command found for project' };
  }

  const logFile = await rotateLogFile(project.name);
  logFiles.set(project.id, logFile);

  try {
    const proc = Bun.spawn(['sh', '-c', `exec ${command}`], {
      cwd: project.cwd,
      detached: true,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });

    const pid = proc.pid;
    runningHandles.set(project.id, { proc, pid });

    // Start collecting logs immediately
    collectStreams(project.id, proc, logFile).catch(() => { /* ignore */ });

    project.running = {
      pid,
      ports: [],
      startedAt: new Date().toISOString(),
    };
    await saveProjects(getProjects());

    // Detect ports in background and update project once found
    (async () => {
      const ports = await waitForPorts(pid);
      const serverIp = await getServerIp();
      const fresh = getProjectById(project.id);
      if (fresh && fresh.running?.pid === pid) {
        fresh.running.ports = ports;
        await saveProjects(getProjects());
      }
      if (logSubscriptions.has(project.id)) {
        // nothing extra needed; subscriptions receive live lines
      }
    })().catch(() => { /* ignore background errors */ });

    const port = project.running.ports?.[0];
    return {
      success: true,
      pid,
      ports: project.running.ports,
      localUrl: port ? `http://localhost:${port}` : undefined,
      networkUrl: port ? `http://${await getServerIp()}:${port}` : undefined,
      error: port ? undefined : 'Process started; port detection in progress',
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function stopProject(project: Project): Promise<{ success: boolean; error?: string }> {
  if (!project.running?.pid) {
    return { success: false, error: 'Project is not running' };
  }

  const pid = project.running.pid;
  const handle = runningHandles.get(project.id);

  try {
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* ignore */ }

    await Bun.sleep(KILL_GRACE_PERIOD_MS);

    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // process already gone
    }

    if (handle) {
      try {
        handle.proc.kill();
      } catch { /* ignore */ }
      runningHandles.delete(project.id);
    }

    delete project.running;
    await saveProjects(getProjects());
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function getProjectLogs(project: Project, tailLines = 200): Promise<string[]> {
  const ring = logBuffers.get(project.id) || [];
  const logFile = logFiles.get(project.id);

  if (!logFile || !(await pathExists(logFile))) {
    return [...ring].slice(-tailLines);
  }

  try {
    const output = await $`tail -n ${tailLines} ${logFile}`.text();
    const fileLines = output.split('\n');
    return [...fileLines, ...ring].slice(-tailLines);
  } catch {
    return [...ring].slice(-tailLines);
  }
}

export function subscribeToLogs(projectId: string, callback: (line: string) => void): () => void {
  let subs = logSubscriptions.get(projectId);
  if (!subs) {
    subs = new Set();
    logSubscriptions.set(projectId, subs);
  }
  subs.add(callback);
  return () => {
    subs?.delete(callback);
    if (subs?.size === 0) {
      logSubscriptions.delete(projectId);
    }
  };
}
