import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { isInsideTargetDir } from './config.js';

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

      if (!filePath || !isInsideTargetDir(filePath) || !fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 });
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
