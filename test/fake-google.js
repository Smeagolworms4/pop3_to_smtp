'use strict';

const http = require('node:http');

/**
 * Faux Google, pour les tests : le point de jeton OAuth et le point d'import
 * de l'API Gmail.
 *
 * Il retient ce qu'on lui envoie — corps brut de l'import compris — parce que
 * c'est précisément ce qu'on veut vérifier : le message doit arriver octet pour
 * octet, avec les bons paramètres de requête et le bon jeton.
 */
function startFakeGoogle(options = {}) {
  const state = { tokenCalls: [], imports: [] };
  let issued = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === '/token') {
        const form = Object.fromEntries(new URLSearchParams(body.toString('utf8')));
        state.tokenCalls.push(form);

        if (options.tokenError) return send(400, options.tokenError);
        if (form.grant_type === 'authorization_code') {
          return send(200, options.codeResponse ?? { refresh_token: 'refresh-1', expires_in: 3599 });
        }
        return send(200, { access_token: `access-${++issued}`, expires_in: options.expiresIn ?? 3599 });
      }

      if (url.pathname === '/upload') {
        state.imports.push({
          body,
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
          params: Object.fromEntries(url.searchParams),
        });
        if (options.importError) return send(options.importStatus ?? 403, options.importError);
        return send(200, { id: 'msg-' + state.imports.length, labelIds: ['INBOX', 'UNREAD'] });
      }

      send(404, { error: { message: 'inconnu' } });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      process.env.GOOGLE_TOKEN_URL = `${base}/token`;
      process.env.GMAIL_UPLOAD_URL = `${base}/upload`;
      resolve({
        base,
        state,
        close: () =>
          new Promise((done) => {
            delete process.env.GOOGLE_TOKEN_URL;
            delete process.env.GMAIL_UPLOAD_URL;
            server.close(done);
          }),
      });
    });
  });
}

module.exports = { startFakeGoogle };
