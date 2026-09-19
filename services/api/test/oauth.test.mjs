import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import {
  createOAuthSupport,
  normalizeScope,
  signAuthorizationSession,
  validateRedirectUri,
  verifyAuthorizationSession,
  verifyPkceS256,
} from '../dist/oauth.js';

test('PKCE S256 verification matches RFC-style verifier/challenge', () => {
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abc';
  const challenge = createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');
  assert.equal(verifyPkceS256(verifier, challenge), true);
  assert.equal(verifyPkceS256(verifier, challenge.slice(0, -1) + 'A'), false);
});

test('authorization session signatures expire and reject tampering', () => {
  const value = signAuthorizationSession('secret-value', 60, 1_000);
  assert.equal(
    verifyAuthorizationSession(value, 'secret-value', 1_030),
    true,
  );
  assert.equal(
    verifyAuthorizationSession(value, 'wrong-secret', 1_030),
    false,
  );
  assert.equal(
    verifyAuthorizationSession(value, 'secret-value', 1_061),
    false,
  );
});

test('scope normalization only accepts the MCP scope', () => {
  assert.equal(normalizeScope(), 'mcp');
  assert.equal(normalizeScope('mcp'), 'mcp');
  assert.throws(() => normalizeScope('mcp admin'));
  assert.throws(() => normalizeScope('admin'));
});

test('redirect URI validation allows HTTPS and native loopback only', () => {
  assert.doesNotThrow(() =>
    validateRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect'),
  );
  assert.doesNotThrow(() =>
    validateRedirectUri('http://127.0.0.1:45731/callback'),
  );
  assert.throws(() =>
    validateRedirectUri('http://example.com/callback'),
  );
  assert.throws(() =>
    validateRedirectUri('https://example.com/callback#fragment'),
  );
});

test('OAuth discovery publishes MCP resource, PKCE and CIMD support', async () => {
  const fakePool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => {
      throw new Error('not used');
    },
  };
  const oauth = createOAuthSupport({
    pool: fakePool,
    issuer: 'https://api.example.com',
    resource: 'https://api.example.com/mcp',
    loginPassword: 'login-password',
    sessionSecret: 'session-secret',
  });

  const app = express();
  app.use(oauth.router);
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });

  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    const base = 'http://127.0.0.1:' + address.port;

    const resource = await fetch(base + '/.well-known/oauth-protected-resource');
    assert.equal(resource.status, 200);
    const resourceJson = await resource.json();
    assert.equal(resourceJson.resource, 'https://api.example.com/mcp');
    assert.deepEqual(resourceJson.authorization_servers, ['https://api.example.com']);
    assert.deepEqual(resourceJson.scopes_supported, ['mcp']);

    const auth = await fetch(base + '/.well-known/oauth-authorization-server');
    assert.equal(auth.status, 200);
    const authJson = await auth.json();
    assert.equal(authJson.issuer, 'https://api.example.com');
    assert.equal(authJson.client_id_metadata_document_supported, true);
    assert.deepEqual(authJson.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(authJson.token_endpoint_auth_methods_supported, ['none']);
    assert.equal(authJson.authorization_response_iss_parameter_supported, true);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});


test('Bearer challenge uses auth-scheme followed by auth parameters', () => {
  const fakePool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => {
      throw new Error('not used');
    },
  };
  const oauth = createOAuthSupport({
    pool: fakePool,
    issuer: 'https://api.example.com',
    resource: 'https://api.example.com/mcp',
    loginPassword: 'login-password',
    sessionSecret: 'session-secret',
  });

  const headers = new Map();
  const fakeResponse = {
    set(name, value) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
  };

  oauth.challenge(fakeResponse);
  assert.equal(
    headers.get('www-authenticate'),
    'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource", scope="mcp"',
  );
});
