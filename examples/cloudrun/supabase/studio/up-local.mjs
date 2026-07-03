// One command to bring zeroSupabaseStudio up locally (wire + postgres-meta + BFF)
// and keep it running until Ctrl-C. Seeds a small demo schema so the table editor
// has something to show.
//
//   node examples/cloudrun/supabase/studio/up-local.mjs
//   -> http://127.0.0.1:4321/studio   (admin password: studio-admin-pw-123)

import { bringUp } from './lib/harness.mjs'

const SEED = `
CREATE SCHEMA IF NOT EXISTS demo;
CREATE TABLE IF NOT EXISTS demo.authors (id bigserial PRIMARY KEY, name text NOT NULL, bio text);
CREATE TABLE IF NOT EXISTS demo.books (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  author_id bigint REFERENCES demo.authors(id),
  tags text[],
  meta jsonb,
  in_print boolean DEFAULT true,
  published_at timestamptz DEFAULT now()
);
INSERT INTO demo.authors (name, bio) VALUES ('Ursula K. Le Guin', 'Author of Earthsea'), ('Ted Chiang', NULL) ON CONFLICT DO NOTHING;
INSERT INTO demo.books (title, author_id, tags, meta, in_print) VALUES
  ('A Wizard of Earthsea', 1, ARRAY['fantasy','classic'], '{"pages":183}'::jsonb, true),
  ('Story of Your Life', 2, ARRAY['scifi'], '{"pages":40}'::jsonb, false)
ON CONFLICT DO NOTHING;
`

const stack = await bringUp({ seed: SEED })
console.log(`\n[up] STUDIO READY -> ${stack.base}/studio`)
console.log(`[up] admin password: ${stack.cfg.adminPassword}\n`)

process.on('SIGINT', async () => { await stack.stop(); process.exit(0) })
process.on('SIGTERM', async () => { await stack.stop(); process.exit(0) })
await new Promise(() => {})
