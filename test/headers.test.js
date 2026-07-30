'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMessage,
  decodeWords,
  formatAddress,
  foldHeader,
  getHeader,
  parseAddress,
  prependHeaders,
  removeHeaders,
  setHeader,
  splitMessage,
} = require('../dist/mail/headers');

const SAMPLE = Buffer.from(
  [
    'Return-Path: <expediteur@exemple.fr>',
    'DKIM-Signature: v=1; a=rsa-sha256; d=exemple.fr; s=mail;',
    ' bh=abcdef; b=signature',
    'From: =?UTF-8?B?SsOpcsO0bWU=?= <jerome@exemple.fr>',
    'To: moi@fai.fr',
    'Subject: =?ISO-8859-1?Q?D=E9jeuner_de_mardi?=',
    'Date: Wed, 30 Jul 2026 09:15:00 +0200',
    'Message-ID: <abc123@exemple.fr>',
    'Content-Type: text/plain; charset=ISO-8859-1',
    '',
    'Bonjour,',
    '.Une ligne qui commence par un point.',
    'Caf\xe9 en 8 bits.',
    '',
  ].join('\r\n'),
  'latin1',
);

test('découpe et recolle un message octet pour octet', () => {
  const parts = splitMessage(SAMPLE);
  assert.equal(buildMessage(parts).equals(SAMPLE), true);
});

test('le corps n’est jamais décodé', () => {
  const { body } = splitMessage(SAMPLE);
  // 0xe9 = « é » en ISO-8859-1 : un passage par une chaîne UTF-8 le détruirait.
  assert.equal(body.includes(0xe9), true);
});

test('recolle les en-têtes repliés sur plusieurs lignes', () => {
  const dkim = getHeader(splitMessage(SAMPLE).head, 'DKIM-Signature');
  assert.match(dkim, /bh=abcdef; b=signature$/);
  assert.equal(dkim.includes('\r\n'), false);
});

test('trouve un en-tête sans tenir compte de la casse', () => {
  const { head } = splitMessage(SAMPLE);
  assert.equal(getHeader(head, 'message-id'), '<abc123@exemple.fr>');
  assert.equal(getHeader(head, 'X-Absent'), undefined);
});

test('ajouter des en-têtes laisse les existants intacts', () => {
  const { head } = splitMessage(SAMPLE);
  const augmented = prependHeaders(head, [['Delivered-To', 'moi@gmail.com']]);

  assert.equal(augmented.startsWith('Delivered-To: moi@gmail.com\r\n'), true);
  // La signature DKIM ne survit que si tout ce qui la précédait est inchangé.
  assert.equal(augmented.includes(head), true);
});

test('retire des en-têtes sans toucher aux autres', () => {
  const { head } = splitMessage(SAMPLE);
  const stripped = removeHeaders(head, ['DKIM-Signature', 'Return-Path']);

  assert.equal(getHeader(stripped, 'DKIM-Signature'), undefined);
  assert.equal(getHeader(stripped, 'Return-Path'), undefined);
  assert.equal(getHeader(stripped, 'From'), '=?UTF-8?B?SsOpcsO0bWU=?= <jerome@exemple.fr>');
});

test('remplacer un en-tête n’en laisse qu’un', () => {
  const { head } = splitMessage(SAMPLE);
  const replaced = setHeader(head, 'From', 'relais@gmail.com');

  assert.equal(replaced.match(/^From:/gm).length, 1);
  assert.equal(getHeader(replaced, 'From'), 'relais@gmail.com');
});

test('replie les valeurs longues sur des lignes de continuation', () => {
  const value = Array.from({ length: 30 }, (_, i) => `mot${i}`).join(' ');
  const folded = foldHeader('X-Long', value);

  for (const line of folded.split('\r\n').filter(Boolean)) {
    assert.ok(line.length <= 78, `ligne trop longue : ${line.length}`);
  }
  // Le repli doit rester lisible comme une seule valeur.
  assert.equal(getHeader(folded, 'X-Long'), value);
});

test('décode les mots encodés RFC 2047', () => {
  assert.equal(decodeWords('=?UTF-8?B?SsOpcsO0bWU=?='), 'Jérôme');
  assert.equal(decodeWords('=?ISO-8859-1?Q?D=E9jeuner_de_mardi?='), 'Déjeuner de mardi');
  assert.equal(decodeWords('texte simple'), 'texte simple');
  // Deux mots encodés collés forment un seul texte, sans espace parasite.
  assert.equal(decodeWords('=?UTF-8?Q?Bon?= =?UTF-8?Q?jour?='), 'Bonjour');
  // Un charset inconnu ne doit pas faire tomber la redirection.
  assert.equal(typeof decodeWords('=?INEXISTANT?B?QQ==?='), 'string');
});

test('extrait une adresse de toutes les formes courantes', () => {
  assert.deepEqual(parseAddress('Jean Dupont <jean@exemple.fr>'), {
    name: 'Jean Dupont',
    address: 'jean@exemple.fr',
  });
  assert.deepEqual(parseAddress('"Dupont, Jean" <jean@exemple.fr>'), {
    name: 'Dupont, Jean',
    address: 'jean@exemple.fr',
  });
  assert.deepEqual(parseAddress('jean@exemple.fr'), { name: '', address: 'jean@exemple.fr' });
  assert.deepEqual(parseAddress('=?UTF-8?B?SsOpcsO0bWU=?= <j@e.fr>'), {
    name: 'Jérôme',
    address: 'j@e.fr',
  });
  assert.equal(parseAddress(''), null);
  assert.equal(parseAddress(undefined), null);
});

test('reforme une adresse en encodant ce qui doit l’être', () => {
  assert.equal(formatAddress({ name: '', address: 'a@b.fr' }), 'a@b.fr');
  assert.equal(formatAddress({ name: 'Jean', address: 'a@b.fr' }), 'Jean <a@b.fr>');
  assert.equal(formatAddress({ name: 'Dupont, Jean', address: 'a@b.fr' }), '"Dupont, Jean" <a@b.fr>');
  assert.match(formatAddress({ name: 'Jérôme', address: 'a@b.fr' }), /^=\?UTF-8\?B\?.+\?= <a@b\.fr>$/);
});

test('supporte un message sans corps et un message en LF seul', () => {
  const headersOnly = Buffer.from('From: a@b.fr\r\nSubject: rien\r\n', 'latin1');
  assert.equal(getHeader(splitMessage(headersOnly).head, 'Subject'), 'rien');

  const lfOnly = Buffer.from('From: a@b.fr\nSubject: LF\n\ncorps\n', 'latin1');
  const parts = splitMessage(lfOnly);
  assert.equal(parts.eol, '\n');
  assert.equal(getHeader(parts.head, 'Subject', '\n'), 'LF');
  assert.equal(parts.body.toString(), 'corps\n');
  assert.equal(buildMessage(parts).equals(lfOnly), true);
});
