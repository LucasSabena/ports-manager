const API = {
  async request(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  get(path) { return this.request(path); },
  post(path, body) { return this.request(path, { method: 'POST', body: JSON.stringify(body) }); },
  put(path, body) { return this.request(path, { method: 'PUT', body: JSON.stringify(body) }); },
  delete(path) { return this.request(path, { method: 'DELETE' }); },
};

let currentTab = 'processes';
let scanInterval = 5000;
let pollTimer = null;
let cachedDomains = [];

// Auth
async function checkAuth() {
  try {
    const { authenticated, username } = await API.get('/api/me');
    if (authenticated) {
      showMain(username);
      loadConfig();
      startPolling();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('login-error');
  try {
    await API.post('/api/login', { username, password });
    showMain(username);
    loadConfig();
    startPolling();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.post('/api/logout');
  stopPolling();
  closeDetailModal();
  showLogin();
});

function showLogin() {
  closeDetailModal();
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('main-screen').classList.add('hidden');
}

function showMain(username) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('main-screen').classList.remove('hidden');
  document.getElementById('user-name').textContent = username;
}

// Tabs
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    setTab(tab);
  });
});

function setTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.toggle('active', c.id === `tab-${tab}`));
  refresh();
}

// Data loading
async function loadConfig() {
  try {
    const cfg = await API.get('/api/config');
    scanInterval = cfg.scanIntervalMs;
  } catch {
    scanInterval = 5000;
  }
}

async function loadProcesses() {
  try {
    const [{ processes }, { domains }] = await Promise.all([
      API.get('/api/processes'),
      API.get('/api/domains'),
    ]);
    cachedDomains = domains || [];
    renderProcesses(processes, domains);
    document.getElementById('processes-updated').textContent = `Actualizado ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error('Failed to load processes:', err);
  }
}

async function loadSystem() {
  try {
    const [{ processes }, { domains }] = await Promise.all([
      API.get('/api/processes?all=1'),
      API.get('/api/domains'),
    ]);
    cachedDomains = domains || [];
    renderSystem(processes, domains);
    document.getElementById('system-updated').textContent = `Actualizado ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error('Failed to load system:', err);
  }
}

async function loadDocker() {
  try {
    const [{ containers }, { domains }] = await Promise.all([
      API.get('/api/docker'),
      API.get('/api/domains'),
    ]);
    cachedDomains = domains || [];
    renderDocker(containers, domains);
    document.getElementById('docker-updated').textContent = `Actualizado ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error('Failed to load docker:', err);
  }
}

async function loadDomains() {
  try {
    const { domains } = await API.get('/api/domains');
    cachedDomains = domains || [];
    renderDomains(domains);
  } catch (err) {
    console.error('Failed to load domains:', err);
  }
}

function refresh() {
  if (currentTab === 'processes') loadProcesses();
  if (currentTab === 'system') loadSystem();
  if (currentTab === 'docker') loadDocker();
  if (currentTab === 'domains') loadDomains();
}

function startPolling() {
  refresh();
  loadStats();
  pollTimer = setInterval(() => {
    refresh();
    loadStats();
  }, scanInterval);
}

async function loadStats() {
  try {
    const { stats } = await API.get('/api/stats');
    document.getElementById('stat-cpu').textContent = `${stats.cpuPercent}%`;
    document.getElementById('stat-ram').textContent = `${stats.memoryPercent}%`;
    document.getElementById('stat-disk').textContent = `${stats.diskPercent}%`;
    document.getElementById('stat-load').textContent = stats.loadAverage[0]?.toFixed(2) || '-';
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
}

// Rendering
function renderProcessRow(p, isSystem, domains) {
  const typeClass = `badge-${p.type}`;
  const projectName = p.projectName || p.name;
  const matchName = p.projectName;

  const portsHtml = (p.ports || []).map((port) => {
    const domain = (domains || []).find((d) => d.projectName === matchName && d.port === port);
    let domainHtml = '';
    let btnText = 'Dominio';
    if (domain) {
      domainHtml = `<a href="https://${escapeHtml(domain.fullDomain)}" target="_blank" class="domain-link" onclick="event.stopPropagation()">🌐 ${escapeHtml(domain.subdomain)}</a>`;
      btnText = 'Editar dominio';
    }
    return `<div class="port-line"><span class="badge badge-other">${port}</span>${domainHtml}<button class="btn-action" onclick="event.stopPropagation(); openDomainModal('${encodeURIComponent(projectName)}', ${port}, 'process')">${btnText}</button></div>`;
  }).join('');

  const projectCell = isSystem
    ? `<strong>${escapeHtml(p.name || projectName)}</strong>`
    : `<strong>${escapeHtml(p.projectName || projectName)}</strong><br><small class="text-muted">${escapeHtml(p.cwd)}</small>`;

  return `
    <td>${projectCell}</td>
    <td><span class="badge ${typeClass}">${p.type}</span></td>
    <td>${p.pid}</td>
    <td class="ports-cell">${portsHtml}</td>
    <td class="cmd-cell" title="${escapeHtml(p.cmd)}">${escapeHtml(p.cmd)}</td>
    <td class="actions">
      <button class="btn-danger" onclick="event.stopPropagation(); killProcess(${p.pid}, '${encodeURIComponent(projectName)}')">Kill</button>
    </td>
  `;
}

function renderProcesses(processes, domains) {
  const tbody = document.querySelector('#processes-table tbody');
  const empty = document.getElementById('processes-empty');
  tbody.innerHTML = '';

  if (processes.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const p of processes) {
    const tr = document.createElement('tr');
    tr.processData = p;
    tr.innerHTML = renderProcessRow(p, false, domains);
    tbody.appendChild(tr);
  }
}

function renderSystem(processes, domains) {
  const tbody = document.querySelector('#system-table tbody');
  const empty = document.getElementById('system-empty');
  tbody.innerHTML = '';

  if (processes.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const p of processes) {
    const tr = document.createElement('tr');
    tr.processData = p;
    tr.innerHTML = renderProcessRow(p, true, domains);
    tbody.appendChild(tr);
  }
}

function renderDocker(containers, domains) {
  const tbody = document.querySelector('#docker-table tbody');
  const empty = document.getElementById('docker-empty');
  tbody.innerHTML = '';

  if (containers.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const c of containers) {
    const tr = document.createElement('tr');
    const name = c.names.split(',')[0];
    let publicPorts = c.publicPorts || [];
    if (publicPorts.length === 0) {
      const parsed = parsePortFromDocker(c.ports);
      if (parsed) publicPorts = [parsed];
    }

    const portsHtml = publicPorts.length > 0
      ? publicPorts.map((port) => {
          const domain = (domains || []).find((d) => d.projectName === name && d.port === port);
          let domainHtml = '';
          let btnText = 'Dominio';
          if (domain) {
            domainHtml = `<a href="https://${escapeHtml(domain.fullDomain)}" target="_blank" class="domain-link" onclick="event.stopPropagation()">🌐 ${escapeHtml(domain.subdomain)}</a>`;
            btnText = 'Editar dominio';
          }
          return `<div class="port-line"><span class="badge badge-other">${port}</span>${domainHtml}<button class="btn-action" onclick="event.stopPropagation(); openDomainModal('${encodeURIComponent(name)}', ${port}, 'docker')">${btnText}</button></div>`;
        }).join('')
      : '<div class="port-line"><span class="badge badge-other">Ninguno</span></div>';

    tr.processData = { ...c, type: 'docker', name, projectName: name, ports: publicPorts };
    tr.innerHTML = `
      <td><strong>${escapeHtml(name)}</strong></td>
      <td><span class="badge badge-docker">docker</span></td>
      <td>${escapeHtml(c.id)}</td>
      <td class="ports-cell">${portsHtml}</td>
      <td>${escapeHtml(c.image)}<br><small class="text-muted">${escapeHtml(c.status)}</small></td>
      <td class="actions">
        <button class="btn-danger" onclick="event.stopPropagation(); stopDocker('${c.id}')">Stop</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function parsePortFromDocker(portsStr) {
  if (!portsStr) return null;
  const match = portsStr.match(/:(\d+)->/);
  return match ? parseInt(match[1], 10) : null;
}

function renderDomains(domains) {
  const tbody = document.querySelector('#domains-table tbody');
  const empty = document.getElementById('domains-empty');
  tbody.innerHTML = '';

  if (domains.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const d of domains) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a href="https://${d.fullDomain}" target="_blank" class="btn-action">${d.fullDomain}</a></td>
      <td>${escapeHtml(d.projectName)}</td>
      <td>${d.target}</td>
      <td>${new Date(d.createdAt).toLocaleString()}</td>
      <td class="actions">
        <button class="btn-danger" onclick="deleteDomain('${d.id}')">Eliminar</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Row click delegation
function handleRowClick(e) {
  if (e.target.closest('a, button')) return;
  const tr = e.target.closest('tr');
  if (tr && tr.processData) openDetailModal(tr.processData);
}

document.querySelector('#processes-table tbody').addEventListener('click', handleRowClick);
document.querySelector('#system-table tbody').addEventListener('click', handleRowClick);
document.querySelector('#docker-table tbody').addEventListener('click', handleRowClick);

// Kill modal
const killModal = document.getElementById('kill-modal');
let killTargetPid = null;

window.killProcess = function (pid, name) {
  killTargetPid = pid;
  const displayName = name ? decodeURIComponent(name) : pid;
  document.getElementById('kill-modal-info').textContent = `¿Matar el proceso ${displayName} (PID ${pid})?`;
  document.getElementById('kill-error').textContent = '';
  killModal.classList.remove('hidden');
};

document.getElementById('kill-cancel').addEventListener('click', () => {
  killModal.classList.add('hidden');
  killTargetPid = null;
});

document.getElementById('kill-confirm').addEventListener('click', async () => {
  if (!killTargetPid) return;
  try {
    await API.post(`/api/processes/${killTargetPid}/kill`);
    killModal.classList.add('hidden');
    killTargetPid = null;
    closeDetailModal();
    refresh();
  } catch (err) {
    document.getElementById('kill-error').textContent = err.message;
  }
});

killModal.addEventListener('click', (e) => {
  if (e.target === killModal) killModal.classList.add('hidden');
});

window.stopDocker = async function (id) {
  if (!confirm(`¿Detener el contenedor ${id}?`)) return;
  try {
    await API.post(`/api/docker/${id}/stop`);
    refresh();
  } catch (err) {
    alert(err.message);
  }
};

window.deleteDomain = async function (id) {
  if (!confirm('¿Eliminar este dominio?')) return;
  try {
    await API.delete(`/api/domains/${id}`);
    loadDomains();
  } catch (err) {
    alert(err.message);
  }
};

// Detail modal
const detailModal = document.getElementById('detail-modal');
let detailCurrentPid = null;
let detailCurrentProcess = null;
let detailStatsTimer = null;

function openDetailModal(p) {
  detailCurrentProcess = p;
  detailCurrentPid = p.pid || p.id;
  document.getElementById('detail-title').textContent = p.projectName || p.name;

  const matchName = p.projectName || p.name;
  const ports = (p.ports || []).map((port) => {
    const domain = cachedDomains.find((d) => d.projectName === matchName && d.port === port);
    if (domain) {
      return `<span class="badge badge-other">${port}</span><a href="https://${escapeHtml(domain.fullDomain)}" target="_blank" class="domain-link" onclick="event.stopPropagation()">🌐 ${escapeHtml(domain.subdomain)}</a>`;
    }
    return `<span class="badge badge-other">${port}</span>`;
  }).join(' ');

  if (p.type === 'docker') {
    document.getElementById('detail-meta').innerHTML = `<span class="badge badge-docker">docker</span> ID ${escapeHtml(p.id)} · ${ports}`;
  } else {
    document.getElementById('detail-meta').innerHTML = `<span class="badge badge-${p.type}">${p.type}</span> PID ${p.pid} · ${ports}`;
  }

  const firstPort = p.ports?.[0];
  const domainBtn = document.getElementById('detail-domain-btn');
  if (firstPort) {
    domainBtn.style.display = '';
    const existing = cachedDomains.find((d) => d.projectName === matchName && d.port === firstPort);
    domainBtn.textContent = existing ? 'Editar dominio' : 'Dominio';
    domainBtn.onclick = () => {
      openDomainModal(encodeURIComponent(matchName), firstPort, p.type === 'docker' ? 'docker' : 'process');
    };
  } else {
    domainBtn.style.display = 'none';
  }

  const killBtn = document.getElementById('detail-kill-btn');
  if (p.type === 'docker') {
    killBtn.textContent = 'Stop';
    killBtn.onclick = () => stopDocker(p.id);
  } else {
    killBtn.textContent = 'Kill';
    killBtn.onclick = () => killProcess(p.pid, matchName);
  }

  setDetailTab('info');
  detailModal.classList.remove('hidden');
  loadDetailInfo();
  startDetailStats();
}

function closeDetailModal() {
  detailModal.classList.add('hidden');
  stopDetailStats();
  detailCurrentPid = null;
  detailCurrentProcess = null;
}

function setDetailTab(tab) {
  document.querySelectorAll('.detail-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.detailTab === tab));
  document.querySelectorAll('.detail-tab-content').forEach((c) => c.classList.toggle('active', c.id === `detail-tab-${tab}`));
  if (tab === 'stats') loadDetailStats();
  if (tab === 'logs') loadDetailLogs();
}

async function loadDetailInfo() {
  if (!detailCurrentPid) return;
  if (detailCurrentProcess?.type === 'docker') {
    return loadDockerDetailInfo();
  }
  try {
    const info = await API.get(`/api/processes/${detailCurrentPid}/detail`);
    document.getElementById('detail-label-cwd').textContent = 'CWD';
    document.getElementById('detail-label-cmd').textContent = 'Comando completo';
    document.getElementById('detail-label-ppid').textContent = 'PPID';
    document.getElementById('detail-label-start').textContent = 'Inicio';
    document.getElementById('detail-label-runtime').textContent = 'Tipo de runtime';
    document.getElementById('detail-label-working-dir').textContent = 'Directorio de trabajo';

    document.getElementById('detail-cwd').textContent = info.cwd || '-';
    document.getElementById('detail-cmd').textContent = info.cmd || '-';
    document.getElementById('detail-ppid').textContent = info.ppid != null ? info.ppid : '-';
    document.getElementById('detail-start').textContent = info.startTime ? new Date(info.startTime).toLocaleString() : '-';
    document.getElementById('detail-runtime').textContent = info.type || detailCurrentProcess?.type || '-';
    document.getElementById('detail-working-dir').textContent = info.cwd || '-';

    const sourceSelect = document.getElementById('detail-logs-source');
    sourceSelect.innerHTML = '';
    if (info.logSources && info.logSources.length > 0) {
      info.logSources.forEach((src) => {
        const opt = document.createElement('option');
        opt.value = src.type === 'journal' ? `journal:${src.unit}` : src.path;
        opt.textContent = src.label;
        sourceSelect.appendChild(opt);
      });
      sourceSelect.classList.remove('hidden');
      document.getElementById('detail-logs-empty').classList.add('hidden');
    } else {
      sourceSelect.classList.add('hidden');
      document.getElementById('detail-logs-empty').classList.remove('hidden');
    }

    renderDetailEnv(info.env);
  } catch (err) {
    console.error('Failed to load detail info:', err);
  }
}

async function loadDockerDetailInfo() {
  try {
    const info = await API.get(`/api/docker/${detailCurrentPid}/detail`);
    document.getElementById('detail-label-cwd').textContent = 'Imagen';
    document.getElementById('detail-label-cmd').textContent = 'Puertos';
    document.getElementById('detail-label-ppid').textContent = 'Estado';
    document.getElementById('detail-label-start').textContent = 'Creado';
    document.getElementById('detail-label-runtime').textContent = 'Tipo';
    document.getElementById('detail-label-working-dir').textContent = 'ID';

    document.getElementById('detail-cwd').textContent = info.image || '-';
    document.getElementById('detail-cmd').textContent = info.ports || detailCurrentProcess?.ports?.join(', ') || '-';
    document.getElementById('detail-ppid').textContent = info.status || detailCurrentProcess?.status || '-';
    document.getElementById('detail-start').textContent = info.createdAt ? new Date(info.createdAt).toLocaleString() : '-';
    document.getElementById('detail-runtime').textContent = 'docker';
    document.getElementById('detail-working-dir').textContent = info.id || detailCurrentPid || '-';

    document.getElementById('detail-logs-source').classList.add('hidden');
    document.getElementById('detail-logs-empty').classList.add('hidden');

    renderDetailEnv(info.env);
  } catch (err) {
    console.error('Failed to load docker detail info:', err);
  }
}

function renderDetailEnv(env) {
  const tbody = document.querySelector('#detail-env-table tbody');
  tbody.innerHTML = '';
  if (!env || Object.keys(env).length === 0) {
    tbody.innerHTML = '<tr><td colspan="2" class="text-muted">Sin variables de entorno</td></tr>';
    return;
  }
  for (const [key, value] of Object.entries(env)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(key)}</td><td class="env-value">${escapeHtml(String(value))}</td>`;
    tbody.appendChild(tr);
  }
}

function formatUptime(seconds) {
  if (seconds == null || seconds < 0) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function loadDetailStats() {
  if (!detailCurrentPid) return;
  if (detailCurrentProcess?.type === 'docker') {
    return loadDockerDetailStats();
  }
  try {
    const { stats } = await API.get(`/api/processes/${detailCurrentPid}/stats`);
    document.getElementById('detail-stats-label-cpu').textContent = 'CPU';
    document.getElementById('detail-stats-label-memory').textContent = 'Memoria';
    document.getElementById('detail-stats-label-uptime').textContent = 'Uptime';
    document.getElementById('detail-stats-label-threads').textContent = 'Threads';

    document.getElementById('detail-stats-cpu').textContent = stats.cpuPercent != null ? `${stats.cpuPercent}%` : '-';
    document.getElementById('detail-stats-memory').textContent = stats.memoryMb != null ? `${stats.memoryMb} MB` : '-';
    document.getElementById('detail-stats-uptime').textContent = formatUptime(stats.uptimeSeconds);
    document.getElementById('detail-stats-threads').textContent = stats.threads != null ? stats.threads : '-';
  } catch (err) {
    console.error('Failed to load detail stats:', err);
  }
}

async function loadDockerDetailStats() {
  try {
    const { stats } = await API.get(`/api/docker/${detailCurrentPid}/stats`);
    document.getElementById('detail-stats-label-cpu').textContent = 'CPU';
    document.getElementById('detail-stats-label-memory').textContent = 'Memoria';
    document.getElementById('detail-stats-label-uptime').textContent = 'Network IO';
    document.getElementById('detail-stats-label-threads').textContent = 'Block IO / PIDs';

    document.getElementById('detail-stats-cpu').textContent = stats.cpuPercent != null ? `${stats.cpuPercent}%` : '-';

    const memUsage = stats.memoryUsage || stats.memoryMb || '-';
    const memLimit = stats.memoryLimit || '-';
    const memPercent = stats.memoryPercent != null ? `${stats.memoryPercent}%` : '-';
    document.getElementById('detail-stats-memory').textContent = typeof memUsage === 'number'
      ? `${formatBytes(memUsage)} / ${typeof memLimit === 'number' ? formatBytes(memLimit) : memLimit} (${memPercent})`
      : `${memUsage} / ${memLimit} (${memPercent})`;

    const netIO = stats.networkIO;
    if (typeof netIO === 'string') {
      document.getElementById('detail-stats-uptime').textContent = netIO;
    } else {
      const netRx = netIO?.rx ?? stats.networkRx ?? '-';
      const netTx = netIO?.tx ?? stats.networkTx ?? '-';
      document.getElementById('detail-stats-uptime').textContent = `${typeof netRx === 'number' ? formatBytes(netRx) : netRx} / ${typeof netTx === 'number' ? formatBytes(netTx) : netTx}`;
    }

    const blockIO = stats.blockIO;
    let blockText;
    if (typeof blockIO === 'string') {
      blockText = blockIO;
    } else {
      const blockRead = blockIO?.read ?? stats.blockRead ?? '-';
      const blockWrite = blockIO?.write ?? stats.blockWrite ?? '-';
      blockText = `${typeof blockRead === 'number' ? formatBytes(blockRead) : blockRead} / ${typeof blockWrite === 'number' ? formatBytes(blockWrite) : blockWrite}`;
    }
    const pids = stats.pids != null ? stats.pids : '-';
    document.getElementById('detail-stats-threads').textContent = `${blockText} · ${pids} PIDs`;
  } catch (err) {
    console.error('Failed to load docker detail stats:', err);
  }
}

function formatBytes(bytes) {
  if (bytes == null || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(2)} ${units[i]}`;
}

function startDetailStats() {
  stopDetailStats();
  loadDetailStats();
  detailStatsTimer = setInterval(loadDetailStats, 2000);
}

function stopDetailStats() {
  if (detailStatsTimer) clearInterval(detailStatsTimer);
  detailStatsTimer = null;
}

async function loadDetailLogs() {
  if (!detailCurrentPid) return;
  const pre = document.getElementById('detail-logs-pre');
  if (detailCurrentProcess?.type === 'docker') {
    return loadDockerDetailLogs();
  }
  const sourceSelect = document.getElementById('detail-logs-source');
  const source = sourceSelect.value || '';
  try {
    const data = await API.get(`/api/processes/${detailCurrentPid}/logs?source=${encodeURIComponent(source)}`);
    pre.textContent = Array.isArray(data.lines) ? data.lines.join('\n') : 'Sin logs disponibles';
  } catch (err) {
    console.error('Failed to load logs:', err);
    pre.textContent = `Error cargando logs: ${err.message}`;
  }
}

async function loadDockerDetailLogs() {
  const pre = document.getElementById('detail-logs-pre');
  try {
    const data = await API.get(`/api/docker/${detailCurrentPid}/logs`);
    pre.textContent = Array.isArray(data.lines) ? data.lines.join('\n') : 'Sin logs disponibles';
  } catch (err) {
    console.error('Failed to load docker logs:', err);
    pre.textContent = `Error cargando logs: ${err.message}`;
  }
}

document.querySelectorAll('.detail-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => setDetailTab(btn.dataset.detailTab));
});

document.getElementById('detail-close').addEventListener('click', closeDetailModal);
document.getElementById('detail-logs-reload').addEventListener('click', loadDetailLogs);
document.getElementById('detail-env-filter').addEventListener('input', (e) => {
  const term = e.target.value.toLowerCase();
  document.querySelectorAll('#detail-env-table tbody tr').forEach((tr) => {
    tr.style.display = tr.textContent.toLowerCase().includes(term) ? '' : 'none';
  });
});

detailModal.addEventListener('click', (e) => {
  if (e.target === detailModal) closeDetailModal();
});

// Domain modal
const modal = document.getElementById('domain-modal');
const domainForm = document.getElementById('domain-form');

window.openDomainModal = function (projectNameEncoded, port, type) {
  const titleEl = modal.querySelector('h3');
  const submitBtn = domainForm.querySelector('button[type="submit"]');
  const infoEl = document.getElementById('domain-modal-info');

  const projectName = decodeURIComponent(projectNameEncoded);
  const existingDomain = cachedDomains.find((d) => d.projectName === projectName && d.port === port);

  document.getElementById('domain-port').value = port;
  document.getElementById('domain-type').value = type;
  document.getElementById('domain-project').value = projectName;
  document.getElementById('domain-error').textContent = '';

  if (existingDomain) {
    document.getElementById('domain-input').value = existingDomain.subdomain || '';
    document.getElementById('domain-id').value = existingDomain.id || '';
    titleEl.textContent = 'Editar subdominio';
    submitBtn.textContent = 'Actualizar';
    infoEl.textContent = `Editar dominio para ${projectName} en puerto ${port}`;
  } else {
    document.getElementById('domain-input').value = '';
    document.getElementById('domain-id').value = '';
    titleEl.textContent = 'Asignar subdominio';
    submitBtn.textContent = 'Asignar';
    infoEl.textContent = `Asignar dominio para ${projectName} en puerto ${port}`;
  }

  modal.classList.remove('hidden');
  document.getElementById('domain-input').focus();
};

document.getElementById('domain-cancel').addEventListener('click', () => {
  modal.classList.add('hidden');
});

domainForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const subdomain = document.getElementById('domain-input').value;
  const port = parseInt(document.getElementById('domain-port').value, 10);
  const processType = document.getElementById('domain-type').value;
  const projectName = document.getElementById('domain-project').value;
  const domainId = document.getElementById('domain-id').value;
  const errorEl = document.getElementById('domain-error');

  try {
    if (domainId) {
      await API.put(`/api/domains/${domainId}`, { subdomain });
    } else {
      await API.post('/api/domains', { subdomain, port, processType, projectName });
    }
    modal.classList.add('hidden');
    loadDomains();
    refresh();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.classList.add('hidden');
});

// Init
checkAuth();
