// Vitest setup: provide DUMMY Supabase env vars so that importing a module
// whose graph touches src/lib/supabase.ts (e.g. a hook file we only want a
// pure constant from) can instantiate the client object without throwing
// "supabaseUrl is required".
//
// These are fake, local-only values. createClient() with them builds an inert
// client object; no network request is ever made because the tests only import
// pure functions/constants and never call the client. This preserves the hard
// rule that unit tests never connect to Supabase.
import { vi } from 'vitest';

vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321');
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key-not-real');
