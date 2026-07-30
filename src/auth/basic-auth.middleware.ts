import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../env';

/**
 * Authentification basique sur toute l'interface.
 *
 * Sans `WEB_USER`/`WEB_PASSWORD`, l'accès est libre : c'est le cas courant
 * derrière un réseau local. Dès qu'un des deux est renseigné, tout passe par
 * l'authentification — y compris l'API, qui donnerait sinon accès aux mots de
 * passe des boîtes.
 *
 * Volontairement branché en amont d'Express plutôt que par le
 * `MiddlewareConsumer` de Nest : ainsi il couvre aussi les fichiers statiques,
 * et l'ordre d'exécution ne dépend pas de l'initialisation du framework.
 */
export function basicAuth() {
  const enabled = Boolean(env.webUser || env.webPassword);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled || check(req.headers.authorization)) return next();

    res.setHeader('WWW-Authenticate', 'Basic realm="pop3-to-smtp", charset="UTF-8"');
    res.status(401).send('Authentification requise');
  };
}

function check(header: string | undefined): boolean {
  if (!header?.startsWith('Basic ')) return false;

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;

  // Comparaison à temps constant : sur un service exposé, comparer des chaînes
  // avec `===` laisse fuir la longueur du secret caractère par caractère.
  return (
    constantTimeEqual(decoded.slice(0, sep), env.webUser) &&
    constantTimeEqual(decoded.slice(sep + 1), env.webPassword)
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // `timingSafeEqual` exige des longueurs égales : on compare quand même
    // quelque chose de la bonne taille pour ne pas court-circuiter le délai.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
