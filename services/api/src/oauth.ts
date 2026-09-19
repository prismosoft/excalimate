import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import express, {
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
  type Router,
} from 'express';
import type { Pool, PoolClient } from 'pg';

const OAUTH_SCOPE = 'mcp';
const CLIENT_METADATA_MAX_BYTES = 64 * 1024;
const AUTH_SESSION_COOKIE = 'excalimate_oauth_session';

export interface OAuthSupportOptions {
  pool: Pool;
  issuer: string;
  resource: string;
  loginPassword?: string;
  loginPasswordHash?: string;
  sessionSecret: string;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  authorizationCodeTtlSeconds?: number;
  sessionTtlSeconds?: number;
}

export interface OAuthSupport {
  router: Router;
  initSchema: () => Promise<void>;
  cleanup: () => Promise<void>;
  validateAccessToken: (token: string) => Promise<boolean>;
  challenge: (res: ExpressResponse, error?: 'invalid_token') => void;
}

type OAuthClient = {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
};

type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  state?: string;
  scope: string;
  resource: string;
  codeChallenge: string;
};

type AuthorizationCodeRow = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  expires_at: Date;
  used_at: Date | null;
};

type OAuthTokenRow = {
  client_id: string;
  scope: string;
  resource: string;
  expires_at: Date;
  refresh_expires_at: Date;
  revoked_at: Date | null;
};

class OAuthProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function createOAuthSupport(options: OAuthSupportOptions): OAuthSupport {
  const issuer = canonicalHttpsUrl(options.issuer, 'issuer');
  const resource = canonicalHttpsUrl(options.resource, 'resource');
  const accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 3600;
  const refreshTokenTtlSeconds = options.refreshTokenTtlSeconds ?? 30 * 24 * 3600;
  const authorizationCodeTtlSeconds = options.authorizationCodeTtlSeconds ?? 300;
  const sessionTtlSeconds = options.sessionTtlSeconds ?? 30 * 24 * 3600;
  const metadataUrl = `${issuer}/.well-known/oauth-protected-resource`;
  const router = express.Router();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();

  router.use(express.urlencoded({ extended: false, limit: '32kb' }));

  const protectedResourceMetadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Excalimate MCP',
  };

  const authorizationServerMetadata = {
    issuer,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    client_id_metadata_document_supported: true,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [OAUTH_SCOPE],
  };

  const metadataHandler = (_req: Request, res: ExpressResponse) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=300');
    res.json(protectedResourceMetadata);
  };
  router.get('/.well-known/oauth-protected-resource', metadataHandler);
  router.get('/.well-known/oauth-protected-resource/mcp', metadataHandler);

  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=300');
    res.json(authorizationServerMetadata);
  });

  const authorizeGet = asyncHandler(async (req, res) => {
    const request = await parseAuthorizationRequest(req.query, resource, options.pool);
    const client = await resolveOAuthClient(options.pool, request.clientId);
    const authenticated = hasValidSession(req, options.sessionSecret);
    res
      .status(200)
      .type('html')
      .send(
        renderAuthorizationPage(
          request,
          client.clientName,
          false,
          authenticated,
        ),
      );
  });

  const authorizePost = asyncHandler(async (req, res) => {
    const request = await parseAuthorizationRequest(req.body, resource, options.pool);
    const client = await resolveOAuthClient(options.pool, request.clientId);

    if (!hasValidSession(req, options.sessionSecret)) {
      enforceLoginRateLimit(req, loginAttempts);
      const password = formString(req.body, 'password', 4096);
      if (!password || !verifyAuthorizationPassword(
        password,
        options.loginPasswordHash,
        options.loginPassword,
      )) {
        recordFailedLogin(req, loginAttempts);
        res
          .status(401)
          .type('html')
          .send(renderAuthorizationPage(request, client.clientName, true, false));
        return;
      }
      clearFailedLogin(req, loginAttempts);
      setSessionCookie(
        res,
        options.sessionSecret,
        sessionTtlSeconds,
      );
    }

    await issueAuthorizationCodeAndRedirect(
      options.pool,
      request,
      issuer,
      authorizationCodeTtlSeconds,
      res,
    );
  });

  router.get('/oauth/authorize', authorizeGet);
  router.post('/oauth/authorize', authorizePost);
  // Compatibility aliases for older OAuth/MCP clients.
  router.get('/authorize', authorizeGet);
  router.post('/authorize', authorizePost);

  const registerHandler = asyncHandler(async (req, res) => {
    const input = parseDynamicClientRegistration(req.body);
    const clientId = `mcp_client_${randomToken(24)}`;
    await options.pool.query(
      `insert into excalimate_oauth_clients
         (client_id, redirect_uris, client_name, metadata)
       values ($1, $2::jsonb, $3, $4::jsonb)`,
      [
        clientId,
        JSON.stringify(input.redirectUris),
        input.clientName ?? null,
        JSON.stringify(input.metadata),
      ],
    );

    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: input.redirectUris,
      client_name: input.clientName,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  router.post('/oauth/register', registerHandler);
  router.post('/register', registerHandler);

  const tokenHandler = asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');

    if (req.get('authorization')?.startsWith('Basic ')) {
      throw new OAuthProtocolError(
        'invalid_client',
        'This authorization server supports public OAuth clients with PKCE.',
        401,
      );
    }

    const grantType = formString(req.body, 'grant_type', 128);
    if (grantType === 'authorization_code') {
      const payload = await exchangeAuthorizationCode(
        options.pool,
        req.body,
        {
          resource,
          accessTokenTtlSeconds,
          refreshTokenTtlSeconds,
        },
      );
      res.json(payload);
      return;
    }

    if (grantType === 'refresh_token') {
      const payload = await exchangeRefreshToken(
        options.pool,
        req.body,
        {
          resource,
          accessTokenTtlSeconds,
          refreshTokenTtlSeconds,
        },
      );
      res.json(payload);
      return;
    }

    throw new OAuthProtocolError(
      'unsupported_grant_type',
      'Supported grants are authorization_code and refresh_token.',
    );
  });

  router.post('/oauth/token', tokenHandler);
  router.post('/token', tokenHandler);

  const revokeHandler = asyncHandler(async (req, res) => {
    const token = formString(req.body, 'token', 4096);
    if (token) {
      const hash = hashToken(token);
      await options.pool.query(
        `update excalimate_oauth_tokens
            set revoked_at = coalesce(revoked_at, now()),
                updated_at = now()
          where access_token_hash = $1
             or refresh_token_hash = $1`,
        [hash],
      );
    }
    res.status(200).end();
  });

  router.post('/oauth/revoke', revokeHandler);

  router.use((
    error: unknown,
    req: Request,
    res: ExpressResponse,
    next: NextFunction,
  ) => {
    if (!(error instanceof OAuthProtocolError)) {
      next(error);
      return;
    }

    if (req.path === '/oauth/authorize' || req.path === '/authorize') {
      void tryAuthorizationErrorRedirect(
        options.pool,
        req,
        res,
        error,
        issuer,
      ).catch(next);
      return;
    }

    res.status(error.status).json({
      error: error.code,
      error_description: error.message,
    });
  });

  return {
    router,
    initSchema: async () => {
      await options.pool.query(`
        create table if not exists excalimate_oauth_clients (
          client_id text primary key,
          redirect_uris jsonb not null,
          client_name text,
          metadata jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );

        create table if not exists excalimate_oauth_codes (
          code_hash text primary key,
          client_id text not null,
          redirect_uri text not null,
          code_challenge text not null,
          scope text not null,
          resource text not null,
          expires_at timestamptz not null,
          used_at timestamptz,
          created_at timestamptz not null default now()
        );

        create index if not exists excalimate_oauth_codes_expiry_idx
          on excalimate_oauth_codes(expires_at);

        create table if not exists excalimate_oauth_tokens (
          access_token_hash text primary key,
          refresh_token_hash text unique not null,
          client_id text not null,
          scope text not null,
          resource text not null,
          expires_at timestamptz not null,
          refresh_expires_at timestamptz not null,
          revoked_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );

        create index if not exists excalimate_oauth_tokens_access_expiry_idx
          on excalimate_oauth_tokens(expires_at);

        create index if not exists excalimate_oauth_tokens_refresh_expiry_idx
          on excalimate_oauth_tokens(refresh_expires_at);
      `);
    },
    cleanup: async () => {
      await options.pool.query(
        `delete from excalimate_oauth_codes
          where expires_at < now() - interval '1 hour'
             or used_at < now() - interval '1 hour'`,
      );
      await options.pool.query(
        `delete from excalimate_oauth_tokens
          where refresh_expires_at < now() - interval '1 day'
             or revoked_at < now() - interval '1 day'`,
      );
      const now = Date.now();
      for (const [key, attempt] of loginAttempts) {
        if (attempt.resetAt <= now) loginAttempts.delete(key);
      }
    },
    validateAccessToken: async (token: string) => {
      const { rows } = await options.pool.query<{
        scope: string;
        resource: string;
      }>(
        `select scope, resource
           from excalimate_oauth_tokens
          where access_token_hash = $1
            and revoked_at is null
            and expires_at > now()
          limit 1`,
        [hashToken(token)],
      );
      const row = rows[0];
      return Boolean(
        row &&
          row.resource === resource &&
          scopeSet(row.scope).has(OAUTH_SCOPE),
      );
    },
    challenge: (res, error) => {
      const params = [
        `resource_metadata="${metadataUrl}"`,
        `scope="${OAUTH_SCOPE}"`,
      ];
      if (error) params.push(`error="${error}"`);
      res.set('WWW-Authenticate', `Bearer ${params.join(', ')}`);
    },
  };
}

async function tryAuthorizationErrorRedirect(
  pool: Pool,
  req: Request,
  res: ExpressResponse,
  error: OAuthProtocolError,
  issuer: string,
): Promise<void> {
  const source = req.method === 'GET' ? objectLike(req.query) : objectLike(req.body);
  const clientId = formString(source, 'client_id', 2048);
  const redirectUri = formString(source, 'redirect_uri', 4096);
  const state = formString(source, 'state', 2048);

  if (clientId && redirectUri) {
    try {
      const client = await resolveOAuthClient(pool, clientId);
      if (client.redirectUris.includes(redirectUri)) {
        const redirect = new URL(redirectUri);
        redirect.searchParams.set('error', error.code);
        redirect.searchParams.set('error_description', error.message);
        if (state) redirect.searchParams.set('state', state);
        redirect.searchParams.set('iss', issuer);
        res.redirect(302, redirect.toString());
        return;
      }
    } catch {
      // An invalid client/redirect URI must never receive an authorization redirect.
    }
  }

  res.status(error.status).json({
    error: error.code,
    error_description: error.message,
    iss: issuer,
  });
}

async function parseAuthorizationRequest(
  source: unknown,
  expectedResource: string,
  pool: Pool,
): Promise<AuthorizationRequest> {
  const body = objectLike(source);
  const responseType = formString(body, 'response_type', 64);
  if (responseType !== 'code') {
    throw new OAuthProtocolError(
      'unsupported_response_type',
      'Only response_type=code is supported.',
    );
  }

  const clientId = requiredFormString(body, 'client_id', 2048);
  const redirectUri = requiredFormString(body, 'redirect_uri', 4096);
  const codeChallenge = requiredFormString(body, 'code_challenge', 256);
  const codeChallengeMethod = requiredFormString(
    body,
    'code_challenge_method',
    32,
  );

  if (codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    throw new OAuthProtocolError(
      'invalid_request',
      'PKCE code_challenge_method=S256 is required.',
    );
  }

  const scope = normalizeScope(formString(body, 'scope', 2048));
  const requestedResource =
    formString(body, 'resource', 4096) ?? expectedResource;
  if (requestedResource !== expectedResource) {
    throw new OAuthProtocolError(
      'invalid_target',
      'The requested OAuth resource does not match this MCP server.',
    );
  }

  const client = await resolveOAuthClient(pool, clientId);
  if (!client.redirectUris.includes(redirectUri)) {
    throw new OAuthProtocolError(
      'invalid_request',
      'redirect_uri is not registered for this OAuth client.',
    );
  }

  return {
    clientId,
    redirectUri,
    state: formString(body, 'state', 2048),
    scope,
    resource: requestedResource,
    codeChallenge,
  };
}

async function issueAuthorizationCodeAndRedirect(
  pool: Pool,
  request: AuthorizationRequest,
  issuer: string,
  ttlSeconds: number,
  res: ExpressResponse,
): Promise<void> {
  const code = `exa_code_${randomToken(32)}`;
  await pool.query(
    `insert into excalimate_oauth_codes
       (code_hash, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
     values
       ($1, $2, $3, $4, $5, $6, now() + ($7::double precision * interval '1 second'))`,
    [
      hashToken(code),
      request.clientId,
      request.redirectUri,
      request.codeChallenge,
      request.scope,
      request.resource,
      ttlSeconds,
    ],
  );

  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set('code', code);
  if (request.state) redirect.searchParams.set('state', request.state);
  redirect.searchParams.set('iss', issuer);
  res.redirect(302, redirect.toString());
}

async function exchangeAuthorizationCode(
  pool: Pool,
  source: unknown,
  config: {
    resource: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  },
): Promise<Record<string, unknown>> {
  const body = objectLike(source);
  const code = requiredFormString(body, 'code', 4096);
  const clientId = requiredFormString(body, 'client_id', 2048);
  const redirectUri = requiredFormString(body, 'redirect_uri', 4096);
  const verifier = requiredFormString(body, 'code_verifier', 256);
  const requestedResource =
    formString(body, 'resource', 4096) ?? config.resource;

  if (requestedResource !== config.resource) {
    throw new OAuthProtocolError('invalid_target', 'OAuth resource mismatch.');
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<AuthorizationCodeRow>(
      `select client_id, redirect_uri, code_challenge, scope, resource,
              expires_at, used_at
         from excalimate_oauth_codes
        where code_hash = $1
        for update`,
      [hashToken(code)],
    );
    const row = rows[0];
    if (
      !row ||
      row.used_at ||
      row.expires_at.getTime() <= Date.now() ||
      row.client_id !== clientId ||
      row.redirect_uri !== redirectUri ||
      row.resource !== config.resource ||
      !verifyPkceS256(verifier, row.code_challenge)
    ) {
      throw new OAuthProtocolError(
        'invalid_grant',
        'Authorization code is invalid, expired, consumed, or PKCE verification failed.',
      );
    }

    await client.query(
      `update excalimate_oauth_codes
          set used_at = now()
        where code_hash = $1`,
      [hashToken(code)],
    );

    const payload = await issueTokenPair(
      client,
      {
        clientId,
        scope: row.scope,
        resource: row.resource,
      },
      config.accessTokenTtlSeconds,
      config.refreshTokenTtlSeconds,
    );
    await client.query('commit');
    return payload;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function exchangeRefreshToken(
  pool: Pool,
  source: unknown,
  config: {
    resource: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  },
): Promise<Record<string, unknown>> {
  const body = objectLike(source);
  const refreshToken = requiredFormString(body, 'refresh_token', 4096);
  const clientId = requiredFormString(body, 'client_id', 2048);
  const requestedResource =
    formString(body, 'resource', 4096) ?? config.resource;

  if (requestedResource !== config.resource) {
    throw new OAuthProtocolError('invalid_target', 'OAuth resource mismatch.');
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<OAuthTokenRow>(
      `select client_id, scope, resource, expires_at, refresh_expires_at, revoked_at
         from excalimate_oauth_tokens
        where refresh_token_hash = $1
        for update`,
      [hashToken(refreshToken)],
    );
    const row = rows[0];
    if (
      !row ||
      row.revoked_at ||
      row.refresh_expires_at.getTime() <= Date.now() ||
      row.client_id !== clientId ||
      row.resource !== config.resource
    ) {
      throw new OAuthProtocolError(
        'invalid_grant',
        'Refresh token is invalid, expired, or revoked.',
      );
    }

    const requestedScope = formString(body, 'scope', 2048);
    const scope = requestedScope ? normalizeScope(requestedScope) : row.scope;
    if (!isScopeSubset(scope, row.scope)) {
      throw new OAuthProtocolError(
        'invalid_scope',
        'Refresh requests cannot expand the originally granted scope.',
      );
    }

    const accessToken = `exa_at_${randomToken(32)}`;
    const nextRefreshToken = `exa_rt_${randomToken(40)}`;
    await client.query(
      `update excalimate_oauth_tokens
          set access_token_hash = $1,
              refresh_token_hash = $2,
              scope = $3,
              expires_at = now() + ($4::double precision * interval '1 second'),
              refresh_expires_at = now() + ($5::double precision * interval '1 second'),
              updated_at = now()
        where refresh_token_hash = $6`,
      [
        hashToken(accessToken),
        hashToken(nextRefreshToken),
        scope,
        config.accessTokenTtlSeconds,
        config.refreshTokenTtlSeconds,
        hashToken(refreshToken),
      ],
    );
    await client.query('commit');

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlSeconds,
      refresh_token: nextRefreshToken,
      scope,
      resource: row.resource,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function issueTokenPair(
  client: PoolClient,
  grant: {
    clientId: string;
    scope: string;
    resource: string;
  },
  accessTokenTtlSeconds: number,
  refreshTokenTtlSeconds: number,
): Promise<Record<string, unknown>> {
  const accessToken = `exa_at_${randomToken(32)}`;
  const refreshToken = `exa_rt_${randomToken(40)}`;

  await client.query(
    `insert into excalimate_oauth_tokens
       (access_token_hash, refresh_token_hash, client_id, scope, resource,
        expires_at, refresh_expires_at)
     values
       ($1, $2, $3, $4, $5,
        now() + ($6::double precision * interval '1 second'),
        now() + ($7::double precision * interval '1 second'))`,
    [
      hashToken(accessToken),
      hashToken(refreshToken),
      grant.clientId,
      grant.scope,
      grant.resource,
      accessTokenTtlSeconds,
      refreshTokenTtlSeconds,
    ],
  );

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: accessTokenTtlSeconds,
    refresh_token: refreshToken,
    scope: grant.scope,
    resource: grant.resource,
  };
}

async function resolveOAuthClient(
  pool: Pool,
  clientId: string,
): Promise<OAuthClient> {
  if (clientId.startsWith('https://')) {
    return fetchClientMetadataDocument(clientId);
  }

  const { rows } = await pool.query<{
    client_id: string;
    redirect_uris: unknown;
    client_name: string | null;
  }>(
    `select client_id, redirect_uris, client_name
       from excalimate_oauth_clients
      where client_id = $1
      limit 1`,
    [clientId],
  );
  const row = rows[0];
  if (!row) {
    throw new OAuthProtocolError('invalid_client', 'Unknown OAuth client.', 401);
  }

  return {
    clientId: row.client_id,
    redirectUris: parseRedirectUris(row.redirect_uris),
    clientName: row.client_name ?? undefined,
  };
}

async function fetchClientMetadataDocument(
  clientId: string,
): Promise<OAuthClient> {
  const url = new URL(clientId);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new OAuthProtocolError(
      'invalid_client',
      'CIMD client_id must be an HTTPS metadata document URL.',
      401,
    );
  }

  await assertPublicHttpsUrl(url);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'user-agent': 'Excalimate-OAuth/1.0',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OAuthProtocolError(
      'invalid_client',
      'Unable to fetch the client metadata document.',
      401,
    );
  }

  if (!response.ok) {
    throw new OAuthProtocolError(
      'invalid_client',
      'Client metadata document returned a non-success response.',
      401,
    );
  }

  const text = await readTextLimited(response, CLIENT_METADATA_MAX_BYTES);
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OAuthProtocolError(
      'invalid_client',
      'Client metadata document is not valid JSON.',
      401,
    );
  }

  if (
    typeof metadata.client_id === 'string' &&
    metadata.client_id !== clientId
  ) {
    throw new OAuthProtocolError(
      'invalid_client',
      'Client metadata client_id does not match its document URL.',
      401,
    );
  }

  const redirectUris = parseRedirectUris(metadata.redirect_uris);
  const methods = Array.isArray(metadata.token_endpoint_auth_methods_supported)
    ? metadata.token_endpoint_auth_methods_supported.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : typeof metadata.token_endpoint_auth_method === 'string'
      ? [metadata.token_endpoint_auth_method]
      : ['none'];
  if (!methods.includes('none')) {
    throw new OAuthProtocolError(
      'invalid_client',
      'This server requires a public OAuth client supporting token endpoint auth method "none".',
      401,
    );
  }

  return {
    clientId,
    redirectUris,
    clientName:
      typeof metadata.client_name === 'string'
        ? metadata.client_name.slice(0, 256)
        : undefined,
  };
}

function parseDynamicClientRegistration(source: unknown): {
  redirectUris: string[];
  clientName?: string;
  metadata: Record<string, unknown>;
} {
  const body = objectLike(source);
  const redirectUris = parseRedirectUris(body.redirect_uris);
  const method =
    typeof body.token_endpoint_auth_method === 'string'
      ? body.token_endpoint_auth_method
      : 'none';
  if (method !== 'none') {
    throw new OAuthProtocolError(
      'invalid_client_metadata',
      'Only token_endpoint_auth_method=none is supported.',
    );
  }

  if (
    Array.isArray(body.response_types) &&
    !body.response_types.includes('code')
  ) {
    throw new OAuthProtocolError(
      'invalid_client_metadata',
      'response_types must support code.',
    );
  }

  if (
    Array.isArray(body.grant_types) &&
    !body.grant_types.includes('authorization_code')
  ) {
    throw new OAuthProtocolError(
      'invalid_client_metadata',
      'grant_types must support authorization_code.',
    );
  }

  const clientName =
    typeof body.client_name === 'string'
      ? body.client_name.slice(0, 256)
      : undefined;

  return {
    redirectUris,
    clientName,
    metadata: body,
  };
}

function parseRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new OAuthProtocolError(
      'invalid_client',
      'OAuth client must publish 1-20 redirect_uris.',
      401,
    );
  }

  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length > 4096) {
      throw new OAuthProtocolError(
        'invalid_client',
        'Invalid redirect_uri metadata.',
        401,
      );
    }
    validateRedirectUri(entry);
    return entry;
  });
}

export function validateRedirectUri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthProtocolError('invalid_client', 'Invalid redirect URI.', 401);
  }

  if (url.username || url.password || url.hash) {
    throw new OAuthProtocolError('invalid_client', 'Unsafe redirect URI.', 401);
  }

  if (url.protocol === 'https:') return;

  if (
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  ) {
    return;
  }

  throw new OAuthProtocolError(
    'invalid_client',
    'Redirect URIs must use HTTPS except for loopback native-client callbacks.',
    401,
  );
}

async function assertPublicHttpsUrl(url: URL): Promise<void> {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new OAuthProtocolError('invalid_client', 'Private client metadata host.', 401);
  }

  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true, verbatim: true });

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new OAuthProtocolError('invalid_client', 'Private client metadata host.', 401);
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

async function readTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OAuthProtocolError('invalid_client', 'Client metadata is too large.', 401);
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new OAuthProtocolError('invalid_client', 'Client metadata is too large.', 401);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new OAuthProtocolError('invalid_client', 'Client metadata is too large.', 401);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

export function normalizeScope(raw?: string): string {
  const requested = (raw ?? OAUTH_SCOPE)
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unique = [...new Set(requested)];
  if (unique.length !== 1 || unique[0] !== OAUTH_SCOPE) {
    throw new OAuthProtocolError(
      'invalid_scope',
      `Supported scope: ${OAUTH_SCOPE}`,
    );
  }
  return OAUTH_SCOPE;
}

function isScopeSubset(requested: string, granted: string): boolean {
  const requestedSet = scopeSet(requested);
  const grantedSet = scopeSet(granted);
  return [...requestedSet].every((scope) => grantedSet.has(scope));
}

function scopeSet(scope: string): Set<string> {
  return new Set(scope.split(/\s+/).filter(Boolean));
}

export function verifyAuthorizationPassword(
  password: string,
  passwordHash?: string,
  legacyPassword?: string,
): boolean {
  if (passwordHash) {
    const normalized = passwordHash.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
      throw new Error('OAUTH_LOGIN_PASSWORD_SHA256 must be a 64-character SHA-256 hex digest');
    }
    const actual = crypto
      .createHash('sha256')
      .update(password, 'utf8')
      .digest('hex');
    return safeEqual(actual, normalized);
  }

  return Boolean(legacyPassword && safeEqual(password, legacyPassword));
}

export function verifyPkceS256(
  verifier: string,
  expectedChallenge: string,
): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = crypto
    .createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');
  return safeEqual(actual, expectedChallenge);
}

export function signAuthorizationSession(
  secret: string,
  ttlSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const expires = nowSeconds + ttlSeconds;
  const payload = String(expires);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyAuthorizationSession(
  value: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!value) return false;
  const [expiresRaw, signature] = value.split('.');
  const expires = Number(expiresRaw);
  if (
    !expiresRaw ||
    !signature ||
    !Number.isSafeInteger(expires) ||
    expires <= nowSeconds
  ) {
    return false;
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(expiresRaw)
    .digest('base64url');
  return safeEqual(signature, expected);
}

function hasValidSession(req: Request, secret: string): boolean {
  const cookies = parseCookies(req.get('cookie'));
  return verifyAuthorizationSession(cookies[AUTH_SESSION_COOKIE], secret);
}

function setSessionCookie(
  res: ExpressResponse,
  secret: string,
  ttlSeconds: number,
): void {
  const value = signAuthorizationSession(secret, ttlSeconds);
  res.set(
    'Set-Cookie',
    `${AUTH_SESSION_COOKIE}=${value}; Path=/oauth; Max-Age=${ttlSeconds}; HttpOnly; Secure; SameSite=Lax`,
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const output: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    output[key] = value;
  }
  return output;
}

function renderAuthorizationPage(
  request: AuthorizationRequest,
  clientName: string | undefined,
  invalidPassword: boolean,
  authenticated: boolean,
): string {
  const fields: Array<[string, string | undefined]> = [
    ['response_type', 'code'],
    ['client_id', request.clientId],
    ['redirect_uri', request.redirectUri],
    ['state', request.state],
    ['scope', request.scope],
    ['resource', request.resource],
    ['code_challenge', request.codeChallenge],
    ['code_challenge_method', 'S256'],
  ];
  const hidden = fields
    .filter(([, value]) => value !== undefined)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value!)}">`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Excalimate</title>
</head>
<body>
<main>
<h1>Authorize Excalimate MCP</h1>
<p>Client: <strong>${htmlEscape(clientName ?? request.clientId)}</strong></p>
<p>This grants access to create temporary animation projects, edit scenes, and render videos through Excalimate.</p>
${invalidPassword ? '<p role="alert">Invalid authorization password.</p>' : ''}
<form method="post" action="/oauth/authorize">
${hidden}
${authenticated
  ? '<p>You are signed in to Excalimate authorization.</p>'
  : '<label>Excalimate authorization password<input type="password" name="password" autocomplete="current-password" required autofocus></label>'}
<button type="submit">Authorize</button>
</form>
</main>
</body>
</html>`;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function enforceLoginRateLimit(
  req: Request,
  attempts: Map<string, { count: number; resetAt: number }>,
): void {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) return;
  if (current.count >= 10) {
    throw new OAuthProtocolError(
      'temporarily_unavailable',
      'Too many failed authorization attempts. Try again later.',
      429,
    );
  }
}

function recordFailedLogin(
  req: Request,
  attempts: Map<string, { count: number; resetAt: number }>,
): void {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
  } else {
    current.count += 1;
  }
}

function clearFailedLogin(
  req: Request,
  attempts: Map<string, { count: number; resetAt: number }>,
): void {
  attempts.delete(req.ip || 'unknown');
}


function objectLike(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function formString(
  source: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  const object = objectLike(source);
  const value = object[name];
  if (typeof value !== 'string') return undefined;
  if (value.length > maxLength) {
    throw new OAuthProtocolError('invalid_request', `${name} is too long.`);
  }
  return value;
}

function requiredFormString(
  source: unknown,
  name: string,
  maxLength: number,
): string {
  const value = formString(source, name, maxLength);
  if (!value) {
    throw new OAuthProtocolError('invalid_request', `${name} is required.`);
  }
  return value;
}

function canonicalHttpsUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`OAuth ${label} must be an HTTPS URL`);
  }
  return value.replace(/\/$/, '');
}

function randomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function asyncHandler(
  handler: (
    req: Request,
    res: ExpressResponse,
    next: NextFunction,
  ) => Promise<void>,
) {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}
