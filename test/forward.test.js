'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// `env` lit DATA_DIR à l'import : il faut le fixer avant de charger le code.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pop3-to-smtp-'));
process.env.RUN_ON_START = 'false';

const { SMTPServer } = require('smtp-server');
const { startFakePop3 } = require('./fake-pop3');
const { startFakeImap } = require('./fake-imap');
const { startFakeGoogle } = require('./fake-google');

const { StoreService } = require('../dist/store/store.service');
const { SmtpService } = require('../dist/mail/smtp.service');
const { NotifyService } = require('../dist/notify/notify.service');
const { ForwarderService } = require('../dist/mail/forwarder.service');
const { getHeader, splitMessage } = require('../dist/mail/headers');

const MESSAGE_1 = Buffer.from(
  [
    'From: Jean Dupont <jean@exemple.fr>',
    'To: moi@fai.fr',
    'Subject: Facture de juillet',
    'Date: Wed, 30 Jul 2026 09:15:00 +0200',
    'Message-ID: <m1@exemple.fr>',
    '',
    'Bonjour, voici la facture.',
    '',
  ].join('\r\n'),
  'latin1',
);

const MESSAGE_2 = Buffer.from(
  [
    'From: Marie <marie@exemple.fr>',
    'To: moi@fai.fr',
    'Subject: =?UTF-8?B?UsOpdW5pb24=?=',
    'Message-ID: <m2@exemple.fr>',
    '',
    'On se voit mardi ?',
    '',
  ].join('\r\n'),
  'latin1',
);

/** Serveur SMTP de test : conserve l'enveloppe et les octets reçus. */
async function startSink(options = {}) {
  const received = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onRcptTo(address, session, callback) {
      if (options.rejectAll) return callback(new Error('550 boîte pleine'));
      callback();
    },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          raw: Buffer.concat(chunks),
          mailFrom: session.envelope.mailFrom.address,
          rcptTo: session.envelope.rcptTo.map((r) => r.address),
        });
        callback();
      });
    },
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: server.server.address().port,
    received,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** Repart d'un volume `data` vierge : chaque test doit être indépendant. */
function resetDataDir() {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
}

/** Monte les services à la main, sans passer par l'injection de Nest. */
async function buildStack(pop3Port, smtpPort, overrides = {}) {
  resetDataDir();
  const store = new StoreService();
  await store.onModuleInit();

  const smtp = new SmtpService();
  const notify = new NotifyService(store, smtp);
  const forwarder = new ForwarderService(store, smtp, notify);

  const target = {
    id: 't1', name: 'Boîte cible', enabled: true, kind: 'smtp',
    host: '127.0.0.1', port: smtpPort, secure: false,
    user: '', pass: '', to: 'moi@gmail.com', from: 'relais@exemple.net',
    folder: 'INBOX', markRead: false,
    headerMode: 'redirect', envelopeFrom: 'auto', newMessageId: false,
    allowInvalidCert: true, ...(overrides.target ?? {}),
  };
  const source = {
    id: 's1', name: 'Boîte du FAI', enabled: true,
    host: '127.0.0.1', port: pop3Port, security: 'none',
    user: 'moi@fai.fr', pass: 'secret', targetId: 't1',
    deleteAfterFetch: false, allowInvalidCert: true, ...(overrides.source ?? {}),
  };

  await store.updateConfig((config) => {
    config.targets = [target];
    config.sources = [source];
  });

  return { store, forwarder };
}

test('redirige les messages et n’y touche pas', async (t) => {
  const pop3 = await startFakePop3({ messages: [MESSAGE_1, MESSAGE_2] });
  const sink = await startSink();
  t.after(async () => {
    await pop3.close();
    await sink.close();
  });

  const { forwarder } = await buildStack(pop3.port, sink.port);
  const entry = await forwarder.runSource('s1', 'manual');

  assert.equal(entry.status, 'ok');
  assert.equal(entry.total, 2);
  assert.equal(entry.forwarded, 2);
  assert.equal(sink.received.length, 2);

  const first = sink.received.find((m) => m.raw.includes('m1@exemple.fr'));
  const { head, body } = splitMessage(first.raw);

  // L'expéditeur d'origine et le fil de discussion sont intacts.
  assert.equal(getHeader(head, 'From'), 'Jean Dupont <jean@exemple.fr>');
  assert.equal(getHeader(head, 'Message-ID'), '<m1@exemple.fr>');
  assert.equal(getHeader(head, 'Subject'), 'Facture de juillet');
  assert.equal(getHeader(head, 'Delivered-To'), 'moi@gmail.com');
  assert.match(body.toString('latin1'), /Bonjour, voici la facture\./);

  // L'enveloppe reproduit une vraie redirection.
  assert.equal(first.mailFrom, 'jean@exemple.fr');
  assert.deepEqual(first.rcptTo, ['moi@gmail.com']);

  // L'historique retient ce qui s'est passé, message par message.
  assert.equal(entry.messages.length, 2);
  assert.equal(entry.messages.every((m) => m.status === 'forwarded'), true);
  assert.equal(entry.messages.some((m) => m.subject === 'Réunion'), true);
});

test('ne renvoie pas deux fois le même message', async (t) => {
  const pop3 = await startFakePop3({ messages: [MESSAGE_1, MESSAGE_2] });
  const sink = await startSink();
  t.after(async () => {
    await pop3.close();
    await sink.close();
  });

  const { forwarder } = await buildStack(pop3.port, sink.port);
  await forwarder.runSource('s1', 'manual');
  const second = await forwarder.runSource('s1', 'manual');

  assert.equal(second.total, 0);
  assert.equal(second.forwarded, 0);
  assert.equal(sink.received.length, 2, 'la seconde relève ne doit rien renvoyer');
});

test('mode déplacement : la boîte source est vidée après envoi', async (t) => {
  const pop3 = await startFakePop3({ messages: [MESSAGE_1, MESSAGE_2] });
  const sink = await startSink();
  t.after(async () => {
    await pop3.close();
    await sink.close();
  });

  const { forwarder } = await buildStack(pop3.port, sink.port, {
    source: { deleteAfterFetch: true },
  });
  const entry = await forwarder.runSource('s1', 'manual');

  assert.equal(entry.deleted, 2);
  assert.deepEqual(pop3.state.deleted, ['uid-1', 'uid-2']);
});

test('un refus SMTP laisse le message en place, à retenter', async (t) => {
  const pop3 = await startFakePop3({ messages: [MESSAGE_1] });
  const refusing = await startSink({ rejectAll: true });
  t.after(async () => {
    await pop3.close();
    await refusing.close();
  });

  const { store, forwarder } = await buildStack(pop3.port, refusing.port, {
    source: { deleteAfterFetch: true },
  });
  const entry = await forwarder.runSource('s1', 'manual');

  assert.equal(entry.status, 'error');
  assert.equal(entry.forwarded, 0);
  assert.equal(entry.messages[0].status, 'error');
  assert.ok(entry.messages[0].error, "l'erreur doit être consignée dans l'historique");

  // Rien ne doit avoir été supprimé ni marqué comme traité.
  assert.deepEqual(pop3.state.deleted, []);
  assert.equal(store.seenUids('s1').size, 0);
});

test('une boîte injoignable est consignée sans faire tomber le service', async (t) => {
  const sink = await startSink();
  t.after(() => sink.close());

  // Port fermé : la connexion doit échouer proprement.
  const { store, forwarder } = await buildStack(1, sink.port);
  const entry = await forwarder.runSource('s1', 'manual');

  assert.equal(entry.status, 'error');
  assert.ok(entry.error);
  assert.equal(store.getState().lastRun.id, entry.id);
  assert.equal(store.history(10)[0].status, 'error');
});

test('les messages trop gros sont ignorés, pas perdus en boucle', async (t) => {
  const big = Buffer.concat([
    Buffer.from('From: a@b.fr\r\nSubject: gros\r\nMessage-ID: <big@x>\r\n\r\n'),
    Buffer.from('x'.repeat(2 * 1024 * 1024)),
  ]);
  const pop3 = await startFakePop3({ messages: [big, MESSAGE_1] });
  const sink = await startSink();
  t.after(async () => {
    await pop3.close();
    await sink.close();
  });

  const { store, forwarder } = await buildStack(pop3.port, sink.port);
  await store.updateConfig((config) => {
    config.settings.maxSizeMb = 1;
  });

  const entry = await forwarder.runSource('s1', 'manual');

  assert.equal(entry.skipped, 1);
  assert.equal(entry.forwarded, 1);
  assert.equal(sink.received.length, 1);
  // Ignoré une fois, ignoré définitivement : il ne doit pas revenir à chaque tour.
  assert.equal(store.seenUids('s1').has('uid-1'), true);
});

test('deux relèves simultanées ne se marchent pas dessus', async (t) => {
  const pop3 = await startFakePop3({ messages: [MESSAGE_1, MESSAGE_2] });
  const sink = await startSink();
  t.after(async () => {
    await pop3.close();
    await sink.close();
  });

  const { forwarder } = await buildStack(pop3.port, sink.port);
  await Promise.all([
    forwarder.runSource('s1', 'manual'),
    forwarder.runSource('s1', 'manual'),
  ]);

  assert.equal(sink.received.length, 2, 'chaque message ne doit partir qu’une fois');
});

test('la configuration et l’état survivent à un redémarrage', async (t) => {
  const pop3 = await startFakePop3({ messages: [MESSAGE_1] });
  const sink = await startSink();
  t.after(async () => {
    await pop3.close();
    await sink.close();
  });

  const { forwarder } = await buildStack(pop3.port, sink.port);
  await forwarder.runSource('s1', 'manual');

  // Un nouveau StoreService relit les fichiers JSON, comme au redémarrage.
  const reloaded = new StoreService();
  await reloaded.onModuleInit();

  assert.equal(reloaded.getConfig().sources.length, 1);
  assert.equal(reloaded.seenUids('s1').has('uid-1'), true);
  assert.equal(reloaded.getState().lastRun.forwarded, 1);
});

test('le plafond par boîte l’emporte sur le réglage global', async (t) => {
  const messages = Array.from({ length: 5 }, (_, i) =>
    Buffer.from(`From: a@b.fr\r\nSubject: n${i}\r\nMessage-ID: <n${i}@x>\r\n\r\ncorps\r\n`, 'latin1'),
  );
  const pop3 = await startFakePop3({ messages });
  const sink = await startSink();
  t.after(async () => {
    await pop3.close();
    await sink.close();
  });

  const { store, forwarder } = await buildStack(pop3.port, sink.port, {
    source: { maxPerRun: 2 },
  });
  await store.updateConfig((config) => {
    config.settings.maxPerRun = 50;
  });

  const first = await forwarder.runSource('s1', 'manual');
  assert.equal(first.total, 5, 'les 5 sont vus…');
  assert.equal(first.forwarded, 2, '…mais seuls 2 partent ce passage');

  // Le reste attend le passage suivant, il n'est pas perdu.
  const second = await forwarder.runSource('s1', 'manual');
  assert.equal(second.forwarded, 2);
  assert.equal(sink.received.length, 4);
});

test('un plafond à zéro traite toute la boîte d’un coup', async (t) => {
  const messages = Array.from({ length: 12 }, (_, i) =>
    Buffer.from(`From: a@b.fr\r\nSubject: n${i}\r\nMessage-ID: <z${i}@x>\r\n\r\ncorps\r\n`, 'latin1'),
  );
  const pop3 = await startFakePop3({ messages });
  const sink = await startSink();
  t.after(async () => {
    await pop3.close();
    await sink.close();
  });

  const { forwarder } = await buildStack(pop3.port, sink.port, {
    source: { maxPerRun: 0 },
  });
  const entry = await forwarder.runSource('s1', 'manual');

  assert.equal(entry.forwarded, 12);
  assert.equal(sink.received.length, 12);
});

test('chaque boîte garde son propre historique et sa propre dernière action', async (t) => {
  const pop3a = await startFakePop3({ messages: [MESSAGE_1] });
  const pop3b = await startFakePop3({ messages: [MESSAGE_2] });
  const sink = await startSink();
  t.after(async () => {
    await pop3a.close();
    await pop3b.close();
    await sink.close();
  });

  const { store, forwarder } = await buildStack(pop3a.port, sink.port);
  await store.updateConfig((config) => {
    config.sources.push({ ...config.sources[0], id: 's2', name: 'Seconde boîte', port: pop3b.port });
  });

  await forwarder.runSource('s1', 'manual');
  await forwarder.runSource('s2', 'manual');

  // s1 a été relevée en premier : sans historique par boîte, sa carte
  // afficherait « jamais relevée » parce que s2 est passée derrière.
  const last = store.lastRuns();
  assert.equal(last.s1.forwarded, 1, 's1 doit garder sa dernière action');
  assert.equal(last.s2.forwarded, 1, 's2 aussi');
  assert.notEqual(last.s1.id, last.s2.id);

  assert.equal(store.history(10, 's1').every((h) => h.sourceId === 's1'), true);
  assert.equal(store.history(10, 's1').length, 1);
  assert.equal(store.history(10).length, 2, 'l’historique global les voit toutes');
});

test('une boîte bavarde n’efface pas l’historique d’une boîte discrète', async (t) => {
  const pop3 = await startFakePop3({ messages: [] });
  const sink = await startSink();
  t.after(async () => {
    await pop3.close();
    await sink.close();
  });

  const { store, forwarder } = await buildStack(pop3.port, sink.port);
  await store.updateConfig((config) => {
    config.settings.historyMax = 10;
    config.sources.push({ ...config.sources[0], id: 's2', name: 'Boîte discrète' });
  });

  await forwarder.runSource('s2', 'manual');
  // s1 est relevée 30 fois de suite : bien au-delà du plafond d'historique.
  for (let i = 0; i < 30; i++) await forwarder.runSource('s1', 'manual');

  assert.equal(store.history(50, 's1').length, 10, 's1 est plafonnée à 10');
  assert.equal(store.history(50, 's2').length, 1, 's2 est toujours là');
  assert.ok(store.lastRuns().s2, 's2 garde sa dernière action');
});

test('destination IMAP : le message est déposé tel quel', async (t) => {
  const pop3 = await startFakePop3({ messages: [MESSAGE_1] });
  const imap = await startFakeImap({});
  t.after(async () => {
    await pop3.close();
    await imap.close();
  });

  const { forwarder } = await buildStack(pop3.port, 0, {
    target: {
      kind: 'imap', port: imap.port, secure: false,
      user: 'moi@gmail.com', pass: 'secret', to: '',
      // Volontairement incohérent : sur un dépôt IMAP, le mode d'en-têtes n'a
      // pas à s'appliquer. Rien ne justifierait de réécrire quoi que ce soit.
      headerMode: 'gmail-safe',
    },
  });

  const entry = await forwarder.runSource('s1', 'manual');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.forwarded, 1);
  assert.equal(imap.state.appended.length, 1);

  const [deposited] = imap.state.appended;
  const { head, body } = splitMessage(deposited.body);

  assert.equal(getHeader(head, 'From'), 'Jean Dupont <jean@exemple.fr>');
  assert.equal(getHeader(head, 'Message-ID'), '<m1@exemple.fr>');
  assert.equal(getHeader(head, 'X-Original-From'), undefined, 'rien n’a été réécrit');
  assert.match(body.toString('latin1'), /Bonjour, voici la facture\./);

  // Faute d'adresse de dépôt, l'identifiant du compte tient le rôle.
  assert.equal(getHeader(head, 'Delivered-To'), 'moi@gmail.com');

  // Non lu, et daté du message plutôt que de la relève.
  assert.deepEqual(deposited.flags, []);
  assert.match(deposited.date, /^30-Jul-2026/);
  assert.equal(deposited.folder, 'INBOX');
});

test('destination IMAP : une panne du serveur laisse le message à relever', async (t) => {
  const pop3 = await startFakePop3({ messages: [MESSAGE_1] });
  const imap = await startFakeImap({ password: 'le-bon' });
  t.after(async () => {
    await pop3.close();
    await imap.close();
  });

  const { forwarder } = await buildStack(pop3.port, 0, {
    target: {
      kind: 'imap', port: imap.port, secure: false,
      user: 'moi@gmail.com', pass: 'le-mauvais', to: '',
    },
  });

  const failed = await forwarder.runSource('s1', 'manual');
  assert.equal(failed.status, 'error');
  assert.equal(failed.forwarded, 0);
  assert.match(failed.error, /identifiants refusés/);

  // Rien n'a été marqué comme traité : le message repasse au tour suivant.
  const retry = await forwarder.runSource('s1', 'manual');
  assert.equal(retry.total, 1);
});

test('destination API Gmail : le message est importé sans réécriture', async (t) => {
  const pop3 = await startFakePop3({ messages: [MESSAGE_1] });
  const google = await startFakeGoogle();
  t.after(async () => {
    await pop3.close();
    await google.close();
  });

  const { forwarder } = await buildStack(pop3.port, 0, {
    target: {
      kind: 'gmail-api', to: 'moi@gmail.com',
      oauthClientId: 'client-1', oauthClientSecret: 'secret-1', oauthRefreshToken: 'refresh-1',
      neverMarkSpam: false,
      // Comme pour l'IMAP : rien à réécrire, quel que soit le réglage.
      headerMode: 'gmail-safe',
    },
  });

  const entry = await forwarder.runSource('s1', 'manual');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.forwarded, 1);
  assert.equal(google.state.imports.length, 1);

  const { head, body } = splitMessage(google.state.imports[0].body);
  assert.equal(getHeader(head, 'From'), 'Jean Dupont <jean@exemple.fr>');
  assert.equal(getHeader(head, 'X-Original-From'), undefined);
  assert.equal(getHeader(head, 'Delivered-To'), 'moi@gmail.com');
  assert.match(body.toString('latin1'), /Bonjour, voici la facture\./);
});
