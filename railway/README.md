# Excalimate on Railway

This fork runs Excalimate as an independent, scalable animation/render service.
VidBlitz is the first client, but the API and MCP are intentionally client-
agnostic so the same deployment can be used by ChatGPT, Codex, Claude Code,
other MCP agents, or a future standalone Excalimate application.

## Services

| Railway resource | Purpose | Public? | Scaling |
| --- | --- | --- | --- |
| `excalimate-web` | Excalimate editor + private render runtime | Optional | Horizontal |
| `excalimate-api` | REST API + global stateless MCP | Yes | Horizontal |
| `excalimate-render-worker` | Chromium/WebCodecs + FFmpeg renders | No | Horizontal |
| PostgreSQL | Temporary projects, checkpoints, renders, PgBoss | No | Managed |
| Storage Bucket | Temporary image staging + rendered MP4s | Private | Managed |

Application containers are disposable. Durable working state lives in
PostgreSQL and the bucket, so any API replica can handle any request.

## Canonical MCP endpoint

Use one MCP endpoint everywhere:

```text
POST https://<api-domain>/mcp
Authorization: Bearer <SERVICE_API_KEY>
```

The global endpoint exposes lifecycle tools such as:

- `create_project`
- `get_project`
- `delete_project`

All native Excalimate project-specific tools automatically require a
`projectId` argument. A typical agent flow is:

```text
create_project
    -> projectId
create_scene(projectId, ...)
add_elements(projectId, ...)
auto_animate(projectId, ...)
queue_render(projectId, ...)
get_render_status(projectId, renderId)
    -> temporary signed MP4 URL
```

The server does not keep an "active project" in process memory. Every
project-specific tool call loads the requested project from PostgreSQL and
successful mutations use optimistic concurrency before they are returned to
the agent. This makes the endpoint portable across ChatGPT, Codex, Claude,
VidBlitz, and other MCP clients without sticky sessions.

### Legacy compatibility

The project-bound endpoint remains available:

```text
POST /mcp/:projectId
```

It is retained for compatibility only. New integrations should use `/mcp`.

## Temporary state, caller-owned assets

An Excalimate project is animation working state, not a customer/tenant record.
There is no user/workspace/tenant model in this deployment.

By default temporary projects expire after 24 hours. The cleanup process skips
projects with queued/processing renders and removes completed render objects
when an expired project is deleted.

Permanent assets and final videos should be copied into the calling
application's storage. For VidBlitz, the final MP4 belongs in the normal
VidBlitz asset library.

## Authentication

The canonical MCP endpoint supports two authentication paths without changing
the tool or project model.

### Service API key

VidBlitz, backend jobs, scripts, Codex/Claude configurations that can store a
secret, and other server-to-server clients can continue to use:

```http
Authorization: Bearer <SERVICE_API_KEY>
```

`X-API-Key` is also accepted for service-key MCP clients and the REST API.
OAuth access tokens are intentionally **not** accepted on `/v1`; REST remains
service-to-service.

### OAuth 2.1 + PKCE

User-facing MCP hosts such as ChatGPT can discover and authorize against the
same endpoint:

```text
https://<api-domain>/mcp
```

The API publishes:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/oauth/authorize
/oauth/token
/oauth/register
/oauth/revoke
```

The flow uses Authorization Code + PKCE S256, resource indicators bound to the
canonical MCP URL, RFC 9207 issuer responses, short-lived opaque access tokens,
rotating refresh tokens, Client ID Metadata Documents (CIMD) as the preferred
client identity mechanism, and Dynamic Client Registration (DCR) as a
compatibility fallback.

There is still no Excalimate user/tenant model. The OAuth authorization page
uses a separate operator password (`OAUTH_LOGIN_PASSWORD`) and a signed
HttpOnly authorization-session cookie. Do not reuse `SERVICE_API_KEY` as that
password.

## Image workflow

The MCP provides:

- `add_image_from_url`
- `add_image_from_asset`

For caller-owned images, prefer a temporary accessible URL and
`add_image_from_url`. The bucket presign endpoint remains available when
temporary upload staging is useful.

## Render workflow

```text
Agent / VidBlitz
     |
global /mcp or REST API
     |
Postgres project snapshot + PgBoss job
     |
any render-worker replica
     |
Playwright -> render.html -> Excalimate exporter
     |
MP4, or WebM -> FFmpeg H.264 fallback
     |
Railway Storage Bucket
     |
temporary signed URL
     |
caller copies final video to permanent storage
```

A render row stores the exact project document/version at queue time. Later
edits cannot change an already queued render.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment details.
