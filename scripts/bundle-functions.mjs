#!/usr/bin/env node
/**
 * Empacota cada Edge Function em um único arquivo ESM (sem imports externos).
 *
 * O código em supabase/functions usa apenas APIs do Deno/Web (fetch, WebCrypto,
 * TextEncoder), sem dependências npm — por isso o bundle é direto e continua
 * legível. Saída em .local/functions-build/<slug>.ts (não versionado), pronta
 * para `supabase functions deploy` ou para envio pelo painel.
 */
import { build } from 'esbuild';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'supabase', 'functions');
const OUT_DIR = path.join(ROOT, '.local', 'functions-build');

mkdirSync(OUT_DIR, { recursive: true });

const slugs = readdirSync(FUNCTIONS_DIR).filter((entry) => {
  if (entry.startsWith('_')) return false;
  const indexPath = path.join(FUNCTIONS_DIR, entry, 'index.ts');
  try {
    return statSync(indexPath).isFile();
  } catch {
    return false;
  }
});

for (const slug of slugs.sort()) {
  await build({
    entryPoints: [path.join(FUNCTIONS_DIR, slug, 'index.ts')],
    outfile: path.join(OUT_DIR, `${slug}.ts`),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    legalComments: 'none',
    banner: { js: `// Edge Function: ${slug} - bundle gerado por scripts/bundle-functions.mjs` },
  });
  console.log(`bundled ${slug}`);
}
