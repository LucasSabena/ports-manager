import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { $ } from 'bun';
import { readFile, writeFile } from 'fs/promises';
import {
  detectProcesses,
  detectDockerContainers,
  killProcess,
  killDockerContainer,
  getListeningPorts,
  getProcessDetails,
  getProcessEnv,
  getProcessStats,
  findLogSources,
  getDockerContainerEnv,
  getDockerContainerStats,
  getDockerContainerStartTime,
  getDockerContainerCreatedAt,
  getDockerContainerLogs,
} from './detector';
import {
  createDnsRecord,
  deleteDnsRecord,
  syncCloudflaredRoutes,
  listDnsRecords,
  listAllDnsRecords,
  getRemoteTunnelConfig,
} from './cloudflare';
import {
  requireAuth,
  hashPassword,
  verifyPassword,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  getSession,
} from './auth';
import { getServerStats } from './stats';
import {
  initProjectManager,
  getProjects,
  getProjectById,
  loadProjects,
  detectProjectsFromDisk,
  saveProjects,
  startProject,
  stopProject,
  deleteProject,
  getProjectLogs,
  subscribeToLogs,
} from './projectManager';
import type { AppConfig, DomainMapping, ProcessDetails, Project } from './types';

const CONFIG_PATH = process.env.CONFIG_PATH || '/app/data/config.json';
const PORT = parseInt(process.env.PORT || '3457', 10);
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'example.com';

async function loadConfig(): Promise<AppConfig> {
  try {
    const content = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {
      auth: { username: 'admin', passwordHash: await hashPassword('admin') },
      domains: [],
      settings: { scanIntervalMs: 5000, protectedPids: [1], protectedPorts: [22, 80, 443], ignoredPatterns: [] },
    };
  }
}

async function saveConfig(config: AppConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const app = new Hono();
let config = await loadConfig();
initProjectManager(config, saveConfig);
await loadProjects();

// Auth
app.post('/api/login', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  const valid = username === config.auth.username && (await verifyPassword(password, config.auth.passwordHash));
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  const token = await createSession(username);
  setSessionCookie(c, token);
  return c.json({ success: true });
});

app.post('/api/logout', async (c) => {
  clearSessionCookie(c);
  return c.json({ success: true });
});

app.get('/api/me', async (c) => {
  const session = await getSession(c);
  return c.json({ authenticated: !!session, username: session?.username || null });
});



// Protected API
app.use('/api/*', requireAuth);

app.get('/api/projects', async (c) => {
  return c.json({ projects: getProjects() });
});

app.post('/api/projects/detect', async (c) => {
  const detected = await detectProjectsFromDisk();
  const existing = getProjects();
  const byCwd = new Map(existing.map((p) => [p.cwd, p]));
  for (const project of detected) {
    if (!byCwd.has(project.cwd)) {
      byCwd.set(project.cwd, project);
    }
  }
  const merged = Array.from(byCwd.values()).sort((a, b) => a.name.localeCompare(b.name));
  await saveProjects(merged);
  return c.json({ projects: getProjects() });
});

app.post('/api/projects', async (c) => {
  const body = await c.req.json<Partial<Project>>();
  if (!body.name || !body.cwd || !body.type) {
    return c.json({ error: 'Missing required fields: name, cwd, type' }, 400);
  }

  const existing = body.id ? getProjectById(body.id) : undefined;
  const id = existing ? existing.id : body.id || generateId();

  const project: Project = {
    id,
    name: body.name,
    cwd: body.cwd,
    command: body.command,
    packageManager: body.packageManager,
    type: body.type,
    port: body.port,
    startUrl: body.startUrl,
    autoDetect: existing ? existing.autoDetect : false,
  };

  const others = getProjects().filter((p) => p.id !== id);
  others.push(project);
  await saveProjects(others);
  return c.json({ success: true, project });
});

app.delete('/api/projects/:id', async (c) => {
  const id = c.req.param('id');
  const result = await deleteProject(id);
  if (!result.success) {
    return c.json({ error: result.error }, 404);
  }
  return c.json({ success: true });
});

app.get('/api/projects/:id', async (c) => {
  const id = c.req.param('id');
  const project = getProjectById(id);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }
  return c.json(project);
});

app.post('/api/projects/:id/start', async (c) => {
  const id = c.req.param('id');
  const project = getProjectById(id);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }
  let command: string | undefined;
  try {
    const contentType = c.req.header('content-type') || '';
    const hasBody = c.req.raw.headers.get('content-length') || c.req.raw.headers.get('transfer-encoding');
    if (hasBody && contentType.includes('application/json')) {
      const body = await c.req.json<{ command?: string }>();
      command = body.command;
    }
  } catch { /* optional body */ }
  const result = await startProject(project, command);
  return c.json(result);
});

app.post('/api/projects/:id/stop', async (c) => {
  const id = c.req.param('id');
  const project = getProjectById(id);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }
  const result = await stopProject(project);
  return c.json(result);
});

app.get('/api/projects/:id/logs', async (c) => {
  const id = c.req.param('id');
  const project = getProjectById(id);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }
  const tail = parseInt(c.req.query('tail') || '200', 10);
  const lines = await getProjectLogs(project, tail);
  return c.json({ lines });
});


app.put('/api/config', async (c) => {
  const body = await c.req.json<Partial<AppConfig['settings']>>();
  config.settings = {
    ...config.settings,
    ...body,
    protectedPids: body.protectedPids ?? config.settings.protectedPids,
    protectedPorts: body.protectedPorts ?? config.settings.protectedPorts,
    ignoredPatterns: body.ignoredPatterns ?? config.settings.ignoredPatterns,
    scanIntervalMs: body.scanIntervalMs ?? config.settings.scanIntervalMs,
  };
  await saveConfig(config);
  return c.json({ success: true, settings: config.settings });
});

app.get('/api/processes', async (c) => {
  const all = c.req.query('all') === '1';
  let processes = await detectProcesses();

  const ignored = config.settings.ignoredPatterns || [];
  processes = processes.filter((p) => !ignored.some((pattern) => p.cmd.toLowerCase().includes(pattern.toLowerCase())));

  if (!all) {
    processes = processes.filter((p) => p.type === 'node' || p.type === 'bun' || p.type === 'python');
  }

  for (const p of processes) {
    p.domain = config.domains.find((d) => d.projectName === p.projectName && p.ports.includes(d.port));
  }

  return c.json({ processes });
});

app.post('/api/processes/:pid/kill', async (c) => {
  const pid = parseInt(c.req.param('pid'), 10);
  if (config.settings.protectedPids.includes(pid)) {
    return c.json({ error: 'Protected process' }, 403);
  }
  const result = await killProcess(pid);
  return c.json(result);
});

app.get('/api/processes/:pid/detail', async (c) => {
  const pid = parseInt(c.req.param('pid'), 10);
  const details = await getProcessDetails(pid);
  if (!details) {
    return c.json({ error: 'Process not found' }, 404);
  }

  const ports = (await getListeningPorts())
    .filter((m) => m.pid === pid)
    .map((m) => m.port);

  const [env, stats, logSources] = await Promise.all([
    getProcessEnv(pid),
    getProcessStats(pid),
    findLogSources(details.cwd || '?', details.projectName || 'unknown'),
  ]);

  const response: ProcessDetails = {
    pid: details.pid ?? pid,
    ppid: details.ppid ?? 0,
    name: details.name ?? 'unknown',
    cmd: details.cmd ?? '',
    cwd: details.cwd ?? '?',
    projectName: details.projectName ?? 'unknown',
    type: details.type ?? 'other',
    ports,
    env,
    stats,
    startTime: details.startTime || '',
    logSources,
  };

  return c.json(response);
});

app.get('/api/processes/:pid/stats', async (c) => {
  const pid = parseInt(c.req.param('pid'), 10);
  const stats = await getProcessStats(pid);
  return c.json({ stats });
});

app.get('/api/processes/:pid/logs', async (c) => {
  const pid = parseInt(c.req.param('pid'), 10);
  const source = c.req.query('source') || '';
  if (!source) {
    return c.json({ error: 'Missing source' }, 400);
  }

  let lines: string[] = [];
  try {
    if (source.startsWith('journal:')) {
      const unit = source.slice('journal:'.length);
      const output = await $`journalctl --user -u ${unit} -n 200 --no-pager`.text();
      lines = output.split('\n');
    } else {
      const output = await $`tail -n 200 ${source}`.text();
      lines = output.split('\n');
    }
  } catch (error) {
    return c.json({ error: String(error), lines: [] }, 500);
  }

  return c.json({ lines });
});

app.get('/api/docker', async (c) => {
  const containers = await detectDockerContainers();
  for (const container of containers) {
    container.domain = config.domains.find(
      (d) =>
        d.processType === 'docker' &&
        d.projectName === container.names.split(',')[0] &&
        container.publicPorts?.includes(d.port)
    );
  }
  return c.json({ containers });
});

app.post('/api/docker/:id/stop', async (c) => {
  const id = c.req.param('id');
  const result = await killDockerContainer(id);
  return c.json(result);
});

app.get('/api/docker/:id/detail', async (c) => {
  const id = c.req.param('id');
  const containers = await detectDockerContainers();
  const container = containers.find((d) => d.id === id);
  if (!container) {
    return c.json({ error: 'Container not found' }, 404);
  }

  const [env, stats, startTime, createdAt] = await Promise.all([
    getDockerContainerEnv(id),
    getDockerContainerStats(id),
    getDockerContainerStartTime(id),
    getDockerContainerCreatedAt(id),
  ]);

  return c.json({
    id: container.id,
    name: container.names,
    image: container.image,
    status: container.status,
    ports: container.ports,
    publicPorts: container.publicPorts ?? [],
    createdAt,
    env,
    logSources: [{ type: 'docker-logs', label: 'Docker logs', command: `docker logs ${id} --tail 200` }],
    stats,
    startTime,
  });
});

app.get('/api/docker/:id/stats', async (c) => {
  const id = c.req.param('id');
  const stats = await getDockerContainerStats(id);
  return c.json({ stats });
});

app.get('/api/docker/:id/logs', async (c) => {
  const id = c.req.param('id');
  const lines = await getDockerContainerLogs(id);
  return c.json({ lines });
});

app.get('/api/domains', async (c) => {
  return c.json({ domains: config.domains });
});

app.post('/api/domains/import', async (c) => {
  const remote = await getRemoteTunnelConfig();
  if (!remote.success || !remote.config) {
    return c.json({ error: remote.error || 'Failed to fetch tunnel config' }, 500);
  }

  const dnsRecords = await listAllDnsRecords('CNAME');
  const containers = await detectDockerContainers();
  const imported: DomainMapping[] = [];
  const skipped: string[] = [];

  const ingress = remote.config.config.ingress || [];
  for (const entry of ingress) {
    if (!entry.hostname) continue;
    if (entry.hostname === `ports.${BASE_DOMAIN}`) continue;

    const subdomain = entry.hostname.replace(new RegExp(`\\.${escapeRegExp(BASE_DOMAIN)}$`), '');
    const serviceMatch = entry.service.match(/:\/\/localhost:(\d+)/);
    const port = serviceMatch ? parseInt(serviceMatch[1], 10) : 0;
    if (!port) {
      skipped.push(entry.hostname);
      continue;
    }

    if (config.domains.some((d) => d.fullDomain === entry.hostname)) {
      skipped.push(entry.hostname);
      continue;
    }

    const isHttps = entry.service.startsWith('https://');
    const target = `${isHttps ? 'https' : 'http'}://localhost:${port}`;

    // Determine if it's Docker by matching a container that exposes this public port
    const matchingContainer = containers.find((container) =>
      container.publicPorts?.includes(port)
    );
    const projectName = matchingContainer ? matchingContainer.names.split(',')[0] : subdomain;
    const processType: 'process' | 'docker' = matchingContainer ? 'docker' : 'process';

    const dnsRecord = dnsRecords.find((r) => r.name === entry.hostname);

    const domain: DomainMapping = {
      id: generateId(),
      subdomain,
      fullDomain: entry.hostname,
      target,
      port,
      projectName,
      processType,
      createdAt: new Date().toISOString(),
      dnsRecordId: dnsRecord?.id,
    };

    config.domains.push(domain);
    imported.push(domain);
  }

  await saveConfig(config);
  return c.json({ success: true, imported, skipped, count: imported.length });
});

app.post('/api/domains', async (c) => {
  const { subdomain, port, processType, projectName } = await c.req.json<{
    subdomain: string;
    port: number;
    processType: 'process' | 'docker';
    projectName: string;
  }>();

  const clean = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!clean || clean.length < 1) {
    return c.json({ error: 'Invalid subdomain' }, 400);
  }

  const fullDomain = `${clean}.${BASE_DOMAIN}`;

  // Check if already exists
  if (config.domains.some((d) => d.fullDomain === fullDomain)) {
    return c.json({ error: 'Domain already assigned' }, 409);
  }

  // Check DNS doesn't already exist from another source
  const existing = await listDnsRecords(fullDomain);
  if (existing.length > 0) {
    return c.json({ error: 'DNS record already exists in Cloudflare' }, 409);
  }

  // Determine target
  const isHttps = port === 9443 || port === 9090 || port === 443;
  const target = `${isHttps ? 'https' : 'http'}://localhost:${port}`;

  // Create DNS record
  const dns = await createDnsRecord(fullDomain);
  if (!dns.success) {
    return c.json({ error: dns.error || 'Failed to create DNS record' }, 500);
  }

  const domain: DomainMapping = {
    id: generateId(),
    subdomain: clean,
    fullDomain,
    target,
    port,
    projectName,
    processType,
    createdAt: new Date().toISOString(),
    dnsRecordId: dns.recordId,
  };

  config.domains.push(domain);
  await saveConfig(config);

  const sync = await syncCloudflaredRoutes(config.domains);
  if (!sync.success) {
    // Rollback
    if (domain.dnsRecordId) await deleteDnsRecord(domain.dnsRecordId);
    config.domains = config.domains.filter((d) => d.id !== domain.id);
    await saveConfig(config);
    return c.json({ error: sync.error || 'Failed to sync cloudflared' }, 500);
  }

  return c.json({ success: true, domain });
});

app.put('/api/domains/:id', async (c) => {
  const id = c.req.param('id');
  const domain = config.domains.find((d) => d.id === id);
  if (!domain) {
    return c.json({ error: 'Domain not found' }, 404);
  }

  const { subdomain } = await c.req.json<{ subdomain: string }>();
  const clean = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!clean || clean.length < 1) {
    return c.json({ error: 'Invalid subdomain' }, 400);
  }

  const newFullDomain = `${clean}.${BASE_DOMAIN}`;
  if (newFullDomain === domain.fullDomain) {
    return c.json({ success: true, domain });
  }

  if (config.domains.some((d) => d.id !== id && d.fullDomain === newFullDomain)) {
    return c.json({ error: 'Domain already assigned' }, 409);
  }

  const existing = await listDnsRecords(newFullDomain);
  if (existing.length > 0) {
    return c.json({ error: 'DNS record already exists in Cloudflare' }, 409);
  }

  // Preserve original state for rollback
  const oldDomainState = { ...domain };

  const created = await createDnsRecord(newFullDomain);
  if (!created.success) {
    return c.json({ error: created.error || 'Failed to create DNS record' }, 500);
  }

  const newRecordId = created.recordId;

  if (oldDomainState.dnsRecordId) {
    const deleted = await deleteDnsRecord(oldDomainState.dnsRecordId);
    if (!deleted.success) {
      // Rollback new DNS record
      if (newRecordId) await deleteDnsRecord(newRecordId);
      return c.json({ error: deleted.error || 'Failed to delete old DNS record' }, 500);
    }
  }

  // Apply updates
  domain.subdomain = clean;
  domain.fullDomain = newFullDomain;
  domain.dnsRecordId = newRecordId;
  await saveConfig(config);

  const sync = await syncCloudflaredRoutes(config.domains);
  if (!sync.success) {
    // Rollback config
    domain.subdomain = oldDomainState.subdomain;
    domain.fullDomain = oldDomainState.fullDomain;
    domain.dnsRecordId = oldDomainState.dnsRecordId;
    await saveConfig(config);

    // Rollback DNS: recreate old record, remove new record
    if (oldDomainState.dnsRecordId) {
      const recreated = await createDnsRecord(oldDomainState.fullDomain);
      if (recreated.success && recreated.recordId) {
        domain.dnsRecordId = recreated.recordId;
        await saveConfig(config);
      }
    }
    if (newRecordId) await deleteDnsRecord(newRecordId);

    return c.json({ error: sync.error || 'Failed to sync cloudflared' }, 500);
  }

  return c.json({ success: true, domain });
});

app.delete('/api/domains/:id', async (c) => {
  const id = c.req.param('id');
  const domain = config.domains.find((d) => d.id === id);
  if (!domain) {
    return c.json({ error: 'Domain not found' }, 404);
  }

  if (domain.dnsRecordId) {
    await deleteDnsRecord(domain.dnsRecordId);
  }

  config.domains = config.domains.filter((d) => d.id !== id);
  await saveConfig(config);
  await syncCloudflaredRoutes(config.domains);

  return c.json({ success: true });
});

app.get('/api/config', async (c) => {
  return c.json({
    scanIntervalMs: config.settings.scanIntervalMs,
    protectedPids: config.settings.protectedPids,
    protectedPorts: config.settings.protectedPorts,
    ignoredPatterns: config.settings.ignoredPatterns || [],
    baseDomain: BASE_DOMAIN,
  });
});

app.get('/api/stats', async (c) => {
  const stats = await getServerStats();
  return c.json({ stats });
});

// Static files (must be after API routes)
app.use(
  '*',
  serveStatic({
    root: './public',
    onFound: (_path, c) => {
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      c.header('Pragma', 'no-cache');
      c.header('Expires', '0');
    },
  })
);
app.get(
  '/',
  serveStatic({
    path: './public/index.html',
    onFound: (_path, c) => {
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      c.header('Pragma', 'no-cache');
      c.header('Expires', '0');
    },
  })
);

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

console.log(`Starting ports-manager on port ${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
