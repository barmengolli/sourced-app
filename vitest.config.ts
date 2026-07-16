import { defineConfig } from 'vitest/config';

// Pure-unit test config. Node environment only: these tests exercise pure
// functions in src/lib and never touch the DOM, React, or Supabase. When the
// first component test is added (plan Step 7), a jsdom environment is layered
// in per-file via a `// @vitest-environment jsdom` docblock rather than made
// global, so the pure suite stays fast and dependency-light.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Stub dummy Supabase env vars before any module loads, so importing a pure
    // constant from a hook file (whose graph touches lib/supabase.ts) doesn't
    // throw on client construction. No network call is ever made; see
    // src/test/setupEnv.ts.
    setupFiles: ['src/test/setupEnv.ts'],
    // Tests import { describe, it, expect } from 'vitest' explicitly; no globals.
  },
});
