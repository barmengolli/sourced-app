import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
const createClient = vi.hoisted(() => vi.fn(() => ({ rpc })));
vi.mock('@supabase/supabase-js', () => ({ createClient }));

import handler from '../../api/opportunity-queue';

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: unknown;
  status(code: number): CapturedResponse;
  json(body: unknown): unknown;
  setHeader(name: string, value: string | string[]): void;
}

function response(): CapturedResponse {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

let ip = 10;
const request = (body: Record<string, unknown>, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: {
    origin: 'https://sourced.example.test',
    host: 'sourced.example.test',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': `192.0.2.${ip++}`,
    ...headers,
  },
  body,
});

async function login() {
  const res = response();
  await handler(request({ operation: 'login', password: 'synthetic-password' }), res);
  const cookie = String(res.headers['Set-Cookie']).split(';')[0];
  const body = res.body as { data: { csrf: string } };
  return { res, cookie, csrf: body.data.csrf };
}

describe('Opportunity queue live server boundary', () => {
  beforeEach(() => {
    process.env.OPPORTUNITY_QUEUE_SESSION_SECRET = 'synthetic-session-secret-with-enough-entropy';
    process.env.OPPORTUNITY_QUEUE_PASSWORD = 'synthetic-password';
    process.env.OPPORTUNITY_QUEUE_ALLOWED_ORIGIN = 'https://sourced.example.test';
    process.env.OPPORTUNITY_QUEUE_ACTOR_ID = 'synthetic-reviewer';
    process.env.SUPABASE_URL = 'https://synthetic-project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-key';
    rpc.mockReset();
    createClient.mockClear();
  });

  afterEach(() => {
    for (const name of [
      'OPPORTUNITY_QUEUE_SESSION_SECRET', 'OPPORTUNITY_QUEUE_PASSWORD',
      'OPPORTUNITY_QUEUE_ALLOWED_ORIGIN', 'OPPORTUNITY_QUEUE_ACTOR_ID',
      'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    ]) delete process.env[name];
  });

  it('requires the configured origin and password, then issues a hardened cookie', async () => {
    const wrongOrigin = response();
    await handler(request({ operation: 'login', password: 'synthetic-password' }, {
      origin: 'https://evil.example.test',
    }), wrongOrigin);
    expect(wrongOrigin.statusCode).toBe(403);

    const wrongPassword = response();
    await handler(request({ operation: 'login', password: 'wrong' }), wrongPassword);
    expect(wrongPassword.statusCode).toBe(401);

    const { res, csrf } = await login();
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['Set-Cookie'])).toContain('HttpOnly');
    expect(String(res.headers['Set-Cookie'])).toContain('SameSite=Strict');
    expect(csrf.length).toBeGreaterThan(20);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('keeps protected reads and the service key on the server', async () => {
    const { cookie } = await login();
    rpc.mockResolvedValueOnce({
      data: [{ sf_list_opportunity_reviews: { reviewId: '44444444-4444-4444-8444-444444444444' } }],
      error: null,
    });
    const res = response();
    await handler(request({ operation: 'list', view: 'attention' }, { cookie }), res);

    expect(res.statusCode).toBe(200);
    expect(createClient).toHaveBeenCalledWith(
      'https://synthetic-project.supabase.co', 'synthetic-service-key', expect.any(Object),
    );
    expect(rpc).toHaveBeenCalledWith('sf_list_opportunity_reviews', { p_view: 'attention' });
    expect(JSON.stringify(res.body)).not.toContain('synthetic-service-key');
  });

  it('normalizes a copied Supabase REST endpoint before creating the client', async () => {
    process.env.SUPABASE_URL = 'https://synthetic-project.supabase.co/rest/v1/';
    const { cookie } = await login();
    rpc.mockResolvedValueOnce({ data: [], error: null });
    const res = response();
    await handler(request({ operation: 'list', view: 'attention' }, { cookie }), res);

    expect(res.statusCode).toBe(200);
    expect(createClient).toHaveBeenCalledWith(
      'https://synthetic-project.supabase.co', 'synthetic-service-key', expect.any(Object),
    );
  });

  it('returns a safe database error reference without leaking raw details', async () => {
    const { cookie } = await login();
    rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: '42501',
        message: 'permission denied for function sf_list_opportunity_reviews',
        details: 'sensitive source detail',
      },
    });
    const res = response();
    await handler(request({ operation: 'list', view: 'attention' }, { cookie }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error: {
        message: 'The configured Supabase key does not have service-role access. Reference: 42501',
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('sensitive source detail');
    expect(JSON.stringify(res.body)).not.toContain('sf_list_opportunity_reviews');
  });

  it('requires CSRF and sends the opaque review identity to the atomic RPC', async () => {
    const { cookie, csrf } = await login();
    const missingCsrf = response();
    await handler(request({
      operation: 'action', action: 'ignore',
      reviewId: '44444444-4444-4444-8444-444444444444',
      expectedVersion: 'v1', idempotencyKey: 'request-1', decision: {},
    }, { cookie }), missingCsrf);
    expect(missingCsrf.statusCode).toBe(403);
    expect(rpc).not.toHaveBeenCalled();

    rpc.mockResolvedValueOnce({ data: { status: 'applied', reviewState: 'ignored' }, error: null });
    const accepted = response();
    await handler(request({
      operation: 'action', action: 'ignore',
      reviewId: '44444444-4444-4444-8444-444444444444',
      expectedVersion: 'v1', idempotencyKey: 'request-1', decision: { note: 'synthetic' },
    }, { cookie, 'x-sourced-csrf': csrf }), accepted);

    expect(accepted.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith('sf_apply_opportunity_review_action', {
      p_review_id: '44444444-4444-4444-8444-444444444444',
      p_action: 'ignore', p_decision: { note: 'synthetic' },
      p_actor_id: 'synthetic-reviewer', p_idempotency_key: 'request-1',
      p_expected_version: 'v1',
    });
    expect(JSON.stringify(rpc.mock.calls[0])).not.toContain('006');
  });
});
