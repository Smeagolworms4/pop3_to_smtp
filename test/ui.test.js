'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { compile } = require('@vue/compiler-dom');

/**
 * L'interface est un fichier HTML monolithique, compilé par le navigateur : une
 * faute de frappe dans une expression Vue ne se voit qu'à l'exécution, et donne
 * une page blanche. On la compile donc ici, et on vérifie que tout ce que le
 * gabarit référence existe réellement dans le composant.
 */

const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'web', 'public', 'index.html'),
  'utf8',
);

const template = HTML.slice(HTML.indexOf('<div id="app">'), HTML.indexOf('<script src='));

/**
 * Exécute le script de la page avec un Vue factice, et récupère les options
 * réellement passées à `createApp`. Plus fidèle qu'une expression régulière :
 * on inspecte l'objet tel que le navigateur le construira.
 */
function componentOptions() {
  const script = HTML.slice(
    HTML.lastIndexOf('<script>') + '<script>'.length,
    HTML.lastIndexOf('</script>'),
  );

  return new Function(`
    let captured = null;
    const Vue = { createApp: (options) => {
      captured = options;
      return { use: () => ({ mount: () => undefined }) };
    } };
    const Vuetify = { createVuetify: () => ({}) };
    ${script}
    return captured;
  `)();
}

/** Ce que le gabarit consomme : le compilateur préfixe ces noms par `_ctx.`. */
function templateIdentifiers() {
  const { code } = compile(template, { mode: 'module', prefixIdentifiers: true });
  return new Set([...code.matchAll(/_ctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
}

test('le gabarit Vue compile sans erreur', () => {
  const errors = [];
  compile(template, {
    onError: (err) => errors.push(`${err.message} (ligne ${err.loc?.start?.line})`),
    onWarn: () => undefined,
  });
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('tout ce que le gabarit référence est déclaré dans le composant', () => {
  const options = componentOptions();
  const declared = new Set([
    ...Object.keys(options.data()),
    ...Object.keys(options.computed ?? {}),
    ...Object.keys(options.methods ?? {}),
  ]);

  const missing = [...templateIdentifiers()].filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `référencés par le gabarit mais absents : ${missing.join(', ')}`);
});

test('aucune propriété du composant ne porte deux noms différents', () => {
  const options = componentOptions();
  const data = Object.keys(options.data());
  const computed = Object.keys(options.computed ?? {});
  const methods = Object.keys(options.methods ?? {});

  // Vue fusionne data, computed et methods dans le même espace de noms : un
  // doublon en écrase silencieusement un autre.
  const all = [...data, ...computed, ...methods];
  const duplicates = all.filter((name, i) => all.indexOf(name) !== i);
  assert.deepEqual(duplicates, [], `déclarés plusieurs fois : ${duplicates.join(', ')}`);
});

test('aucune ressource externe n’est référencée', () => {
  // L'interface doit fonctionner sans accès à Internet : tout vient de
  // node_modules, servi par l'application elle-même. Seul le lien d'aide vers
  // les mots de passe d'application Google sort, et c'est un lien cliquable,
  // pas une ressource chargée.
  const loaded = [...HTML.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)]
    .map((m) => m[1])
    .filter((url) => !url.startsWith('https://myaccount.google.com/'));

  assert.deepEqual(loaded, []);
});

test('l’aide Gmail pointe vers la bonne page', () => {
  assert.match(HTML, /https:\/\/myaccount\.google\.com\/apppasswords/);
  assert.match(HTML, /mot de passe d'application/i);
});
