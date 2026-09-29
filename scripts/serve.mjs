/**
 * Servidor local mínimo (sin dependencias) para desarrollar la app.
 * Los módulos de JavaScript y el Service Worker no funcionan desde file://.
 *
 *   node scripts/serve.mjs          → http://localhost:5173
 *   PORT=8080 node scripts/serve.mjs
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    let filePath = normalize(join(ROOT, decodeURIComponent(pathname)));
    // Evita salir de la carpeta del proyecto (../../)
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      res.writeHead(403).end('Prohibido');
      return;
    }
    if ((await stat(filePath).catch(() => null))?.isDirectory()) filePath = join(filePath, 'index.html');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`El puerto ${PORT} ya está en uso: probablemente el servidor ya está abierto en otra terminal.`);
    console.error(`Entra a http://localhost:${PORT} o usa otro puerto: PORT=5174 node scripts/serve.mjs`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Ciclo de Tarjetas en http://localhost:${PORT}  (Ctrl+C para detener)`);
});
