import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

interface RequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
  setHeader(name: string, value: string | string[]): void;
}

const COOKIE = 'sourced_opportunity_queue';
const SESSION_SECONDS = 8 * 60 * 60;
const attempts = new Map<string, { count: number; resetAt: number }>();

const header = (req: RequestLike, name: string): string => {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
};

function json(res: ResponseLike, status: number, body: unknown) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function sameOrigin(req: RequestLike): boolean {
  const origin = header(req, 'origin');
  const configured = process.env.OPPORTUNITY_QUEUE_ALLOWED_ORIGIN?.replace(/\/$/, '');
  const host = header(req, 'x-forwarded-host') || header(req, 'host');
  const protocol = header(req, 'x-forwarded-proto') || 'https';
  const expected = configured || `${protocol}://${host}`;
  return Boolean(origin) && origin.replace(/\/$/, '') === expected;
}

function signature(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function issueSession(secret: string): { cookie: string; csrf: string } {
  const nonce = randomBytes(24).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'queue-reviewer', exp: Date.now() + SESSION_SECONDS * 1000, nonce }))
    .toString('base64url');
  const token = `${payload}.${signature(payload, secret)}`;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return {
    cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${SESSION_SECONDS}`,
    csrf: signature(`csrf:${nonce}`, secret),
  };
}

function readSession(req: RequestLike, secret: string): { sub: string; csrf: string } | null {
  const match = header(req, 'cookie').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const token = match.slice(COOKIE.length + 1);
  const [payload, supplied] = token.split('.');
  if (!payload || !supplied) return null;
  const expected = signature(payload, secret);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string; exp?: number; nonce?: string;
    };
    if (!parsed.sub || !parsed.nonce || !parsed.exp || parsed.exp <= Date.now()) return null;
    return { sub: parsed.sub, csrf: signature(`csrf:${parsed.nonce}`, secret) };
  } catch {
    return null;
  }
}

function passwordMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string') return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') return JSON.parse(body) as Record<string, unknown>;
  return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

function clientIp(req: RequestLike): string {
  return header(req, 'x-forwarded-for').split(',')[0]?.trim() || 'unknown';
}

function loginAllowed(req: RequestLike): boolean {
  const key = clientIp(req);
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  current.count += 1;
  return current.count <= 10;
}

export default async function handler(req: RequestLike, res: ResponseLike) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: { message: 'Method not allowed' } });

  let body: Record<string, unknown>;
  try { body = parseBody(req.body); } catch { return json(res, 400, { ok: false, error: { message: 'Invalid JSON' } }); }

  const operation = typeof body.operation === 'string' ? body.operation : '';
  let sessionSecret: string;
  try { sessionSecret = requiredEnv('OPPORTUNITY_QUEUE_SESSION_SECRET'); }
  catch { return json(res, 503, { ok: false, error: { message: 'Opportunity queue is not configured' } }); }

  if (operation === 'login') {
    if (!sameOrigin(req)) return json(res, 403, { ok: false, error: { message: 'Origin check failed' } });
    if (!loginAllowed(req)) return json(res, 429, { ok: false, error: { message: 'Too many attempts; wait 15 minutes' } });
    let password: string;
    try { password = requiredEnv('OPPORTUNITY_QUEUE_PASSWORD'); }
    catch { return json(res, 503, { ok: false, error: { message: 'Opportunity queue is not configured' } }); }
    if (!passwordMatches(body.password, password)) {
      return json(res, 401, { ok: false, error: { message: 'Incorrect password' } });
    }
    const session = issueSession(sessionSecret);
    res.setHeader('Set-Cookie', session.cookie);
    return json(res, 200, { ok: true, data: { csrf: session.csrf } });
  }

  const session = readSession(req, sessionSecret);
  if (!session) return json(res, 401, { ok: false, error: { message: 'Unlock the Opportunity queue' } });
  if (operation === 'session') return json(res, 200, { ok: true, data: { csrf: session.csrf } });
  if (operation === 'logout') {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return json(res, 200, { ok: true, data: { loggedOut: true } });
  }

  let supabaseUrl: string;
  let serviceKey: string;
  try {
    supabaseUrl = requiredEnv('SUPABASE_URL');
    serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  } catch {
    return json(res, 503, { ok: false, error: { message: 'Opportunity queue database access is not configured' } });
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (operation === 'list') {
    const view = body.view === 'not_selected' ? 'not_selected' : 'attention';
    const { data, error } = await supabase.rpc('sf_list_opportunity_reviews', { p_view: view });
    if (error) return json(res, 500, { ok: false, error: { message: 'The review queue could not be loaded' } });
    const items = (Array.isArray(data) ? data : []).map((row) => {
      if (row && typeof row === 'object' && 'sf_list_opportunity_reviews' in row) {
        return (row as { sf_list_opportunity_reviews: unknown }).sf_list_opportunity_reviews;
      }
      return row;
    });
    return json(res, 200, { ok: true, data: { items } });
  }

  if (operation === 'action') {
    if (!sameOrigin(req) || header(req, 'x-sourced-csrf') !== session.csrf) {
      return json(res, 403, { ok: false, error: { message: 'Request verification failed; reload and try again' } });
    }
    const action = typeof body.action === 'string' ? body.action : '';
    const reviewId = typeof body.reviewId === 'string' ? body.reviewId : '';
    const expectedVersion = typeof body.expectedVersion === 'string' ? body.expectedVersion : '';
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
    const decision = body.decision && typeof body.decision === 'object' ? body.decision : {};
    if (!['approve', 'ignore', 'block', 'reopen', 'reconsider'].includes(action)
        || !reviewId || !expectedVersion || !idempotencyKey) {
      return json(res, 422, { ok: false, error: { message: 'The review request is incomplete' } });
    }
    const actor = process.env.OPPORTUNITY_QUEUE_ACTOR_ID?.trim() || session.sub;
    const { data, error } = await supabase.rpc('sf_apply_opportunity_review_action', {
      p_review_id: reviewId,
      p_action: action,
      p_decision: decision,
      p_actor_id: actor,
      p_idempotency_key: idempotencyKey,
      p_expected_version: expectedVersion,
    });
    if (error) {
      const safe = error.message.includes('review changed')
        ? 'This review changed. Reload the queue and try again.'
        : error.message.includes('required') || error.message.includes('cannot') || error.message.includes('not reportable')
          ? error.message
          : 'The review action could not be saved';
      return json(res, error.message.includes('review changed') ? 409 : 422, { ok: false, error: { message: safe } });
    }
    return json(res, 200, { ok: true, data });
  }

  return json(res, 400, { ok: false, error: { message: 'Unknown operation' } });
}
