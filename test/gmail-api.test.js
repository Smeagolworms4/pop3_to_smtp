'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  accessToken,
  authorizationUrl,
  exchangeCode,
  forgetToken,
  importMessage,
  verifyAccess,
  GMAIL_SCOPE,
} = require('../dist/mail/gmail-api');
const { startFakeGoogle } = require('./fake-google');

let counter = 0;
/** Chaque test a sa propre destination : le cache de jetons est indexé par id. */
const target = (overrides = {}) => ({
  id: 'gmail-' + ++counter,
  name: 'Gmail', enabled: true, kind: 'gmail-api',
  host: '', port: 0, secure: true, user: '', pass: '',
  to: 'moi@gmail.com', folder: 'INBOX', markRead: false,
  oauthClientId: 'client-1', oauthClientSecret: 'secret-1', oauthRefreshToken: 'refresh-1',
  neverMarkSpam: false, from: '', headerMode: 'auto', envelopeFrom: 'auto',
  newMessageId: false, allowInvalidCert: false, ...overrides,
});

test('l’URL d’autorisation demande le minimum, et de quoi durer', () => {
  const url = new URL(authorizationUrl('client-1', 'https://mail.exemple.fr/api/oauth/callback', 'jeton'));
  const params = url.searchParams;

  assert.equal(params.get('client_id'), 'client-1');
  assert.equal(params.get('redirect_uri'), 'https://mail.exemple.fr/api/oauth/callback');
  assert.equal(params.get('state'), 'jeton');
  // Un seul droit : ajouter des messages. Ni lecture, ni envoi.
  assert.equal(params.get('scope'), GMAIL_SCOPE);
  assert.match(GMAIL_SCOPE, /gmail\.insert$/);
  // Sans ces deux-là, pas de jeton de rafraîchissement — donc pas de relève
  // automatique une heure plus tard.
  assert.equal(params.get('access_type'), 'offline');
  assert.equal(params.get('prompt'), 'consent');
});

test('le code d’autorisation est échangé contre un jeton durable', async (t) => {
  const google = await startFakeGoogle();
  t.after(() => google.close());

  const refresh = await exchangeCode('client-1', 'secret-1', 'le-code', 'https://exemple.fr/cb');
  assert.equal(refresh, 'refresh-1');

  const [call] = google.state.tokenCalls;
  assert.equal(call.grant_type, 'authorization_code');
  assert.equal(call.code, 'le-code');
  assert.equal(call.client_secret, 'secret-1');
  assert.equal(call.redirect_uri, 'https://exemple.fr/cb');
});

test('un retour sans jeton de rafraîchissement le dit clairement', async (t) => {
  const google = await startFakeGoogle({ codeResponse: { access_token: 'a', expires_in: 3599 } });
  t.after(() => google.close());

  await assert.rejects(
    exchangeCode('client-1', 'secret-1', 'le-code', 'https://exemple.fr/cb'),
    /jeton de rafraîchissement/,
  );
});

test('le jeton d’accès est mis en cache entre deux messages', async (t) => {
  const google = await startFakeGoogle();
  t.after(() => google.close());

  const dest = target();
  assert.equal(await accessToken(dest), 'access-1');
  assert.equal(await accessToken(dest), 'access-1');
  assert.equal(google.state.tokenCalls.length, 1, 'un seul aller-retour vers Google');

  // Les identifiants changent : le cache doit être oublié.
  forgetToken(dest.id);
  assert.equal(await accessToken(dest), 'access-2');
});

test('un jeton bientôt périmé est racheté avant de servir', async (t) => {
  // 30 s de validité : sous la marge d'une minute, donc jamais réutilisé.
  const google = await startFakeGoogle({ expiresIn: 30 });
  t.after(() => google.close());

  const dest = target();
  await accessToken(dest);
  await accessToken(dest);
  assert.equal(google.state.tokenCalls.length, 2);
});

test('une autorisation révoquée donne un message actionnable', async (t) => {
  const google = await startFakeGoogle({
    tokenError: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
  });
  t.after(() => google.close());

  await assert.rejects(accessToken(target()), /reconnectez le compte/);
});

test('sans compte connecté, on ne va pas déranger Google', async (t) => {
  const google = await startFakeGoogle();
  t.after(() => google.close());

  await assert.rejects(accessToken(target({ oauthRefreshToken: '' })), /non connecté/);
  assert.equal(google.state.tokenCalls.length, 0);
});

test('le message est importé octet pour octet, avec les bons réglages', async (t) => {
  const google = await startFakeGoogle();
  t.after(() => google.close());

  const raw = Buffer.from(
    'From: LinkedIn <messages-noreply@linkedin.com>\r\nSubject: caf\xe9\r\n\r\ncorps\r\n',
    'latin1',
  );

  const result = await importMessage(target(), raw);
  assert.match(result, /msg-1/);

  const [sent] = google.state.imports;
  assert.deepEqual(sent.body, raw, 'aucun ré-encodage en route');
  assert.equal(sent.contentType, 'message/rfc822');
  assert.equal(sent.authorization, 'Bearer access-1');
  assert.equal(sent.params.uploadType, 'media');
  // La date du message, pas celle de l'import : l'ordre de la boîte est celui
  // dans lequel les messages sont réellement arrivés.
  assert.equal(sent.params.internalDateSource, 'dateHeader');
  assert.equal(sent.params.neverMarkSpam, 'false');
});

test('l’option antispam se répercute sur la requête', async (t) => {
  const google = await startFakeGoogle();
  t.after(() => google.close());

  await importMessage(target({ neverMarkSpam: true }), Buffer.from('vide\r\n'));
  assert.equal(google.state.imports[0].params.neverMarkSpam, 'true');
});

test('un refus de Google est remonté avec son propre message', async (t) => {
  const google = await startFakeGoogle({
    importError: { error: { code: 403, message: 'Request had insufficient authentication scopes.' } },
  });
  t.after(() => google.close());

  await assert.rejects(
    importMessage(target(), Buffer.from('vide\r\n')),
    /insufficient authentication scopes.*403/s,
  );
});

test('la vérification se contente d’obtenir un jeton', async (t) => {
  const google = await startFakeGoogle();
  t.after(() => google.close());

  assert.match(await verifyAccess(target()), /autorisation valide/);
  assert.equal(google.state.imports.length, 0, 'rien n’est déposé dans la boîte');
});
