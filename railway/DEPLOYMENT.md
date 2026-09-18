# Railway deployment

## Recommended topology

Create one Railway project in one region initially.

Add:

1. PostgreSQL
2. One Railway Storage Bucket
3. `excalimate-web`
4. `excalimate-api`
5. `excalimate-render-worker`

Do not attach Railway Volumes. Every application container is disposable.

## 1. Web service

Source: this repository

Dockerfile:

```text
Dockerfile.web
```

Health check:

```text
/healthz
```

Port: `8080`

The web service can stay private unless you want to use the editor manually.
The render worker should use Railway private networking:

```text
http://excalimate-web.railway.internal:8080/render.html
```

If your Railway service name differs, change the hostname accordingly.

## 2. API service

Dockerfile:

```text
Dockerfile.api
```

Give this service a public domain. It is an independent Excalimate API, not a
VidBlitz-specific backend. Protect every `/v1` and `/mcp` request with the
same long, random `SERVICE_API_KEY`.

Required variables:

```text
DATABASE_URL
SERVICE_API_KEY
BUCKET
ACCESS_KEY_ID
SECRET_ACCESS_KEY
REGION
ENDPOINT
```

Recommended:

```text
PUBLIC_BASE_URL=https://your-api-domain
PG_POOL_MAX=5
PGBOSS_POOL_MAX=4
RENDER_QUEUE=excalimate-render
RENDER_JOB_TIMEOUT_SECONDS=3600
RENDER_HEARTBEAT_SECONDS=60
RENDER_RETRY_LIMIT=2
MAX_IMAGE_BYTES=4194304
TEMP_PROJECT_TTL_HOURS=24
PROJECT_CLEANUP_INTERVAL_MINUTES=15
PROJECT_CLEANUP_BATCH=50
```

The API initializes its own Excalimate tables and PgBoss schema/queue.

## 3. Render worker

Dockerfile:

```text
Dockerfile.worker
```

Do not create a public domain.

Variables:

```text
DATABASE_URL
RENDERER_URL=http://excalimate-web.railway.internal:8080/render.html

BUCKET
ACCESS_KEY_ID
SECRET_ACCESS_KEY
REGION
ENDPOINT

RENDER_QUEUE=excalimate-render
RENDER_CONCURRENCY=1
RENDER_TIMEOUT_MS=1800000
RENDER_JOB_TIMEOUT_SECONDS=3600
RENDER_HEARTBEAT_SECONDS=60
RENDER_RETRY_LIMIT=2

PG_POOL_MAX=4
PGBOSS_POOL_MAX=6
```

Start with one render concurrently per replica. Chromium + 1080p WebCodecs
exports are memory/CPU-heavy. Scale the worker service by adding replicas
before increasing `RENDER_CONCURRENCY`.

## 4. Bucket

Use a Railway Storage Bucket and reference its S3-compatible variables into
the API and worker services.

Objects:

```text
assets/...       # source/generated images
renders/...      # final MP4 files
```

The API returns presigned upload URLs for assets and one-hour presigned
download URLs for completed renders. The bucket itself remains private.

## 5. Universal MCP integration

Use the same endpoint for VidBlitz, ChatGPT, Codex, Claude Code, or another
MCP-capable agent:

```text
https://your-api-domain/mcp
```

Authenticate with:

```http
Authorization: Bearer <SERVICE_API_KEY>
```

The first tool call for a new animation is normally `create_project`. The
returned `projectId` is supplied to every project-specific native Excalimate
tool:

```text
create_project
create_scene(projectId, ...)
auto_animate(projectId, ...)
queue_render(projectId, ...)
get_render_status(projectId, renderId)
```

The canonical endpoint is stateless at the API-container layer. There is no
server-side "active project" session. Tool calls hydrate temporary working
state from PostgreSQL, and successful mutations persist with optimistic
concurrency.

For backward compatibility, `/mcp/:projectId` remains available, but new
integrations should use `/mcp`.

REST remains available for deterministic application-to-application flows:

```http
POST /v1/projects
Authorization: Bearer <SERVICE_API_KEY>
Content-Type: application/json

{
  "name": "visual-shot-42"
}
```

The response now returns `mcpUrl` pointing at the canonical `/mcp` endpoint
and `legacyMcpUrl` for the project-bound compatibility endpoint.

VidBlitz should copy completed MP4s into its own asset library. Excalimate's
database and bucket are temporary working/render state, not permanent customer
asset storage.

Temporary projects expire automatically after `TEMP_PROJECT_TTL_HOURS`
(default 24). Cleanup skips queued/processing renders and deletes completed
render objects along with expired project state.

## Scaling

The API is stateless and may run multiple replicas. It does not require sticky
sessions.

Render workers are the main scaling knob:

```text
1 -> 2 -> 4 -> 8 ... replicas
```

Keep `RENDER_CONCURRENCY=1` until profiling proves a replica has enough spare
RAM/CPU for multiple Chromium exports.

Keep API/worker PostgreSQL pools deliberately small. Total connection usage is
approximately:

```text
API replicas * (PG_POOL_MAX + PGBOSS_POOL_MAX)
+ worker replicas * (PG_POOL_MAX + PGBOSS_POOL_MAX)
```

Leave headroom for Railway/Postgres administration and PgBoss maintenance.

## Upstream Excalimate sync

Do not overwrite this fork with upstream. The Railway additions are kept
largely outside upstream directories, with only small integration changes in
`vite.config.ts` and MCP state-context support.

The included `upstream-sync.yml` workflow checks upstream and opens a sync PR.
Conflicts are intentionally surfaced for review instead of force-merging.

## Original Excalimate sharing

The VidBlitz/API/render path does not need Excalimate's original encrypted
Cloudflare Share Worker.

The upstream editor's optional manual **Share** feature is not part of this
Railway backend. Do not depend on it for VidBlitz projects. If manual public
sharing is needed later, implement a Railway-backed share endpoint separately
rather than silently using upstream infrastructure.
