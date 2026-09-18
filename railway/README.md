# Excalimate on Railway

This fork adds a production topology for using Excalimate as a private,
scalable whiteboard-video source from VidBlitz or another application.

## Services

| Railway resource | Purpose | Public? | Scaling |
| --- | --- | --- | --- |
| `excalimate-web` | Excalimate editor + private render runtime | Optional | 1+ replicas |
| `excalimate-api` | REST API + stateless project-bound MCP | Yes for VidBlitz | Horizontal |
| `excalimate-render-worker` | Chromium/WebCodecs + FFmpeg renders | No | Horizontal |
| PostgreSQL | Projects, checkpoints, renders, PgBoss | No | Managed |
| Storage Bucket | Images and finished MP4 files | Private | Managed |

The VidBlitz path has no Cloudflare runtime dependency.

## Why the MCP can scale

Upstream Excalimate's HTTP MCP stores session state in a process-local Map.
That is appropriate for its local authoring workflow, but it cannot be safely
replicated behind a load balancer without sticky sessions.

This fork adds a project-bound stateless endpoint:

```text
POST /mcp/:projectId
```

For every MCP request the API:

1. Loads the canonical V2 project from PostgreSQL.
2. Creates a fresh stateless Streamable HTTP MCP transport.
3. Runs the normal Excalimate MCP tools.
4. Persists a successful mutation back to PostgreSQL using optimistic
   concurrency.

Any API replica can therefore handle any request.

## Image workflow

The Railway MCP adds:

- `add_image_from_url`
- `add_image_from_asset`

For generated images, the preferred flow is:

1. `POST /v1/assets/presign`
2. Upload directly to the Railway Storage Bucket.
3. Tell the agent the returned asset key.
4. Agent calls `add_image_from_asset`.

This keeps binary payloads out of MCP requests.

## Render workflow

```text
VidBlitz / Agent
     |
POST /v1/projects/:id/renders
     |
Postgres snapshot + PgBoss job
     |
any render-worker replica
     |
Playwright -> render.html -> Excalimate native exporter
     |
MP4, or WebM -> FFmpeg H.264 fallback
     |
Railway Storage Bucket
     |
GET /v1/renders/:id -> signed URL
```

A render row stores the exact project document and project version at queue
time. Later edits cannot alter an already queued render.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for setup.
