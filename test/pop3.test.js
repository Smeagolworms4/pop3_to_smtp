'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Pop3Client, dotUnstuff } = require('../dist/mail/pop3');
const { startFakePop3 } = require('./fake-pop3');

const options = (port, extra = {}) => ({
  host: '127.0.0.1',
  port,
  security: 'none',
  user: 'moi',
  pass: 'secret',
  timeoutMs: 5000,
  allowInvalidCert: true,
  ...extra,
});

const MESSAGE = Buffer.from(
  'From: a@b.fr\r\nSubject: test\r\n\r\nligne 1\r\n.ligne qui commence par un point\r\nfin\r\n',
  'latin1',
);

test('liste les messages avec leur identifiant et leur taille', async () => {
  const server = await startFakePop3({ messages: [MESSAGE, Buffer.from('From: c@d.fr\r\n\r\nsalut\r\n')] });
  const client = await Pop3Client.connect(options(server.port));

  const inbox = await client.list();
  assert.equal(inbox.length, 2);
  assert.equal(inbox[0].uid, 'uid-1');
  assert.equal(inbox[0].num, 1);
  assert.equal(inbox[0].size, MESSAGE.length);

  await client.quit();
  await server.close();
});

test('récupère un message octet pour octet et défait le dot-stuffing', async () => {
  const server = await startFakePop3({ messages: [MESSAGE] });
  const client = await Pop3Client.connect(options(server.port));

  const raw = await client.retr(1);
  assert.equal(raw.equals(MESSAGE), true);

  await client.quit();
  await server.close();
});

test('préserve les octets 8 bits d’un message non-UTF-8', async () => {
  // « Café » en ISO-8859-1 : un passage par une chaîne UTF-8 remplacerait le
  // 0xe9 par un caractère de remplacement, et le message arriverait abîmé.
  const latin1 = Buffer.from('From: a@b.fr\r\nSubject: Caf\xe9\r\n\r\nCaf\xe9\r\n', 'latin1');
  const server = await startFakePop3({ messages: [latin1] });
  const client = await Pop3Client.connect(options(server.port));

  const raw = await client.retr(1);
  assert.equal(raw.equals(latin1), true);
  assert.equal(raw.includes(0xe9), true);

  await client.quit();
  await server.close();
});

test('supporte un gros message découpé en de nombreux paquets', async () => {
  const big = Buffer.concat([
    Buffer.from('From: a@b.fr\r\nSubject: gros\r\n\r\n'),
    Buffer.from(('x'.repeat(100) + '\r\n').repeat(5000)),
  ]);
  const server = await startFakePop3({ messages: [big] });
  const client = await Pop3Client.connect(options(server.port));

  const raw = await client.retr(1);
  assert.equal(raw.length, big.length);
  assert.equal(raw.equals(big), true);

  await client.quit();
  await server.close();
});

test('refuse un mot de passe invalide', async () => {
  const server = await startFakePop3({ messages: [], password: 'autre' });

  await assert.rejects(
    () => Pop3Client.connect(options(server.port)),
    /mot de passe invalide/,
  );
  await server.close();
});

test('les suppressions ne sont validées qu’au QUIT', async () => {
  const server = await startFakePop3({ messages: [MESSAGE, MESSAGE] });
  const client = await Pop3Client.connect(options(server.port));

  await client.dele(1);
  assert.deepEqual(server.state.deleted, [], 'rien ne doit être supprimé avant le QUIT');

  await client.quit();
  assert.deepEqual(server.state.deleted, ['uid-1']);
  await server.close();
});

test('une erreur serveur est remontée telle quelle', async () => {
  const server = await startFakePop3({ messages: [MESSAGE], failOn: 1 });
  const client = await Pop3Client.connect(options(server.port));

  await assert.rejects(() => client.retr(1), /lecture impossible/);

  client.destroy();
  await server.close();
});

test('le délai d’attente coupe une connexion muette', async () => {
  const net = require('node:net');
  // Un serveur qui accepte puis ne dit rien : sans minuteur, on attendrait
  // indéfiniment et la relève resterait bloquée pour toujours.
  const mute = net.createServer(() => undefined);
  await new Promise((done) => mute.listen(0, '127.0.0.1', done));

  await assert.rejects(
    () => Pop3Client.connect(options(mute.address().port, { timeoutMs: 300 })),
    /délai/,
  );
  await new Promise((done) => mute.close(done));
});

test('dotUnstuff traite le point en première ligne', () => {
  assert.equal(dotUnstuff(Buffer.from('..début\r\nsuite\r\n')).toString(), '.début\r\nsuite\r\n');
  assert.equal(dotUnstuff(Buffer.from('normal\r\n..point\r\n')).toString(), 'normal\r\n.point\r\n');
  assert.equal(dotUnstuff(Buffer.from('rien à faire\r\n')).toString(), 'rien à faire\r\n');
});
