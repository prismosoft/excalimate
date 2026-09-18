import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';
import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import helmet from 'helmet';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  parseProjectDocument,
  type ProjectDocument,
} from '../../../packages/project-schema/dist/index.js';
import {
  createDefaultState,
  createServer,
  type CheckpointStore,
  type ServerState,
} from '../../../mcp-server/dist/library.js';

const PORT = integerEnv('PORT', 3000);
const DATABASE_URL = requiredEnv('DATABASE_URL');
const SERVICE_API_KEY = requiredEnv('SERVICE_API_KEY');
const RENDER_QUEUE = process.env.RENDER_QUEUE ?? 'excalimate-render';
const RENDER_JOB_TIMEOUT_SECONDS = integerEnv(
  'RENDER_JOB_TIMEOUT_SECONDS',
  60 * 60,
);
const RENDER_HEARTBEAT_SECONDS = integerEnv('RENDER_HEARTBEAT_SECONDS', 60);
const RENDER_RETRY_LIMIT = nonNegativeIntegerEnv('RENDER_RETRY_LIMIT', 2);
const MAX_IMAGE_BYTES = integerEnv('MAX_IMAGE_BYTES', 4 * 1024 * 1024);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
const PG_POOL_MAX = integerEnv('PG_POOL_MAX', 5);
const PGBOSS_POOL_MAX = integerEnv('PGBOSS_POOL_MAX', 4);

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: PG_POOL_MAX,
  application_name: 'excalimate-api',
});
const boss = new PgBoss({
  connectionString: DATABASE_URL,
  max: PGBOSS_POOL_MAX,
  application_name: 'excalimate-api-boss',
});
const s3 = createS3Client();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '32mb', strict: true }));

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.status(200).json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

function authorize(req: Request, res: ExpressResponse, next: NextFunction): void {
  const auth = req.get('authorization');
  const token = auth?.startsWith('Bearer ')
    ? auth.slice(7)
    : req.get('x-api-key');

  if (token && safeEqual(token, SERVICE_API_KEY)) {
    next();
    return;
  }

  res.status(401).json({ error: 'unauthorized' });
}

app.use('/v1', authorize);
app.use('/mcp', authorize);

const projectCreateSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  project: z.unknown().optional(),
});

app.post(
  '/v1/projects',
  asyncHandler(async (req, res) => {
    const input = projectCreateSchema.parse(req.body ?? {});
    const id = `prj_${nanoid(18)}`;
    const original = input.project
      ? parseProjectDocument(input.project)
      : createDefaultState();
    const now = new Date().toISOString();
    const document = parseProjectDocument({
      ...original,
      metadata: {
        ...original.metadata,
        id,
        name: input.name ?? original.metadata.name,
        createdAt: original.metadata.createdAt ?? now,
        updatedAt: now,
      },
    });

    await pool.query(
      `insert into excalimate_projects (id, document, version)
       values ($1, $2::jsonb, 1)`,
      [id, JSON.stringify(document)],
    );

    res.status(201).json({
      id,
      version: 1,
      mcpUrl: `${baseUrl(req)}/mcp/${id}`,
    });
  }),
);

app.get(
  '/v1/projects/:id',
  asyncHandler(async (req, res) => {
    const project = await loadProject(routeParam(req, 'id'));
    if (!project) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    res.json(project);
  }),
);

const replaceProjectSchema = z.object({
  project: z.unknown(),
  expectedVersion: z.number().int().positive().optional(),
});

app.put(
  '/v1/projects/:id',
  asyncHandler(async (req, res) => {
    const input = replaceProjectSchema.parse(req.body);
    const existing = await loadProject(routeParam(req, 'id'));
    if (!existing) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }

    const document = withCanonicalProjectId(
      routeParam(req, 'id'),
      parseProjectDocument(input.project),
    );
    const expected = input.expectedVersion ?? existing.version;
    const version = await persistProject(
      routeParam(req, 'id'),
      document,
      expected,
    );
    res.json({ id: routeParam(req, 'id'), version });
  }),
);

const renderOptionsSchema = z.object({
  fps: z.number().int().min(1).max(60).default(30),
  quality: z
    .enum(['low', 'medium', 'high', 'very-high'])
    .default('high'),
  theme: z.enum(['light', 'dark']).default('light'),
});

app.post(
  '/v1/projects/:id/renders',
  asyncHandler(async (req, res) => {
    const options = renderOptionsSchema.parse(req.body ?? {});
    const idempotencyKey = parseIdempotencyKey(req.get('idempotency-key'));
    const render = await enqueueRender(
      routeParam(req, 'id'),
      options,
      idempotencyKey,
    );
    res.status(render.reused ? 200 : 202).json(render);
  }),
);

app.get(
  '/v1/renders/:id',
  asyncHandler(async (req, res) => {
    const render = await getRender(routeParam(req, 'id'));
    if (!render) {
      res.status(404).json({ error: 'render_not_found' });
      return;
    }
    res.json(await publicRender(render));
  }),
);

const presignSchema = z.object({
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  extension: z.enum(['png', 'jpg', 'jpeg', 'webp']),
});

app.post(
  '/v1/assets/presign',
  asyncHandler(async (req, res) => {
    const input = presignSchema.parse(req.body);
    const key = `assets/${nanoid(24)}.${input.extension}`;
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucketName(),
        Key: key,
        ContentType: input.contentType,
      }),
      { expiresIn: 15 * 60 },
    );

    res.status(201).json({
      key,
      uploadUrl: url,
      expiresIn: 900,
    });
  }),
);

// Project-bound stateless MCP. Every request reconstructs the MCP server around
// the canonical project persisted in PostgreSQL. Any Railway API replica can
// therefore handle any request without sticky sessions.
app.post(
  '/mcp/:projectId',
  asyncHandler(async (req, res) => {
    const row = await loadProject(routeParam(req, 'projectId'));
    if (!row) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Project not found' },
        id: null,
      });
      return;
    }

    let expectedVersion = row.version;
    const checkpointStore = new DbCheckpointStore(routeParam(req, 'projectId'));
    const server = createServer(checkpointStore, undefined, {
      initialState: row.document as ServerState,
      initialRevision: row.version,
      initialSequence: row.version,
      onPersist: async (state) => {
        expectedVersion = await persistProject(
          routeParam(req, 'projectId'),
          state,
          expectedVersion,
        );
      },
    });

    registerRailwayTools(server.stateContext, routeParam(req, 'projectId'));

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    const close = () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    res.on('close', close);

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }),
);

for (const method of ['get', 'delete'] as const) {
  app[method]('/mcp/:projectId', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed for stateless JSON-response MCP',
      },
      id: null,
    });
  });
}

app.use(
  (
    error: unknown,
    _req: Request,
    res: ExpressResponse,
    _next: NextFunction,
  ) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'invalid_request',
        details: error.issues,
      });
      return;
    }

    const message =
      error instanceof Error ? error.message : 'internal_error';

    if (message === 'project_conflict') {
      res.status(409).json({ error: 'project_conflict' });
      return;
    }
    if (message === 'project_not_found') {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    if (message === 'image_too_large') {
      res.status(413).json({ error: 'image_too_large' });
      return;
    }
    if (
      message === 'unsupported_image_type' ||
      message === 'private_host_rejected' ||
      message === 'unsupported_url_protocol' ||
      message === 'url_credentials_rejected'
    ) {
      res.status(400).json({ error: message });
      return;
    }

    console.error('[excalimate-api]', error);
    res.status(500).json({ error: 'internal_error' });
  },
);

async function main(): Promise<void> {
  await initSchema();

  boss.on('error', (error) => {
    console.error('[pg-boss]', error);
  });
  await boss.start();
  await boss.createQueue(RENDER_QUEUE);
  await boss.updateQueue(RENDER_QUEUE, {
    expireInSeconds: RENDER_JOB_TIMEOUT_SECONDS,
    heartbeatSeconds: RENDER_HEARTBEAT_SECONDS,
    retryLimit: RENDER_RETRY_LIMIT,
    retryDelay: 5,
    retryBackoff: true,
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[excalimate-api] listening on :${PORT}`);
  });

  const shutdown = async () => {
    server.close();
    await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
    await pool.end().catch(() => undefined);
  };

  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
}

function registerRailwayTools(
  ctx: ReturnType<typeof createServer>['stateContext'],
  projectId: string,
): void {
  ctx.mutatingTool(
    'add_image_from_asset',
    'Attach an image previously uploaded to the Railway Storage Bucket and add it to the Excalidraw scene.',
    {
      assetKey: z.string().regex(/^assets\/[A-Za-z0-9._/-]+$/),
      id: z.string().min(1).max(128).optional(),
      x: z.number().finite().default(0),
      y: z.number().finite().default(0),
      width: z.number().positive().max(10_000).default(640),
      height: z.number().positive().max(10_000).default(360),
      link: z.string().url().optional(),
    },
    async ({ assetKey, id, x, y, width, height, link }) => {
      const image = await readBucketImage(assetKey);
      const result = attachImage(
        ctx.getState(),
        image.bytes,
        image.contentType,
        { id, x, y, width, height, link },
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: `Added image ${result.elementId} from ${assetKey}.`,
          },
        ],
      };
    },
    ['scene'],
  );

  ctx.mutatingTool(
    'add_image_from_url',
    'Download a public HTTP/HTTPS PNG, JPEG, or WebP image with SSRF protections, embed it in the project, and add it to the scene.',
    {
      url: z.string().url(),
      id: z.string().min(1).max(128).optional(),
      x: z.number().finite().default(0),
      y: z.number().finite().default(0),
      width: z.number().positive().max(10_000).default(640),
      height: z.number().positive().max(10_000).default(360),
    },
    async ({ url, id, x, y, width, height }) => {
      const image = await fetchSafeImage(url);
      const result = attachImage(
        ctx.getState(),
        image.bytes,
        image.contentType,
        {
          id,
          x,
          y,
          width,
          height,
          link: url,
        },
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: `Added image ${result.elementId} from ${url}.`,
          },
        ],
      };
    },
    ['scene'],
  );

  ctx.tool(
    'queue_render',
    'Queue the current persisted project for an MP4 render. Render workers scale independently from the MCP/API service.',
    {
      fps: z.number().int().min(1).max(60).default(30),
      quality: z
        .enum(['low', 'medium', 'high', 'very-high'])
        .default('high'),
      theme: z.enum(['light', 'dark']).default('light'),
    },
    async (args) => {
      const options = renderOptionsSchema.parse(args);
      const render = await enqueueRender(projectId, options);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(render),
          },
        ],
      };
    },
  );

  ctx.tool(
    'get_render_status',
    'Get render status and, when complete, a temporary signed download URL.',
    {
      renderId: z.string().min(1).max(128),
    },
    async ({ renderId }) => {
      const render = await getRender(renderId);
      if (!render || render.project_id !== projectId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Render not found.',
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(await publicRender(render)),
          },
        ],
      };
    },
  );
}

type ImagePlacement = {
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  link?: string;
};

function attachImage(
  state: ServerState,
  bytes: Buffer,
  contentType: string,
  placement: ImagePlacement,
): { elementId: string; fileId: string } {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('image_too_large');
  }

  const detected = detectImageMime(bytes);
  if (!detected || detected !== contentType) {
    throw new Error('unsupported_image_type');
  }

  const fileId = `file_${nanoid(20)}`;
  const elementId = placement.id ?? `img_${nanoid(16)}`;
  const now = Date.now();
  const randomInt = () => crypto.randomInt(1, 2_147_483_646);
  const dataURL = `data:${contentType};base64,${bytes.toString('base64')}`;

  state.scene.files[fileId] = {
    id: fileId,
    mimeType: contentType,
    dataURL,
    created: now,
    lastRetrieved: now,
  } as never;

  state.scene.elements.push({
    id: elementId,
    type: 'image',
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    angle: 0,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a${state.scene.elements.length.toString(36).padStart(8, '0')}`,
    roundness: null,
    seed: randomInt(),
    version: 1,
    versionNonce: randomInt(),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: placement.link ?? null,
    locked: false,
    fileId,
    status: 'saved',
    scale: [1, 1],
    crop: null,
  } as never);

  return { elementId, fileId };
}

async function fetchSafeImage(
  rawUrl: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  let url = new URL(rawUrl);

  for (let redirect = 0; redirect <= 3; redirect += 1) {
    await assertPublicUrl(url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'Excalimate-Railway/1.0',
          accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5',
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirect === 3) {
          throw new Error('image_redirect_rejected');
        }
        url = new URL(location, url);
        continue;
      }

      if (!response.ok) {
        throw new Error(`image_fetch_failed_${response.status}`);
      }

      const declared = Number(
        response.headers.get('content-length') ?? '0',
      );
      if (
        Number.isFinite(declared) &&
        declared > MAX_IMAGE_BYTES
      ) {
        throw new Error('image_too_large');
      }

      const bytes = await readResponseBuffer(
        response,
        MAX_IMAGE_BYTES,
      );
      const detected = detectImageMime(bytes);
      if (!detected) {
        throw new Error('unsupported_image_type');
      }

      return {
        bytes,
        contentType: detected,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('image_redirect_rejected');
}

async function readResponseBuffer(
  response: globalThis.Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error('image_too_large');
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('image_too_large');
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

function detectImageMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return 'image/png';
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('unsupported_url_protocol');
  }
  if (url.username || url.password) {
    throw new Error('url_credentials_rejected');
  }

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('private_host_rejected');
  }

  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, {
        all: true,
        verbatim: true,
      });

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error('private_host_rejected');
  }
}

function isPublicAddress(address: string): boolean {
  if (address.includes(':')) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '::') return false;
    if (
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return false;
    }
    if (normalized.startsWith('::ffff:')) {
      return isPublicAddress(normalized.slice(7));
    }
    return true;
  }

  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some(
      (part) =>
        !Number.isInteger(part) ||
        part < 0 ||
        part > 255,
    )
  ) {
    return false;
  }

  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

async function readBucketImage(
  key: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: key,
    }),
  );

  if (
    result.ContentLength !== undefined &&
    result.ContentLength > MAX_IMAGE_BYTES
  ) {
    throw new Error('image_too_large');
  }

  const bytes = await bodyToBuffer(result.Body);
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('image_too_large');
  }

  const detected = detectImageMime(bytes);
  if (!detected) {
    throw new Error('unsupported_image_type');
  }

  return {
    bytes,
    contentType: detected,
  };
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) throw new Error('empty_object_body');

  const maybe = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
  };
  if (maybe.transformToByteArray) {
    return Buffer.from(await maybe.transformToByteArray());
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

type RenderOptions = z.infer<typeof renderOptionsSchema>;

async function enqueueRender(
  projectId: string,
  options: RenderOptions,
  requestKey?: string,
) {
  const project = await loadProject(projectId);
  if (!project) throw new Error('project_not_found');

  if (requestKey) {
    const existing = await getRenderByRequestKey(
      projectId,
      requestKey,
    );
    if (existing) {
      return {
        ...(await publicRender(existing)),
        reused: true,
      };
    }
  }

  const renderId = `rnd_${nanoid(20)}`;
  const insert = await pool.query<{ id: string }>(
    `insert into excalimate_renders
       (id, project_id, project_version, document, status, options, request_key)
     values
       ($1, $2, $3, $4::jsonb, 'queued', $5::jsonb, $6)
     on conflict do nothing
     returning id`,
    [
      renderId,
      projectId,
      project.version,
      JSON.stringify(project.document),
      JSON.stringify(options),
      requestKey ?? null,
    ],
  );

  if (insert.rowCount !== 1) {
    if (!requestKey) {
      throw new Error('render_insert_conflict');
    }
    const existing = await getRenderByRequestKey(
      projectId,
      requestKey,
    );
    if (!existing) {
      throw new Error('render_insert_conflict');
    }
    return {
      ...(await publicRender(existing)),
      reused: true,
    };
  }

  try {
    await boss.send(RENDER_QUEUE, { renderId });
  } catch (error) {
    await pool.query(
      `delete from excalimate_renders where id = $1`,
      [renderId],
    ).catch(() => undefined);
    throw error;
  }

  return {
    id: renderId,
    projectId,
    projectVersion: project.version,
    status: 'queued' as const,
    reused: false,
  };
}

type RenderRow = {
  id: string;
  project_id: string;
  project_version: string;
  status: string;
  options: unknown;
  output_key: string | null;
  output_bytes: string | null;
  error: string | null;
  request_key: string | null;
  created_at: string;
  updated_at: string;
};

async function getRender(id: string): Promise<RenderRow | null> {
  const { rows } = await pool.query<RenderRow>(
    `select id, project_id, project_version::text, status, options,
            output_key, output_bytes::text, error, request_key,
            created_at::text, updated_at::text
       from excalimate_renders
      where id = $1`,
    [id],
  );

  return rows[0] ?? null;
}

async function getRenderByRequestKey(
  projectId: string,
  requestKey: string,
): Promise<RenderRow | null> {
  const { rows } = await pool.query<RenderRow>(
    `select id, project_id, project_version::text, status, options,
            output_key, output_bytes::text, error, request_key,
            created_at::text, updated_at::text
       from excalimate_renders
      where project_id = $1 and request_key = $2
      limit 1`,
    [projectId, requestKey],
  );
  return rows[0] ?? null;
}

async function publicRender(render: RenderRow) {
  let url: string | undefined;

  if (
    render.status === 'completed' &&
    render.output_key
  ) {
    url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: render.output_key,
      }),
      { expiresIn: 60 * 60 },
    );
  }

  return {
    id: render.id,
    projectId: render.project_id,
    projectVersion: Number(render.project_version),
    status: render.status,
    options: render.options,
    bytes: render.output_bytes
      ? Number(render.output_bytes)
      : undefined,
    error: render.error ?? undefined,
    url,
    urlExpiresIn: url ? 3600 : undefined,
    createdAt: render.created_at,
    updatedAt: render.updated_at,
  };
}

async function loadProject(
  id: string,
): Promise<{
  id: string;
  document: ProjectDocument;
  version: number;
} | null> {
  const { rows } = await pool.query<{
    id: string;
    document: unknown;
    version: string;
  }>(
    `select id, document, version::text
       from excalimate_projects
      where id = $1`,
    [id],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    document: parseProjectDocument(row.document),
    version: Number(row.version),
  };
}

async function persistProject(
  id: string,
  document: unknown,
  expectedVersion: number,
): Promise<number> {
  const parsed = withCanonicalProjectId(
    id,
    parseProjectDocument(document),
  );
  const result = await pool.query<{ version: string }>(
    `update excalimate_projects
        set document = $1::jsonb,
            version = version + 1,
            updated_at = now()
      where id = $2 and version = $3
      returning version::text`,
    [JSON.stringify(parsed), id, expectedVersion],
  );

  if (result.rowCount !== 1) {
    throw new Error('project_conflict');
  }

  return Number(result.rows[0]!.version);
}

function withCanonicalProjectId(
  id: string,
  document: ProjectDocument,
): ProjectDocument {
  return parseProjectDocument({
    ...document,
    metadata: {
      ...document.metadata,
      id,
      updatedAt: new Date().toISOString(),
    },
  });
}

class DbCheckpointStore implements CheckpointStore {
  constructor(private readonly projectId: string) {}

  async save(id: string, data: ServerState): Promise<void> {
    validateCheckpointId(id);
    await pool.query(
      `insert into excalimate_checkpoints
         (project_id, id, document)
       values ($1, $2, $3::jsonb)
       on conflict (project_id, id)
       do update
         set document = excluded.document,
             updated_at = now()`,
      [
        this.projectId,
        id,
        JSON.stringify(parseProjectDocument(data)),
      ],
    );

    await pool.query(
      `delete from excalimate_checkpoints
        where project_id = $1
          and id in (
            select id
              from excalimate_checkpoints
             where project_id = $1
             order by updated_at desc
             offset 100
          )`,
      [this.projectId],
    );
  }

  async load(id: string): Promise<ServerState | null> {
    validateCheckpointId(id);
    const { rows } = await pool.query<{ document: unknown }>(
      `select document
         from excalimate_checkpoints
        where project_id = $1 and id = $2`,
      [this.projectId, id],
    );

    return rows[0]
      ? (parseProjectDocument(rows[0].document) as ServerState)
      : null;
  }

  async list(): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `select id
         from excalimate_checkpoints
        where project_id = $1
        order by updated_at desc
        limit 100`,
      [this.projectId],
    );
    return rows.map((row) => row.id);
  }
}

function validateCheckpointId(id: string): void {
  if (
    !/^[A-Za-z0-9_-]+$/.test(id) ||
    id.length > 64
  ) {
    throw new Error('invalid_checkpoint_id');
  }
}

async function initSchema(): Promise<void> {
  await pool.query(`
    create table if not exists excalimate_projects (
      id text primary key,
      document jsonb not null,
      version bigint not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists excalimate_renders (
      id text primary key,
      project_id text not null
        references excalimate_projects(id)
        on delete cascade,
      project_version bigint not null,
      document jsonb not null,
      status text not null
        check (status in ('queued', 'processing', 'completed', 'failed')),
      options jsonb not null default '{}'::jsonb,
      request_key text,
      output_key text,
      output_bytes bigint,
      error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index if not exists excalimate_renders_project_idx
      on excalimate_renders(project_id, created_at desc);

    create unique index if not exists excalimate_renders_request_key_idx
      on excalimate_renders(project_id, request_key)
      where request_key is not null;

    create table if not exists excalimate_checkpoints (
      project_id text not null
        references excalimate_projects(id)
        on delete cascade,
      id text not null,
      document jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (project_id, id)
    );
  `);
}

function createS3Client(): S3Client {
  return new S3Client({
    region: process.env.REGION ?? 'auto',
    endpoint: requiredEnv('ENDPOINT'),
    forcePathStyle:
      process.env.BUCKET_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: requiredEnv('ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('SECRET_ACCESS_KEY'),
    },
  });
}

function bucketName(): string {
  return requiredEnv('BUCKET');
}

function baseUrl(req: Request): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;

  const proto =
    req.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    req.protocol;
  return `${proto}://${req.get('host')}`;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('invalid_route_parameter');
  }
  return value;
}

function parseIdempotencyKey(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 128
  ) {
    throw new Error('invalid_idempotency_key');
  }
  return normalized;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}`,
    );
  }
  return value;
}

function integerEnv(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function nonNegativeIntegerEnv(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return (
    aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb)
  );
}

function asyncHandler(
  handler: (
    req: Request,
    res: ExpressResponse,
    next: NextFunction,
  ) => Promise<void>,
) {
  return (
    req: Request,
    res: ExpressResponse,
    next: NextFunction,
  ) => {
    void handler(req, res, next).catch(next);
  };
}

main().catch((error) => {
  console.error('[excalimate-api] startup failed', error);
  process.exit(1);
});
