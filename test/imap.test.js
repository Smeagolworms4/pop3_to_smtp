'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ImapClient, encodeFolder, imapDate, quoted } = require('../dist/mail/imap');
const { startFakeImap } = require('./fake-imap');

const options = (port, overrides = {}) => ({
  host: '127.0.0.1',
  port,
  secure: false,
  user: 'moi@gmail.com',
  pass: 'motdepasse',
  timeoutMs: 2000,
  allowInvalidCert: true,
  ...overrides,
});

async function withServer(serverOptions, run) {
  const server = await startFakeImap(serverOptions);
  const client = await ImapClient.connect(options(server.port));
  try {
    return await run(client, server);
  } finally {
    await client.logout().catch(() => undefined);
    await server.close();
  }
}

test('le message déposé ressort octet pour octet', async () => {
  // Du 8 bits non-UTF-8 et une ligne qui commence par un point : deux façons
  // classiques d'abîmer un message en le faisant transiter par une chaîne.
  const raw = Buffer.from(
    'From: =?ISO-8859-1?Q?J=E9r=F4me?= <jerome@exemple.fr>\r\n' +
      'Subject: caf\xe9\r\n' +
      '\r\n' +
      '.point en début de ligne\r\n' +
      'fin\r\n',
    'latin1',
  );

  await withServer({}, async (client, server) => {
    await client.append('INBOX', raw);
    assert.equal(server.state.appended.length, 1);
    assert.deepEqual(server.state.appended[0].body, raw);
  });
});

test('les drapeaux et la date interne accompagnent le dépôt', async () => {
  await withServer({}, async (client, server) => {
    await client.append('INBOX', Buffer.from('vide\r\n'), {
      flags: ['\\Seen'],
      internalDate: new Date('2026-08-22T21:38:00Z'),
    });

    const [deposited] = server.state.appended;
    assert.deepEqual(deposited.flags, ['\\Seen']);
    assert.match(deposited.date, /^22-Aug-2026 \d{2}:38:00 [+-]\d{4}$/);
  });
});

test('sans drapeau, le message arrive non lu', async () => {
  await withServer({}, async (client, server) => {
    await client.append('INBOX', Buffer.from('vide\r\n'));
    assert.deepEqual(server.state.appended[0].flags, []);
  });
});

test('un dossier absent est créé, puis le dépôt recommence', async () => {
  await withServer({ folders: ['INBOX'] }, async (client, server) => {
    await client.append('Relevé', Buffer.from('vide\r\n'));

    assert.deepEqual(server.state.created, [encodeFolder('Relevé')]);
    assert.equal(server.state.appended.length, 1);
    assert.equal(server.state.appended[0].folder, encodeFolder('Relevé'));
  });
});

test('le nombre de messages est lu dans la réponse STATUS', async () => {
  await withServer({ count: 17 }, async (client) => {
    assert.equal(await client.count('INBOX'), 17);
  });
});

test('un mot de passe refusé remonte le message du serveur', async () => {
  const server = await startFakeImap({ password: 'le-bon' });
  try {
    await assert.rejects(
      ImapClient.connect(options(server.port, { pass: 'le-mauvais' })),
      /identifiants refusés/,
    );
  } finally {
    await server.close();
  }
});

test('le délai d’attente coupe une connexion muette', async () => {
  const net = require('node:net');
  const mute = net.createServer(() => undefined);
  await new Promise((done) => mute.listen(0, '127.0.0.1', done));

  try {
    await assert.rejects(
      ImapClient.connect(options(mute.address().port, { timeoutMs: 200 })),
      /délai IMAP dépassé/,
    );
  } finally {
    await new Promise((done) => mute.close(done));
  }
});

test('les noms de dossier passent en UTF-7 modifié', () => {
  assert.equal(encodeFolder('INBOX'), 'INBOX');
  assert.equal(encodeFolder('Relevé'), 'Relev&AOk-');
  assert.equal(encodeFolder('Reçus & envois'), 'Re&AOc-us &- envois');
  // Le '/' du base64 devient ',' : sans ça, le serveur voit une hiérarchie.
  assert.equal(encodeFolder('☂'), '&JgI-');
});

test('les guillemets et antislashs sont échappés', () => {
  assert.equal(quoted('simple'), '"simple"');
  assert.equal(quoted('a"b\\c'), '"a\\"b\\\\c"');
});

test('la date interne suit le format attendu par les serveurs', () => {
  // Deux chiffres partout, mois en anglais, décalage collé : un serveur
  // strict refuse tout le reste.
  assert.match(imapDate(new Date(2026, 7, 5, 9, 4, 3)), /^05-Aug-2026 09:04:03 [+-]\d{4}$/);
});
