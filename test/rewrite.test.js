'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { rewriteMessage, resolveHeaderMode } = require('../dist/mail/rewrite');
const { getHeader, splitMessage, decodeWords } = require('../dist/mail/headers');

const RAW = Buffer.from(
  [
    'Return-Path: <bounce@exemple.fr>',
    'DKIM-Signature: v=1; d=exemple.fr; b=signature',
    'From: =?UTF-8?B?SsOpcsO0bWU=?= <jerome@exemple.fr>',
    'To: moi@fai.fr',
    'Subject: Réunion',
    'Date: Wed, 30 Jul 2026 09:15:00 +0200',
    'Message-ID: <abc123@exemple.fr>',
    'In-Reply-To: <parent@exemple.fr>',
    'References: <parent@exemple.fr>',
    '',
    'Le corps, inchangé.',
    '',
  ].join('\r\n'),
  'latin1',
);

const source = {
  id: 's1', name: 'FAI', enabled: true, host: 'pop.fai.fr', port: 995,
  security: 'tls', user: 'moi@fai.fr', pass: 'x', targetId: 't1',
  deleteAfterFetch: false, allowInvalidCert: false,
};

const target = (overrides = {}) => ({
  id: 't1', name: 'Gmail', enabled: true, host: 'smtp.exemple.net', port: 587,
  secure: false, user: 'relais@exemple.net', pass: 'x', to: 'moi@gmail.com',
  from: '', headerMode: 'redirect', envelopeFrom: 'auto', newMessageId: false,
  allowInvalidCert: false, ...overrides,
});

test('le mode automatique reconnaît Gmail', () => {
  assert.equal(resolveHeaderMode(target({ headerMode: 'auto', host: 'smtp.gmail.com' })), 'gmail-safe');
  assert.equal(resolveHeaderMode(target({ headerMode: 'auto', host: 'smtp.mon-fai.fr' })), 'redirect');
  // Un réglage explicite l'emporte sur la détection.
  assert.equal(resolveHeaderMode(target({ headerMode: 'redirect', host: 'smtp.gmail.com' })), 'redirect');
});

test('redirection fidèle : le message reste celui de l’expéditeur', () => {
  const out = rewriteMessage(RAW, source, target());
  const { head, body } = splitMessage(out.message);

  assert.equal(getHeader(head, 'From'), '=?UTF-8?B?SsOpcsO0bWU=?= <jerome@exemple.fr>');
  assert.equal(getHeader(head, 'Subject'), 'Réunion');
  assert.equal(getHeader(head, 'Message-ID'), '<abc123@exemple.fr>');
  // Le fil de discussion doit rester rattaché à son parent.
  assert.equal(getHeader(head, 'In-Reply-To'), '<parent@exemple.fr>');
  // La signature d'origine survit : Gmail affichera « signé par exemple.fr ».
  assert.match(getHeader(head, 'DKIM-Signature'), /d=exemple\.fr/);
  assert.equal(body.toString('latin1'), 'Le corps, inchangé.\r\n');
});

test('redirection fidèle : les traces de passage sont ajoutées', () => {
  const out = rewriteMessage(RAW, source, target());
  const { head } = splitMessage(out.message);

  assert.equal(getHeader(head, 'Delivered-To'), 'moi@gmail.com');
  assert.equal(getHeader(head, 'X-Forwarded-To'), 'moi@gmail.com');
  assert.match(getHeader(head, 'Received'), /from pop\.fai\.fr by pop3-to-smtp/);
  // Le Return-Path d'origine n'a plus de sens une fois le message relayé.
  assert.equal(getHeader(head, 'Return-Path'), undefined);
  assert.equal(out.envelopeFrom, 'jerome@exemple.fr');
  assert.equal(out.envelopeTo, 'moi@gmail.com');
});

test('compatible Gmail : l’expéditeur reste lisible et la réponse part au bon endroit', () => {
  const out = rewriteMessage(RAW, source, target({ headerMode: 'gmail-safe' }));
  const { head } = splitMessage(out.message);

  const from = decodeWords(getHeader(head, 'From'));
  assert.match(from, /^Jérôme \(via moi@fai\.fr\) <relais@exemple\.net>$/);
  // C'est ce Reply-To qui fait qu'une réponse ne « choque » pas.
  assert.equal(getHeader(head, 'Reply-To'), '=?UTF-8?B?SsOpcsO0bWU=?= <jerome@exemple.fr>');
  assert.equal(getHeader(head, 'X-Original-From'), '=?UTF-8?B?SsOpcsO0bWU=?= <jerome@exemple.fr>');

  // Une signature qui ne vérifie plus est pire que pas de signature du tout.
  assert.equal(getHeader(head, 'DKIM-Signature'), undefined);
  assert.equal(out.envelopeFrom, 'relais@exemple.net');

  // Le reste ne bouge pas.
  assert.equal(getHeader(head, 'Subject'), 'Réunion');
  assert.equal(getHeader(head, 'Message-ID'), '<abc123@exemple.fr>');
  assert.equal(splitMessage(out.message).body.toString('latin1'), 'Le corps, inchangé.\r\n');
});

test('un Reply-To existant n’est pas écrasé', () => {
  const withReplyTo = Buffer.concat([Buffer.from('Reply-To: liste@exemple.fr\r\n'), RAW]);
  const out = rewriteMessage(withReplyTo, source, target({ headerMode: 'gmail-safe' }));

  assert.equal(getHeader(splitMessage(out.message).head, 'Reply-To'), 'liste@exemple.fr');
});

test('le Message-ID peut être regénéré, l’original est conservé', () => {
  const out = rewriteMessage(RAW, source, target({ newMessageId: true }));
  const { head } = splitMessage(out.message);

  assert.notEqual(getHeader(head, 'Message-ID'), '<abc123@exemple.fr>');
  assert.equal(getHeader(head, 'X-Original-Message-ID'), '<abc123@exemple.fr>');
});

test('l’enveloppe suit le réglage demandé', () => {
  assert.equal(rewriteMessage(RAW, source, target({ envelopeFrom: 'smtp' })).envelopeFrom,
    'relais@exemple.net');
  assert.equal(rewriteMessage(RAW, source, target({ envelopeFrom: 'original' })).envelopeFrom,
    'jerome@exemple.fr');
});

test('un message sans From ne fait pas échouer la redirection', () => {
  const orphan = Buffer.from('Subject: sans expéditeur\r\n\r\ncorps\r\n', 'latin1');
  const out = rewriteMessage(orphan, source, target({ headerMode: 'gmail-safe' }));
  const { head } = splitMessage(out.message);

  assert.match(getHeader(head, 'From'), /relais@exemple\.net/);
  assert.equal(out.envelopeFrom, 'relais@exemple.net');
});

test('les informations d’historique sont décodées pour l’affichage', () => {
  const { info } = rewriteMessage(RAW, source, target());

  assert.equal(info.fromAddress, 'jerome@exemple.fr');
  assert.match(info.from, /Jérôme/);
  assert.equal(info.subject, 'Réunion');
  assert.equal(info.date, 'Wed, 30 Jul 2026 09:15:00 +0200');
});

test('un identifiant SMTP sans domaine ne produit pas d’adresse invalide', () => {
  // Gmail accepte de s'authentifier avec « jean » plutôt que « jean@gmail.com ».
  // Repris tel quel, ça donnerait <jean> : un From et un MAIL FROM que le
  // serveur d'en face rejette.
  const t = target({ headerMode: 'gmail-safe', user: 'smeagolworms4', from: '', to: 'moi@gmail.com' });
  const out = rewriteMessage(RAW, source, t);
  const from = getHeader(splitMessage(out.message).head, 'From');

  assert.match(from, /<moi@gmail\.com>$/, 'le From doit retomber sur une vraie adresse');
  assert.match(out.envelopeFrom, /@/, "l'enveloppe ne doit jamais partir sans domaine");
  assert.equal(out.envelopeFrom, 'moi@gmail.com');
});

test('l’adresse d’envoi explicite reste prioritaire', () => {
  const t = target({ headerMode: 'gmail-safe', user: 'compte-nu', from: 'relais@exemple.net' });
  const out = rewriteMessage(RAW, source, t);

  assert.match(getHeader(splitMessage(out.message).head, 'From'), /<relais@exemple\.net>$/);
  assert.equal(out.envelopeFrom, 'relais@exemple.net');
});
