// Construit la version portable : UN SEUL fichier HTML (code + styles + bibliothèques PDF) qui s'ouvre par
// double-clic depuis une clé USB, sans serveur ni internet.   Usage : npm run build
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = require(process.env.ESBUILD_PATH || 'esbuild');
const lire = (p) => readFileSync(join(racine, p));
const b64 = (p) => lire(p).toString('base64');

const { outputFiles, warnings } = await esbuild.build({
  entryPoints: [join(racine, 'js/app.js')], bundle: true, format: 'iife', minify: true, write: false,
  target: 'es2020', legalComments: 'none', define: { 'import.meta.url': '"about:blank"' },
});
if (warnings.length) console.warn(warnings.map((w) => w.text).join('\n'));
let js = outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

let html = lire('index.html').toString('utf8');
const sub = (re, par) => { if (!re.test(html)) throw new Error(`index.html : motif introuvable ${re}`); html = html.replace(re, () => par); };
sub(/\s*<link rel="manifest"[^>]*>/, '');
sub(/<link rel="icon"[^>]*>/, `<link rel="icon" href="data:image/png;base64,${b64('icons/icon-192.png')}">`);
sub(/\s*<link rel="apple-touch-icon"[^>]*>/, '');
sub(/<link rel="stylesheet" href="styles.css">/, `<style>\n${lire('styles.css').toString('utf8')}</style>`);
const embarques = [['emb-pdfjs', 'vendor/pdfjs/pdf.min.mjs'], ['emb-pdfjs-worker', 'vendor/pdfjs/pdf.worker.min.mjs'], ['emb-pdflib', 'vendor/pdf-lib.min.js']]
  .map(([id, f]) => `<script type="text/plain" id="${id}">${b64(f)}</script>`).join('\n');
sub(/<script type="module" src="js\/app.js"><\/script>/, `${embarques}\n<script>\n${js}\n</script>`);

mkdirSync(join(racine, 'portable/donnees'), { recursive: true });
writeFileSync(join(racine, 'portable/Mes-papiers-retraite.html'), html);
console.log(`portable/Mes-papiers-retraite.html : ${(Buffer.byteLength(html) / 1048576).toFixed(2)} Mo`);
