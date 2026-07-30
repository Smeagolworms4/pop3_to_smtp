/**
 * Manipulation d'un message brut (RFC 5322) au niveau octet.
 *
 * Deux règles qui expliquent tout le fichier :
 *
 * 1. **On ne touche jamais au corps.** Il reste un Buffer, jamais décodé : les
 *    pièces jointes, les encodages exotiques et les signatures passent tels
 *    quels. C'est ce qui fait qu'un message redirigé ressemble à l'original.
 * 2. **On ajoute en tête plutôt que de modifier.** La signature DKIM du domaine
 *    expéditeur ne couvre que les en-têtes existants au moment de la signature :
 *    tant qu'on se contente de préfixer des lignes, elle reste valide et Gmail
 *    affiche « signé par : domaine-d-origine ».
 *
 * Le bloc d'en-tête est manipulé en `latin1`, qui fait un aller-retour exact
 * octet ↔ caractère : aucune perte, même sur un en-tête 8 bits mal formé.
 */

export interface SplitMessage {
  /** Bloc d'en-tête, terminé par son saut de ligne. */
  head: string;
  /** Corps brut, intouché. */
  body: Buffer;
  /** Fin de ligne utilisée par le message ('\r\n' sauf serveur exotique). */
  eol: string;
}

export interface Address {
  name: string;
  address: string;
}

const CRLF = '\r\n';

/** Sépare en-têtes et corps sans rien décoder. */
export function splitMessage(raw: Buffer): SplitMessage {
  const iCrlf = raw.indexOf('\r\n\r\n');
  const iLf = raw.indexOf('\n\n');

  if (iCrlf !== -1 && (iLf === -1 || iCrlf <= iLf)) {
    return {
      head: raw.subarray(0, iCrlf + 2).toString('latin1'),
      body: raw.subarray(iCrlf + 4),
      eol: CRLF,
    };
  }
  if (iLf !== -1) {
    return {
      head: raw.subarray(0, iLf + 1).toString('latin1'),
      body: raw.subarray(iLf + 2),
      eol: '\n',
    };
  }
  // Pas de corps : message tronqué ou en-têtes seuls.
  const head = raw.toString('latin1');
  return {
    head: head.endsWith('\n') ? head : head + CRLF,
    body: Buffer.alloc(0),
    eol: head.includes(CRLF) || !head.includes('\n') ? CRLF : '\n',
  };
}

/** Recolle un message découpé par `splitMessage`. */
export function buildMessage(parts: SplitMessage): Buffer {
  return Buffer.concat([Buffer.from(parts.head, 'latin1'), Buffer.from(parts.eol, 'latin1'), parts.body]);
}

interface RawHeader {
  name: string;
  /** Valeur dépliée (les sauts de ligne de repli sont retirés). */
  value: string;
  /** Texte d'origine, replis compris, terminé par son saut de ligne. */
  raw: string;
}

/** Découpe le bloc d'en-tête en champs, replis recollés. */
export function parseHeaders(head: string, eol = CRLF): RawHeader[] {
  const out: RawHeader[] = [];
  const lines = head.split(eol);
  // Le split laisse une chaîne vide finale : le bloc se termine par un eol.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  for (const line of lines) {
    const isFold = /^[ \t]/.test(line);
    if (isFold && out.length) {
      const last = out[out.length - 1];
      last.value += ' ' + line.trim();
      last.raw += eol + line;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue; // ligne invalide : on la laisse tomber
    out.push({
      name: line.slice(0, colon).trim(),
      value: line.slice(colon + 1).trim(),
      raw: line,
    });
  }
  return out;
}

/** Valeur dépliée du premier champ portant ce nom (insensible à la casse). */
export function getHeader(head: string, name: string, eol = CRLF): string | undefined {
  const wanted = name.toLowerCase();
  return parseHeaders(head, eol).find((h) => h.name.toLowerCase() === wanted)?.value;
}

export function hasHeader(head: string, name: string, eol = CRLF): boolean {
  return getHeader(head, name, eol) !== undefined;
}

/** Retire tous les champs portant un de ces noms. */
export function removeHeaders(head: string, names: string[], eol = CRLF): string {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  const kept = parseHeaders(head, eol).filter((h) => !drop.has(h.name.toLowerCase()));
  return kept.map((h) => h.raw + eol).join('');
}

/**
 * Retire les champs dont le nom commence par un de ces préfixes (`ARC-`…).
 */
export function removeHeadersByPrefix(head: string, prefixes: string[], eol = CRLF): string {
  const lower = prefixes.map((p) => p.toLowerCase());
  const kept = parseHeaders(head, eol).filter(
    (h) => !lower.some((p) => h.name.toLowerCase().startsWith(p)),
  );
  return kept.map((h) => h.raw + eol).join('');
}

/**
 * Ajoute des champs **en tête** du bloc, comme le fait un MTA qui relaie :
 * l'ordre chronologique se lit de haut en bas et la signature DKIM survit.
 */
export function prependHeaders(head: string, fields: Array<[string, string]>, eol = CRLF): string {
  const added = fields.map(([name, value]) => foldHeader(name, value, eol)).join('');
  return added + head;
}

/** Remplace un champ (ou l'ajoute en tête s'il n'existe pas). */
export function setHeader(head: string, name: string, value: string, eol = CRLF): string {
  return prependHeaders(removeHeaders(head, [name], eol), [[name, value]], eol);
}

/**
 * Replie un en-tête sur ~78 colonnes, aux espaces uniquement : on ne coupe
 * jamais au milieu d'un mot encodé, ce qui casserait son décodage.
 */
export function foldHeader(name: string, value: string, eol = CRLF): string {
  const prefix = `${name}: `;
  const words = value.split(/\s+/).filter(Boolean);
  if (!words.length) return `${prefix}${eol}`;

  const lines: string[] = [];
  let current = prefix + words[0];

  for (const word of words.slice(1)) {
    if (current.length + 1 + word.length > 78) {
      lines.push(current);
      current = ' ' + word; // repli : le champ continue après un espace
    } else {
      current += ' ' + word;
    }
  }
  lines.push(current);
  return lines.join(eol) + eol;
}

// --- Adresses ---------------------------------------------------------------

/**
 * Extrait la première adresse d'un champ `From:` / `To:`.
 * Volontairement tolérant : un en-tête un peu tordu ne doit pas faire échouer
 * une redirection, au pire on n'affiche pas le nom.
 */
export function parseAddress(value: string | undefined): Address | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;

  // "Nom" <adresse> — le nom peut contenir des virgules, donc on cherche
  // d'abord la forme chevronnée avant de découper sur les virgules.
  const angled = raw.match(/^(.*?)<([^>]*)>/s);
  if (angled) {
    let name = angled[1].trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1');
    return { name: decodeWords(name).trim(), address: angled[2].trim() };
  }

  const first = raw.split(',')[0].trim();
  return { name: '', address: first };
}

const NEEDS_QUOTES = /[(),.:;<>@[\]\\"]/;

/** Reforme un `Nom <adresse>` sûr : nom encodé si besoin, guillemets si besoin. */
export function formatAddress(addr: Address): string {
  const address = addr.address.trim();
  const name = (addr.name || '').trim();
  if (!name) return address;

  const encoded = encodeWord(name);
  if (encoded !== name) return `${encoded} <${address}>`;
  const quoted = NEEDS_QUOTES.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name;
  return `${quoted} <${address}>`;
}

// --- RFC 2047 ---------------------------------------------------------------

/** Encode en mot encodé UTF-8 si la chaîne sort de l'ASCII imprimable. */
export function encodeWord(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

/**
 * Décode les mots encodés d'un en-tête, pour l'affichage uniquement (les
 * messages redirigés, eux, gardent leurs en-têtes d'origine tels quels).
 */
export function decodeWords(text: string): string {
  if (!text || !text.includes('=?')) return text;

  // Deux mots encodés séparés par du seul blanc forment un texte continu :
  // le blanc est un artefact de repli, pas un espace du message (RFC 2047 §6.2).
  const joined = text.replace(/(\?=)\s+(=\?)/g, '$1$2');

  return joined.replace(ENCODED_WORD, (whole, charset: string, encoding: string, data: string) => {
    try {
      const bytes =
        encoding.toLowerCase() === 'b'
          ? Buffer.from(data, 'base64')
          : Buffer.from(data.replace(/_/g, ' ').replace(/=([\da-f]{2})/gi, (_m, hex) =>
              String.fromCharCode(parseInt(hex, 16)),
            ), 'latin1');
      return decodeBytes(bytes, charset);
    } catch {
      return whole; // charset inconnu : mieux vaut l'afficher brut que planter
    }
  });
}

function decodeBytes(bytes: Buffer, charset: string): string {
  const cs = charset.toLowerCase().replace(/^"|"$/g, '').split('*')[0];
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** Date d'en-tête au format RFC 5322 (`Wed, 30 Jul 2026 14:05:00 +0000`). */
export function rfc2822Date(d: Date = new Date()): string {
  return d.toUTCString().replace('GMT', '+0000');
}

/** Message-ID unique, utilisé quand on choisit d'en regénérer un. */
export function makeMessageId(domain = 'pop3-to-smtp.local'): string {
  const rand = Math.random().toString(36).slice(2, 12);
  return `<${Date.now().toString(36)}.${rand}@${domain}>`;
}
