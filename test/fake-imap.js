'use strict';

const net = require('node:net');

/**
 * Serveur IMAP minimal, pour les tests.
 *
 * Il n'implémente que ce que le client utilise — CAPABILITY, LOGIN, STATUS,
 * APPEND, CREATE, LOGOUT — mais il le fait comme un vrai : le littéral d'APPEND
 * est lu **en octets**, après un `+` de continuation, et pas ligne par ligne.
 * C'est le seul moyen de vérifier qu'un message binaire ressort intact.
 */
function startFakeImap(options = {}) {
  const state = { appended: [], created: [], login: null, commands: [] };
  const folders = new Set(options.folders ?? ['INBOX']);

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    // Littéral en cours : { tag, folder, flags, date, size }
    let literal = null;

    socket.write('* OK serveur IMAP de test\r\n');

    const reply = (line) => socket.write(line + '\r\n');

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        if (literal) {
          // +2 : le CRLF que le client envoie derrière le littéral.
          if (buffer.length < literal.size + 2) return;
          const body = buffer.subarray(0, literal.size);
          buffer = buffer.subarray(literal.size + 2);

          state.appended.push({
            folder: literal.folder,
            flags: literal.flags,
            date: literal.date,
            body,
          });
          reply(`${literal.tag} OK [APPENDUID 1 ${state.appended.length}] (Success)`);
          literal = null;
          continue;
        }

        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.subarray(0, eol).toString('utf8');
        buffer = buffer.subarray(eol + 2);

        const [tag, name, ...rest] = line.split(' ');
        const command = (name || '').toUpperCase();
        state.commands.push(command);

        if (command === 'CAPABILITY') {
          reply(`* CAPABILITY IMAP4rev1 ${(options.capabilities ?? []).join(' ')}`.trimEnd());
          reply(`${tag} OK CAPABILITY terminé`);
        } else if (command === 'LOGIN') {
          const [user, pass] = parseArgs(rest.join(' '));
          if (options.password && pass !== options.password) {
            reply(`${tag} NO [AUTHENTICATIONFAILED] identifiants refusés`);
          } else {
            state.login = { user, pass };
            reply(`${tag} OK connecté`);
          }
        } else if (command === 'STATUS') {
          reply(`* STATUS ${rest[0]} (MESSAGES ${options.count ?? 0})`);
          reply(`${tag} OK STATUS terminé`);
        } else if (command === 'CREATE') {
          const [folder] = parseArgs(rest.join(' '));
          folders.add(folder);
          state.created.push(folder);
          reply(`${tag} OK dossier créé`);
        } else if (command === 'APPEND') {
          const parsed = parseAppend(rest.join(' '));
          if (options.refuseAppend) {
            reply(`${tag} NO quota dépassé`);
          } else if (!folders.has(parsed.folder)) {
            reply(`${tag} NO [TRYCREATE] dossier inconnu`);
          } else {
            literal = { tag, ...parsed };
            reply('+ prêt pour le littéral');
          }
        } else if (command === 'LOGOUT') {
          reply('* BYE au revoir');
          reply(`${tag} OK LOGOUT terminé`);
          socket.end();
        } else {
          reply(`${tag} BAD commande inconnue`);
        }
      }
    });
    socket.on('error', () => undefined);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** `"INBOX" (\Seen) "26-Aug-2026 12:00:00 +0200" {42}` */
function parseAppend(rest) {
  const size = Number(/\{(\d+)\}\s*$/.exec(rest)?.[1] ?? 0);
  const flags = /\(([^)]*)\)/.exec(rest)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
  const quoted = parseArgs(rest.replace(/\([^)]*\)/, ''));
  return { folder: quoted[0] ?? '', date: quoted[1] ?? '', flags, size };
}

/** Découpe une suite d'arguments entre guillemets, échappements compris. */
function parseArgs(rest) {
  const args = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let found;
  while ((found = pattern.exec(rest)) !== null) {
    if (found[1] !== undefined) args.push(found[1].replace(/\\(.)/g, '$1'));
    else if (!found[2].startsWith('{')) args.push(found[2]);
  }
  return args;
}

module.exports = { startFakeImap };
