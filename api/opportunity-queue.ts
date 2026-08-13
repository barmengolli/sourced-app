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
const SALESFORCE_ORIGIN = 'https://eisgroup.lightning.force.com';
const SALESFORCE_ID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

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

function normalizeSupabaseUrl(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/$/, '');
  // createClient adds /rest/v1 itself. Accept the common REST endpoint form
  // from an existing HTTP node, but always pass the project origin onward.
  if (path !== '' && path !== '/rest/v1') {
    throw new Error('invalid SUPABASE_URL path');
  }
  return url.origin;
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

function queueReadFailure(error: { code?: string; message?: string }): string {
  const code = error.code?.trim() || 'UNKNOWN';
  const message = error.message?.toLowerCase() || '';
  if (code === '42501') {
    return 'The configured Supabase key does not have service-role access. Reference: 42501';
  }
  if (code === 'PGRST202') {
    return 'Supabase REST has not loaded the queue function. Reference: PGRST202';
  }
  if (code === 'PGRST301' || message.includes('invalid api key') || message.includes('jwt')) {
    return `The configured Supabase service-role key is invalid. Reference: ${code}`;
  }
  return `The review queue could not be loaded. Reference: ${code}`;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
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
    supabaseUrl = normalizeSupabaseUrl(requiredEnv('SUPABASE_URL'));
    serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  } catch {
    return json(res, 503, { ok: false, error: { message: 'Opportunity queue database access is not configured' } });
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (operation === 'list') {
    const view = body.view === 'not_selected' ? 'not_selected' : 'attention';
    const [{ data, error }, { data: candidateData, error: candidateError }] = await Promise.all([
      supabase.rpc('sf_list_opportunity_reviews', { p_view: view }),
      view === 'attention'
        ? supabase.rpc('sf_list_opportunity_existing_deal_candidates')
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (error) {
      // Expose only a stable error category/code to the authenticated reviewer.
      // Raw database messages, details, and source values stay server-side.
      return json(res, 500, { ok: false, error: { message: queueReadFailure(error) } });
    }
    if (candidateError) {
      return json(res, 500, { ok: false, error: { message: queueReadFailure(candidateError) } });
    }
    const candidates = new Map<string, Record<string, unknown>>();
    for (let candidate of Array.isArray(candidateData) ? candidateData : []) {
      if (candidate && typeof candidate === 'object'
          && 'sf_list_opportunity_existing_deal_candidates' in candidate) {
        candidate = (candidate as { sf_list_opportunity_existing_deal_candidates: unknown })
          .sf_list_opportunity_existing_deal_candidates;
      }
      if (!candidate || typeof candidate !== 'object') continue;
      const value = candidate as Record<string, unknown>;
      if (typeof value.reviewId === 'string') candidates.set(value.reviewId, value);
    }
    const items = (Array.isArray(data) ? data : []).map((row) => {
      if (row && typeof row === 'object' && 'sf_list_opportunity_reviews' in row) {
        row = (row as { sf_list_opportunity_reviews: unknown }).sf_list_opportunity_reviews;
      }
      if (!row || typeof row !== 'object') return row;
      const source = row as Record<string, unknown>;
      const sfOpportunityId = typeof source.sfOpportunityId === 'string' && SALESFORCE_ID.test(source.sfOpportunityId)
        ? source.sfOpportunityId
        : null;
      const safe = { ...source };
      delete safe.sfOpportunityId;
      return {
        ...safe,
        existingManualDeal: typeof source.reviewId === 'string'
          ? candidates.get(source.reviewId) ?? null
          : null,
        salesforceUrl: sfOpportunityId
          ? `${SALESFORCE_ORIGIN}/lightning/r/Opportunity/${encodeURIComponent(sfOpportunityId)}/view`
          : null,
      };
    });
    return json(res, 200, { ok: true, data: { items } });
  }

  if (operation === 'find_lead_by_email') {
    if (!sameOrigin(req)) {
      return json(res, 403, { ok: false, error: { message: 'Origin check failed' } });
    }
    const email = normalizeEmail(body.email);
    if (!email) {
      return json(res, 422, { ok: false, error: { message: 'Enter a valid email address' } });
    }
    const { data, error } = await supabase.rpc('sf_find_lead_by_email', { p_email: email });
    if (error) {
      return json(res, 500, { ok: false, error: { message: 'The lead lookup could not be completed' } });
    }
    const matches = (Array.isArray(data) ? data : [])
      .map((row) => row && typeof row === 'object' && 'sf_find_lead_by_email' in row
        ? (row as { sf_find_lead_by_email: unknown }).sf_find_lead_by_email
        : row)
      .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'));
    if (matches.length > 1) {
      return json(res, 409, { ok: false, error: { message: 'More than one exact lead match was found; nothing was selected' } });
    }
    return json(res, 200, { ok: true, data: { match: matches[0] ?? null } });
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
    if (!['approve', 'ignore', 'block', 'reopen', 'reconsider', 'adopt_existing'].includes(action)
        || !reviewId || !expectedVersion || !idempotencyKey) {
      return json(res, 422, { ok: false, error: { message: 'The review request is incomplete' } });
    }
    const actor = process.env.OPPORTUNITY_QUEUE_ACTOR_ID?.trim() || session.sub;
    if (action === 'adopt_existing') {
      const dealId = typeof (decision as Record<string, unknown>).dealId === 'string'
        ? String((decision as Record<string, unknown>).dealId).trim()
        : '';
      if (!dealId) {
        return json(res, 422, { ok: false, error: { message: 'The existing deal selection is missing' } });
      }
      const { data, error } = await supabase.rpc('sf_adopt_existing_opportunity_deal', {
        p_review_id: reviewId,
        p_expected_deal_id: dealId,
        p_actor_id: actor,
        p_idempotency_key: idempotencyKey,
        p_expected_version: expectedVersion,
      });
      if (error) {
        const changed = error.message.includes('changed') || error.message.includes('reload');
        const safe = changed
          ? 'This review or its existing deal candidate changed. Reload the queue and try again.'
          : error.message.includes('exact') || error.message.includes('consistent')
            || error.message.includes('eligible') || error.message.includes('active deal link')
            ? error.message
            : 'The existing Sourced deal could not be linked';
        return json(res, changed ? 409 : 422, { ok: false, error: { message: safe } });
      }
      return json(res, 200, { ok: true, data });
    }
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
            || error.message.includes('possible existing Sourced deal')
          ? error.message
          : 'The review action could not be saved';
      return json(res, error.message.includes('review changed') ? 409 : 422, { ok: false, error: { message: safe } });
    }
    return json(res, 200, { ok: true, data });
  }

  return json(res, 400, { ok: false, error: { message: 'Unknown operation' } });
}
