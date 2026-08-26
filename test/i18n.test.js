'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Les traductions sont de simples fichiers JSON chargés au démarrage. Rien ne
 * les vérifie à l'exécution : une clé oubliée dans une langue s'afficherait
 * telle quelle à l'écran, en petit, chez quelqu'un qui ne parle pas français.
 * D'où ces tests.
 */

const PUBLIC = path.join(__dirname, '..', 'src', 'web', 'public');
const HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const I18N = path.join(PUBLIC, 'i18n');

const langs = fs.readdirSync(I18N).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const dictionaries = Object.fromEntries(
  langs.map((lang) => [lang, JSON.parse(fs.readFileSync(path.join(I18N, `${lang}.json`), 'utf8'))]),
);

/** Toutes les clés que l'interface demande : `t('clé')` et `this.t('clé')`. */
function usedKeys() {
  return new Set([...HTML.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]));
}

test('les six langues annoncées sont livrées', () => {
  assert.deepEqual(langs.sort(), ['de', 'en', 'es', 'fr', 'it', 'pt']);
  // Et la page ne propose que celles qui existent réellement.
  const declared = /const LANGS = \[([^\]]+)\]/.exec(HTML)[1];
  assert.deepEqual(
    declared.split(',').map((s) => s.trim().replace(/'/g, '')).sort(),
    langs.sort(),
  );
});

test('toutes les langues ont exactement les mêmes clés', () => {
  const reference = Object.keys(dictionaries.fr).sort();
  for (const lang of langs) {
    const keys = Object.keys(dictionaries[lang]).sort();
    const manquantes = reference.filter((k) => !keys.includes(k));
    const enTrop = keys.filter((k) => !reference.includes(k));
    assert.deepEqual(manquantes, [], `clés manquantes en ${lang}`);
    assert.deepEqual(enTrop, [], `clés en trop en ${lang}`);
  }
});

test('chaque clé utilisée par l’interface est traduite partout', () => {
  const used = [...usedKeys()].sort();
  assert.ok(used.length > 100, `seulement ${used.length} clés utilisées ?`);

  for (const lang of langs) {
    const absentes = used.filter((key) => dictionaries[lang][key] === undefined);
    assert.deepEqual(absentes, [], `clés absentes de ${lang}.json`);
  }
});

test('aucune traduction n’est vide, ni restée en français', () => {
  for (const lang of langs) {
    for (const [key, value] of Object.entries(dictionaries[lang])) {
      assert.equal(typeof value, 'string', `${lang}/${key} n'est pas du texte`);
      assert.notEqual(value.trim(), '', `${lang}/${key} est vide`);
      // Un copier-coller du français qui traîne : même texte long que la
      // référence, dans une langue qui n'est pas le français.
      if (lang !== 'fr' && value.length > 25) {
        assert.notEqual(value, dictionaries.fr[key], `${lang}/${key} est resté en français`);
      }
    }
  }
});

test('les paramètres d’une clé se retrouvent dans toutes les langues', () => {
  const parametres = (texte) => [...texte.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  for (const [key, reference] of Object.entries(dictionaries.fr)) {
    // `{{title}}` du gabarit de webhook n'est pas un paramètre de traduction.
    if (key === 'notify.webhookBodyHint') continue;
    for (const lang of langs) {
      assert.deepEqual(
        parametres(dictionaries[lang][key]),
        parametres(reference),
        `${lang}/${key} n'a pas les mêmes paramètres`,
      );
    }
  }
});

test('le gabarit ne contient plus de texte en dur', () => {
  const template = HTML.slice(HTML.indexOf('<div id="app">'), HTML.indexOf('<script src='));

  // Un attribut de libellé littéral : `label="Nom"` plutôt que `:label="t(…)"`.
  const litteraux = [...template.matchAll(/\s(?:label|title|hint|placeholder|messages)="([^"{}]+)"/g)]
    .map((m) => m[1])
    // Les valeurs techniques n'ont pas à être traduites.
    .filter((v) => !/^(INBOX|moi@gmail\.com|imap\.gmail\.com|smtp\.gmail\.com|[\w.-]+@[\w.-]+|Content-Type|URL|ntfy|Webhook|123456789-.*)$/.test(v));

  assert.deepEqual(litteraux, [], 'ces libellés ne passent pas par t()');
});

test('les fichiers de langue sont bien embarqués dans l’image', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  // `src/web/public` est copié en entier : les traductions suivent.
  assert.match(dockerfile, /COPY src\/web\/public \.\/web\/public/);
});
