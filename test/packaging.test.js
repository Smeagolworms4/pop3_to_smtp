'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

/** Dépendances embarquées dans l'image, hors outillage de développement. */
function productionPackages() {
  return Object.entries(lock.packages ?? {}).filter(
    ([name, meta]) => name.startsWith('node_modules/') && !meta.dev && !meta.devOptional,
  );
}

/**
 * L'image multi-architecture installe les dépendances sur la machine qui
 * construit (amd64) et copie `node_modules` tel quel dans l'image arm64 —
 * seule façon d'éviter QEMU, qui fait planter le V8 de Node/musl.
 *
 * Ce raccourci n'est valide que tant que rien n'est compilé pour une
 * architecture donnée. Ces tests sont la contrepartie de cette hypothèse : le
 * jour où une dépendance native entre dans le projet, ils tombent ici plutôt
 * que sur un Raspberry Pi.
 */
test('aucune dépendance de production n’est spécifique à une architecture', () => {
  const specific = productionPackages()
    .filter(([, meta]) => meta.os || meta.cpu)
    .map(([name, meta]) => `${name} (os=${meta.os}, cpu=${meta.cpu})`);

  assert.deepEqual(specific, []);
});

test('aucune dépendance de production ne compile à l’installation', () => {
  // Un script d'installation, c'est en général du node-gyp : un binaire
  // construit pour la machine qui installe, donc inutilisable ailleurs.
  const compiled = productionPackages()
    .filter(([, meta]) => meta.hasInstallScript)
    .map(([name]) => name);

  assert.deepEqual(compiled, []);
});

test('les dépendances sont installées hors émulation', () => {
  // Si cette ligne disparaît, `npm ci` retombe sous QEMU et la construction
  // arm64 meurt en « illegal instruction » — l'erreur est déroutante, autant
  // la rendre impossible.
  assert.match(
    dockerfile,
    /FROM --platform=\$BUILDPLATFORM node:.* AS builder/,
    "l'étape de compilation doit rester sur l'architecture de la machine qui construit",
  );

  const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  assert.equal(
    /^\s*RUN\s+npm\b/m.test(finalStage),
    false,
    "l'image finale ne doit exécuter aucun npm : elle peut être émulée",
  );
});

test('l’image embarque bien l’interface et le code compilé', () => {
  assert.match(dockerfile, /COPY --from=builder \/app\/node_modules/);
  assert.match(dockerfile, /COPY --from=builder \/app\/dist/);
  assert.match(dockerfile, /COPY src\/web\/public \.\/web\/public/);
});
