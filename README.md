# Ports Manager

> Panel visual para gestionar proyectos de desarrollo, contenedores Docker y subdominios personalizados desde una sola interfaz web. Funciona con cualquier dominio que administres en Cloudflare.

[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Bun](https://img.shields.io/badge/Bun-000?logo=bun&logoColor=white)](https://bun.sh/)
[![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?logo=cloudflare&logoColor=white)](https://www.cloudflare.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 📸 Vista previa

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Ports Manager                                                               │
│ CPU 2%   RAM 21%   DISK 17%   LOAD 1.51                          binary ▾   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Desarrollo | Sistema | Docker | Dominios                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ Proyecto              Tipo   PID    Puerto(s)   Comando           Acciones │
│ portfolio-lucassabena node   112489 3005 🌐     next-server...     [Editar] │
│ app                   bun    210625 3457         bun run src/...   [Dominio]│
└─────────────────────────────────────────────────────────────────────────────┘
```

> **Click en cualquier fila** abre un modal con Info, Stats en tiempo real, Logs y variables de entorno.

---

## ✨ Características

- 🔍 **Descubrimiento automático** de procesos Node.js, Bun, Python y contenedores Docker con puertos abiertos.
- 🌐 **Asignación de subdominios** personalizados en un clic, integrado con Cloudflare DNS y Cloudflare Tunnel.
- 📊 **Estadísticas del servidor** en vivo: CPU, RAM, disco y load average.
- 📦 **Docker** con dominios asignados, logs, stats y env vars.
- 🖱️ **Detalle por proyecto/contenedor**: comando, CWD, CPU, memoria, uptime, threads, logs y env.
- ✏️ **Edición de dominios** sin eliminar y recrear.
- 🔒 **Autenticación** por cookie segura con sesiones firmadas.
- 🛡️ **Sanitización** automática de variables sensibles (tokens, keys, passwords).
- 📥 **Importación** masiva de dominios existentes desde la configuración remota del túnel de Cloudflare.
- 📁 **Proyectos**: descubrimiento automático de proyectos en disco, arranque/parada desde el panel, logs en tiempo real vía WebSocket.
- 🔧 **Configuración editable** desde la UI.
- 🔗 **Links local y network** para cada servicio.

---

## 🏗️ Arquitectura

```mermaid
flowchart TB
    subgraph Internet
        User[Navegador del usuario]
    end

    subgraph Cloudflare
        DNS[DNS CNAME<br/>*.tu-dominio.com]
        Tunnel[Cloudflare Tunnel]
    end

    subgraph Servidor
        PM[Ports Manager<br/>Bun + Hono :3457]
        Cloudflared[cloudflared]
        DockerSock[/var/run/docker.sock]
        ProcFs[/proc]
        Config[(data/config.json)]
    end

    User -->|HTTPS| DNS
    DNS --> Tunnel
    Tunnel --> Cloudflared
    Cloudflared --> PM
    PM -->|ss /proc| ProcFs
    PM -->|docker ps| DockerSock
    PM -->|REST| Cloudflare
    PM --> Config
```

---

## 🚀 Instalación

### Requisitos

- [Docker](https://docs.docker.com/engine/install/) + Docker Compose
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) ya configurado
- Credenciales de Cloudflare con permisos para DNS del dominio

### 1. Clonar el repositorio

```bash
git clone https://github.com/LucasSabena/ports-manager.git
cd ports-manager
```

### 2. Crear el archivo de entorno

```bash
cp .env.example .env
```

Editá `.env` con tus valores:

```env
CLOUDFLARE_EMAIL=tu-email@example.com
CLOUDFLARE_API_KEY=tu-api-key-global
CLOUDFLARE_API_TOKEN=          # opcional si usás API Key
CLOUDFLARE_ZONE_ID=tu-zone-id
CLOUDFLARE_ACCOUNT_ID=tu-account-id
CLOUDFLARE_TUNNEL_ID=tu-tunnel-id

# Dominio base para subdominios (ej. example.com -> app.example.com)
BASE_DOMAIN=tu-dominio.com

SESSION_SECRET=una-clave-larga-y-aleatoria
```

> **Nota:** La API Key global de Cloudflare tiene más permisos que un token; Ports Manager prioriza `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY`.

### 3. Crear la configuración inicial

```bash
cp data/config.example.json data/config.json
```

La primera vez que iniciés sesión con el usuario por defecto (`admin` / `admin`) se generará el hash de la contraseña.

> Cambiá la contraseña por una segura desde el mismo archivo `data/config.json` o borrando el hash para que se regenere.

### 4. Levantar con Docker Compose

Usá este servicio como ejemplo dentro de tu `docker-compose.yml`:

```yaml
services:
  ports-manager:
    build: ./ports-manager
    container_name: ports-manager
    restart: unless-stopped
    pid: host
    network_mode: host
    privileged: true
    env_file:
      - ./ports-manager/.env
    environment:
      PORT: 3457
      CONFIG_PATH: /app/data/config.json
      CLOUDFLARED_CONFIG: /app/cloudflared-config.yml
      CLOUDFLARE_ZONE_ID: ${CLOUDFLARE_ZONE_ID}
      CLOUDFLARE_ACCOUNT_ID: ${CLOUDFLARE_ACCOUNT_ID}
      CLOUDFLARE_TUNNEL_ID: ${CLOUDFLARE_TUNNEL_ID}
    volumes:
      - ./ports-manager/data:/app/data
      - ./ports-manager/public:/app/public:ro
      - ./cloudflared/config.yml:/app/cloudflared-config.yml
      - /var/run/docker.sock:/var/run/docker.sock
```

```bash
docker compose up -d --build ports-manager
```

### 5. Acceder

- Local: `http://localhost:3457`
- Público: agregá una entrada en tu Cloudflare Tunnel apuntando a `http://localhost:3457`
- Usuario por defecto: `admin` / `admin`

---

## 🔄 Actualización

```bash
cd ports-manager
git pull origin main
cd ..
docker compose up -d --build ports-manager
```

Tus dominios y configuración se guardan en `data/config.json`, que persiste fuera de la imagen.

---

## ⚙️ Configuración

### `data/config.json`

```json
{
  "auth": {
    "username": "admin",
    "passwordHash": "..."
  },
  "domains": [],
  "projects": [],
  "settings": {
    "scanIntervalMs": 5000,
    "protectedPids": [1, 2],
    "protectedPorts": [22, 80, 443, 9090, 9443],
    "ignoredPatterns": ["code-server", "openchamber"]
  }
}
```

| Campo | Descripción |
|-------|-------------|
| `scanIntervalMs` | Frecuencia de refresco de la UI |
| `protectedPids` | PIDs que no se pueden matar |
| `protectedPorts` | Puertos que no se muestran como asignables |
| `ignoredPatterns` | Procesos a ocultar en la pestaña Desarrollo |

### Variables de entorno

| Variable | Descripción |
|----------|-------------|
| `CLOUDFLARE_EMAIL` | Email de la cuenta Cloudflare (para API Key global) |
| `CLOUDFLARE_API_KEY` | API Key global de Cloudflare |
| `CLOUDFLARE_API_TOKEN` | API Token alternativo (no usado si hay API Key) |
| `CLOUDFLARE_ZONE_ID` | Zone ID del dominio en Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID de Cloudflare |
| `CLOUDFLARE_TUNNEL_ID` | Tunnel ID de Cloudflare |
| `BASE_DOMAIN` | Dominio base para subdominios (ej. `example.com`) |
| `SESSION_SECRET` | Clave para firmar cookies de sesión |

### Importar dominios existentes

Si ya tenés subdominios creados manualmente en Cloudflare, andá a la pestaña **Dominios** y usá el botón **Importar desde Cloudflare** (o llamá a `POST /api/domains/import`).

### Gestión de proyectos

La pestaña **Proyectos** descubre automáticamente directorios con `package.json` o `requirements.txt`. Desde allí podés:

- **Iniciar** un proyecto (`POST /api/projects/:id/start`).
- **Detener** un proyecto (`POST /api/projects/:id/stop`).
- Ver **logs en vivo** vía WebSocket (`/ws/projects/:id/logs`).
- Ver links **Local** (`http://localhost:<port>`) y **Network** (`http://<ip>:<port>`).

---

## 🔐 Seguridad

- Nunca commitees `data/config.json` ni `.env`.
- Las variables de entorno sensibles se ocultan automáticamente en la UI.
- El contenedor requiere `privileged: true`, `pid: host` y `network_mode: host` para poder leer `/proc`, usar `ss` y el socket de Docker.
- Ejecutá Ports Manager solo en redes privadas de confianza.

---

## 🛣️ Roadmap

- [x] Soporte para editar configuración desde la UI.
- [x] Histórico de logs con WebSocket.
- [x] Arrancar/parar proyectos desde el panel.
- [ ] Soporte multi-usuario con roles.
- [ ] Tests automatizados.

---

## 📄 Licencia

MIT © Lucas Sabena
