'use strict';

const net = require('node:net');

/**
 * Serveur POP3 minimal, pour les tests.
 *
 * Implémente juste ce dont le client a besoin (RFC 1939) : greeting, USER,
 * PASS, STAT, LIST, UIDL, RETR, DELE, QUIT — avec le « dot-stuffing » réel,
 * parce que c'est précisément ce que le client doit savoir défaire.
 */
function startFakePop3(options = {}) {
  const messages = (options.messages ?? []).map((m, i) => ({
    uid: `uid-${i + 1}`,
    body: Buffer.isBuffer(m) ? m : Buffer.from(m, 'binary'),
    deleted: false,
  }));

  const state = { deleted: [], authenticated: false, user: null };

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.write('+OK serveur POP3 de test\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');

      let eol;
      while ((eol = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        handle(socket, line, messages, state, options);
      }
    });
    socket.on('error', () => undefined);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        messages,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function handle(socket, line, messages, state, options) {
  const [rawVerb, ...args] = line.split(' ');
  const verb = rawVerb.toUpperCase();
  const alive = () => messages.filter((m) => !m.deleted);

  switch (verb) {
    case 'USER':
      state.user = args[0];
      return socket.write('+OK\r\n');

    case 'PASS':
      if (options.password && args[0] !== options.password) {
        return socket.write('-ERR mot de passe invalide\r\n');
      }
      state.authenticated = true;
      return socket.write('+OK connecté\r\n');

    case 'CAPA':
      return socket.write('+OK\r\nUIDL\r\nTOP\r\n.\r\n');

    case 'STAT': {
      const live = alive();
      const size = live.reduce((n, m) => n + m.body.length, 0);
      return socket.write(`+OK ${live.length} ${size}\r\n`);
    }

    case 'LIST': {
      const lines = messages
        .map((m, i) => (m.deleted ? null : `${i + 1} ${m.body.length}`))
        .filter(Boolean);
      return socket.write(`+OK\r\n${lines.map((l) => l + '\r\n').join('')}.\r\n`);
    }

    case 'UIDL': {
      const lines = messages
        .map((m, i) => (m.deleted ? null : `${i + 1} ${m.uid}`))
        .filter(Boolean);
      return socket.write(`+OK\r\n${lines.map((l) => l + '\r\n').join('')}.\r\n`);
    }

    case 'RETR': {
      const message = messages[Number(args[0]) - 1];
      if (!message || message.deleted) return socket.write('-ERR message inconnu\r\n');
      if (options.failOn === Number(args[0])) return socket.write('-ERR lecture impossible\r\n');

      socket.write(`+OK ${message.body.length} octets\r\n`);
      socket.write(dotStuff(message.body));
      return socket.write('.\r\n');
    }

    case 'DELE': {
      const message = messages[Number(args[0]) - 1];
      if (!message) return socket.write('-ERR message inconnu\r\n');
      message.deleted = true;
      return socket.write('+OK marqué\r\n');
    }

    case 'QUIT':
      // Les suppressions ne deviennent effectives qu'au QUIT, comme le veut la RFC.
      state.deleted = messages.filter((m) => m.deleted).map((m) => m.uid);
      socket.write('+OK au revoir\r\n');
      return socket.end();

    default:
      return socket.write('-ERR commande inconnue\r\n');
  }
}

/** Double le point des lignes qui commencent par un point, et termine par CRLF. */
function dotStuff(body) {
  const withEol = body.subarray(body.length - 2).toString('latin1') === '\r\n'
    ? body
    : Buffer.concat([body, Buffer.from('\r\n')]);

  const text = withEol.toString('latin1');
  const stuffed = text.replace(/(^|\r\n)\./g, '$1..');
  return Buffer.from(stuffed, 'latin1');
}

module.exports = { startFakePop3 };
