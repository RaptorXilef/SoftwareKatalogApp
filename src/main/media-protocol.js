import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { isInsideIconCacheDir, isInsideTargetDir } from './config.js';

const ICON_CACHE_EXT_RE = /\.(png|ico|jpg|jpeg|webp|svg|gif|avif)$/i;
const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'catalog-media',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true, // Wichtig für HTML5-Videos (Range-Requests)
      },
    },
  ]);
}

export function setupMediaProtocolHandler() {
  protocol.handle('catalog-media', async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = url.searchParams.get('path');
      const ext = filePath ? path.extname(filePath).toLowerCase() : '';

      const allowedArchive = filePath && isInsideTargetDir(filePath);
      const allowedIconCache = filePath && isInsideIconCacheDir(filePath) && ICON_CACHE_EXT_RE.test(ext);

      if (!filePath || (!allowedArchive && !allowedIconCache) || !fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 });
      }

      if (allowedIconCache || IMAGE_MIME_TYPES[ext]) {
        const data = await fs.promises.readFile(filePath);
        const cacheHeader = allowedIconCache ? 'public, max-age=86400' : 'no-cache';
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': IMAGE_MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': cacheHeader,
          },
        });
      }

      return net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
      });
    } catch (e) {
      console.error('Fehler im catalog-media Protokoll:', e);
      return new Response('Bad Request', { status: 400 });
    }
  });
}
