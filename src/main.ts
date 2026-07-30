import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Request, Response } from 'express';
import { AppModule } from './app.module';
import { basicAuth } from './auth/basic-auth.middleware';
import { env } from './env';
import { makeLogger } from './logger';

const log = makeLogger('web');

/**
 * Vue, Vuetify et les icônes sont servis depuis `node_modules`, jamais depuis
 * un CDN : l'interface fonctionne sur un réseau coupé d'Internet, et elle ne
 * cassera pas le jour où un CDN change ses URL.
 */
const VENDOR: Record<string, string> = {
  '/vendor/vue.js': 'vue/dist/vue.global.prod.js',
  '/vendor/vuetify.js': 'vuetify/dist/vuetify.min.js',
  '/vendor/vuetify.css': 'vuetify/dist/vuetify.min.css',
  '/vendor/css/materialdesignicons.min.css': '@mdi/font/css/materialdesignicons.min.css',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml',
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();

  // Avant l'authentification : une sonde Docker n'a pas à connaître le mot de passe.
  app.use('/health', (_req: Request, res: Response) => res.json({ ok: true }));

  app.use(basicAuth());

  const nodeModules = findNodeModules();
  for (const [route, relative] of Object.entries(VENDOR)) {
    const file = path.join(nodeModules, relative);
    app.use(route, (_req: Request, res: Response) => sendAsset(res, file));
  }
  // Les polices sont référencées en `../fonts/` depuis la feuille de style MDI.
  app.use('/vendor/fonts', (req: Request, res: Response) => {
    const name = path.basename(req.url.split('?')[0]);
    sendAsset(res, path.join(nodeModules, '@mdi/font/fonts', name));
  });

  app.useStaticAssets(findPublicDir());

  await app.listen(env.webPort, '0.0.0.0');
  log.info(`interface disponible sur le port ${env.webPort}`);
}

function sendAsset(res: Response, file: string): void {
  const type = MIME[path.extname(file)] ?? 'application/octet-stream';
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'public, max-age=86400');
  res.sendFile(file, (err) => {
    if (err) res.status(404).end();
  });
}

/** Remonte l'arborescence jusqu'au `node_modules` du projet. */
function findNodeModules(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'node_modules');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('node_modules introuvable — les dépendances sont-elles installées ?');
}

/**
 * L'interface est un fichier statique : elle vit à côté du code compilé dans
 * l'image Docker, et dans `src/` quand on lance le projet depuis les sources.
 */
function findPublicDir(): string {
  const candidates = [
    path.join(__dirname, '..', 'web', 'public'),
    path.join(__dirname, '..', 'src', 'web', 'public'),
    path.join(__dirname, 'web', 'public'),
  ];
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));
  if (!found) throw new Error('interface web introuvable');
  return found;
}

bootstrap().catch((err) => {
  log.error('démarrage impossible :', err);
  process.exit(1);
});
