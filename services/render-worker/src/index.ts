import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { chromium, type Browser } from 'playwright';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { capturePromiseOutcome } from './promise-outcome.js';

const DATABASE_URL = requiredEnv('DATABASE_URL');
const RENDERER_URL = requiredEnv('RENDERER_URL');
const RENDER_QUEUE = process.env.RENDER_QUEUE ?? 'excalimate-render';
const RENDER_CONCURRENCY = integerEnv('RENDER_CONCURRENCY', 1);
const RENDER_TIMEOUT_MS = integerEnv('RENDER_TIMEOUT_MS', 30 * 60 * 1000);
const RENDER_JOB_TIMEOUT_SECONDS = integerEnv(
  'RENDER_JOB_TIMEOUT_SECONDS',
  60 * 60,
);
const RENDER_HEARTBEAT_SECONDS = integerEnv('RENDER_HEARTBEAT_SECONDS', 60);
const RENDER_RETRY_LIMIT = nonNegativeIntegerEnv('RENDER_RETRY_LIMIT', 2);
const PG_POOL_MAX = integerEnv(
  'PG_POOL_MAX',
  Math.max(4, RENDER_CONCURRENCY + 2),
);
const PGBOSS_POOL_MAX = integerEnv(
  'PGBOSS_POOL_MAX',
  Math.max(6, RENDER_CONCURRENCY + 4),
);

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: PG_POOL_MAX,
  application_name: 'excalimate-render-worker',
});
const boss = new PgBoss({
  connectionString: DATABASE_URL,
  max: PGBOSS_POOL_MAX,
  application_name: 'excalimate-render-worker-boss',
});
const s3 = new S3Client({
  region: process.env.REGION ?? 'auto',
  endpoint: requiredEnv('ENDPOINT'),
  forcePathStyle: process.env.BUCKET_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: requiredEnv('ACCESS_KEY_ID'),
    secretAccessKey: requiredEnv('SECRET_ACCESS_KEY'),
  },
});

let browser: Browser | null = null;
let shuttingDown = false;

type RenderJobData = {
  renderId: string;
};

type RenderRow = {
  id: string;
  project_id: string;
  project_version: string;
  document: unknown;
  status: string;
  options: {
    fps?: number;
    quality?: 'low' | 'medium' | 'high' | 'very-high';
    theme?: 'light' | 'dark';
  };
  output_key: string | null;
};

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

  await ensureBrowser();

  for (let slot = 0; slot < RENDER_CONCURRENCY; slot += 1) {
    await boss.work<RenderJobData>(
      RENDER_QUEUE,
      { batchSize: 1 },
      async (jobs) => {
        for (const job of jobs) {
          if (shuttingDown) {
            throw new Error('worker_shutting_down');
          }
          await processRender(job.data.renderId);
        }
      },
    );
  }

  console.log(
    `[excalimate-render-worker] ready with concurrency ${RENDER_CONCURRENCY}`,
  );
}

async function processRender(renderId: string): Promise<void> {
  const row = await getRender(renderId);
  if (!row) {
    console.warn(`[render] missing render row ${renderId}`);
    return;
  }
  if (row.status === 'completed' && row.output_key) {
    return;
  }

  await pool.query(
    `update excalimate_renders
        set status = 'processing',
            error = null,
            updated_at = now()
      where id = $1`,
    [renderId],
  );

  const workDir = await mkdtemp(
    path.join(os.tmpdir(), `excalimate-${renderId}-`),
  );
  const directMp4 = path.join(workDir, 'direct.mp4');
  const webm = path.join(workDir, 'fallback.webm');
  const finalMp4 = path.join(workDir, 'output.mp4');

  try {
    let directSucceeded = false;

    try {
      await browserExport(row.document, row.options, 'mp4', directMp4);
      const directStat = await stat(directMp4);
      if (directStat.size > 0) {
        directSucceeded = true;
      }
    } catch (error) {
      console.warn(
        `[render] native MP4 failed for ${renderId}; falling back to WebM + FFmpeg:`,
        error instanceof Error ? error.message : error,
      );
    }

    if (directSucceeded) {
      await copyFileStream(directMp4, finalMp4);
    } else {
      await browserExport(row.document, row.options, 'webm', webm);
      await transcodeWebmToMp4(webm, finalMp4);
    }

    const outputStat = await stat(finalMp4);
    if (outputStat.size <= 0) {
      throw new Error('empty_render_output');
    }

    const outputKey = `renders/${renderId}.mp4`;
    await new Upload({
      client: s3,
      params: {
        Bucket: requiredEnv('BUCKET'),
        Key: outputKey,
        Body: createReadStream(finalMp4),
        ContentType: 'video/mp4',
        CacheControl: 'private, max-age=0, no-store',
        Metadata: {
          renderId,
          projectId: row.project_id,
          projectVersion: row.project_version,
        },
      },
    }).done();

    await pool.query(
      `update excalimate_renders
          set status = 'completed',
              output_key = $2,
              output_bytes = $3,
              error = null,
              updated_at = now()
        where id = $1`,
      [renderId, outputKey, outputStat.size],
    );

    console.log(
      `[render] completed ${renderId} (${outputStat.size} bytes)`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    await pool.query(
      `update excalimate_renders
          set status = 'failed',
              error = $2,
              updated_at = now()
        where id = $1`,
      [renderId, message.slice(0, 4000)],
    );

    throw error;
  } finally {
    await Promise.allSettled([
      safeUnlink(directMp4),
      safeUnlink(webm),
      safeUnlink(finalMp4),
    ]);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function browserExport(
  document: unknown,
  options: RenderRow['options'],
  format: 'mp4' | 'webm',
  outputPath: string,
): Promise<void> {
  const currentBrowser = await ensureBrowser();
  const context = await currentBrowser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 720 },
  });

  const timeout = setTimeout(() => {
    void context.close().catch(() => undefined);
  }, RENDER_TIMEOUT_MS);

  try {
    const page = await context.newPage();
    const browserMessages: string[] = [];
    const rememberBrowserMessage = (message: string): void => {
      browserMessages.push(message);
      if (browserMessages.length > 20) browserMessages.shift();
    };

    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        rememberBrowserMessage(`console.${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      rememberBrowserMessage(`pageerror: ${error.message}`);
    });
    page.on('crash', () => {
      rememberBrowserMessage('page crashed');
    });

    page.setDefaultTimeout(Math.min(RENDER_TIMEOUT_MS, 120_000));
    page.setDefaultNavigationTimeout(120_000);

    console.log(`[render] opening renderer ${RENDERER_URL}`);
    await page.goto(RENDERER_URL, {
      waitUntil: 'networkidle',
      timeout: 120_000,
    });

    await page.waitForFunction(
      () =>
        typeof (
          window as unknown as {
            excalimateRenderer?: { render?: unknown };
          }
        ).excalimateRenderer?.render === 'function',
      undefined,
      { timeout: 120_000 },
    );

    // Attach a rejection handler immediately. If renderer.render() throws,
    // the finally block closes the context and Playwright rejects the pending
    // download event. A bare promise here becomes an unhandled rejection and
    // terminates Node before the job can be marked failed or use its fallback.
    const downloadOutcome = capturePromiseOutcome(
      page.waitForEvent('download', {
        timeout: RENDER_TIMEOUT_MS,
      }),
    );

    try {
      await page.evaluate(
        async ({ project, renderOptions }) => {
          const renderer = (
            window as unknown as {
              excalimateRenderer: {
                render: (
                  project: unknown,
                  options: {
                    format: 'mp4' | 'webm';
                    fps?: number;
                    quality?: 'low' | 'medium' | 'high' | 'very-high';
                    theme?: 'light' | 'dark';
                  },
                ) => Promise<{ ok: true }>;
              };
            }
          ).excalimateRenderer;

          await renderer.render(project, renderOptions);
        },
        {
          project: document,
          renderOptions: {
            format,
            fps: options.fps ?? 30,
            quality: options.quality ?? 'high',
            theme: options.theme ?? 'light',
          },
        },
      );
    } catch (error) {
      const detail = browserMessages.join(' | ');
      throw new Error(
        `renderer_evaluate_failed: ${errorMessage(error)}` +
          (detail ? `; browser: ${detail}` : ''),
        { cause: error },
      );
    }

    const outcome = await downloadOutcome;
    if (!outcome.ok) {
      const detail = browserMessages.join(' | ');
      throw new Error(
        `renderer_download_failed: ${errorMessage(outcome.error)}` +
          (detail ? `; browser: ${detail}` : ''),
        { cause: outcome.error },
      );
    }

    const download = outcome.value;
    await download.saveAs(outputPath);

    const failure = await download.failure();
    if (failure) {
      throw new Error(`browser_download_failed: ${failure}`);
    }
  } catch (error) {
    if (!currentBrowser.isConnected()) {
      browser = null;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    await context.close().catch(() => undefined);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensureBrowser(): Promise<Browser> {
  if (browser?.isConnected()) {
    return browser;
  }

  const rendererOrigin = new URL(RENDERER_URL).origin;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-background-networking',
      '--enable-features=WebCodecs',
      `--unsafely-treat-insecure-origin-as-secure=${rendererOrigin}`,
    ],
  });

  browser.on('disconnected', () => {
    browser = null;
  });

  return browser;
}

async function transcodeWebmToMp4(
  input: string,
  output: string,
): Promise<void> {
  await runProcess('ffmpeg', [
    '-y',
    '-i',
    input,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    output,
  ]);
}

async function runProcess(
  command: string,
  args: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 16_000) {
        stderr = stderr.slice(-16_000);
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}: ${stderr}`,
          ),
        );
      }
    });
  });
}

async function copyFileStream(
  source: string,
  destination: string,
): Promise<void> {
  const { createWriteStream } = await import('node:fs');

  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(source);
    const output = createWriteStream(destination);
    input.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    input.pipe(output);
  });
}

async function getRender(id: string): Promise<RenderRow | null> {
  const { rows } = await pool.query<RenderRow>(
    `select id, project_id, project_version::text,
            document, status, options, output_key
       from excalimate_renders
      where id = $1`,
    [id],
  );
  return rows[0] ?? null;
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

    create unique index if not exists excalimate_renders_request_key_idx
      on excalimate_renders(project_id, request_key)
      where request_key is not null;
  `);
}

async function safeUnlink(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }
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

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  await boss
    .stop({ graceful: true, timeout: 30_000 })
    .catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});

main().catch((error) => {
  console.error('[excalimate-render-worker] startup failed', error);
  process.exit(1);
});
