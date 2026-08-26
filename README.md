# pop3_to_smtp

[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/coffee.png)](https://www.buymeacoffee.com/smeagolworms4)
[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/paypal.png)](https://www.paypal.com/donate/?business=SURRPGEXF4YVU&no_recurring=0&item_name=Hello%2C+I%27m+SmeagolWorms4.+For+my+open+source+projects.%0AThanks+you+very+mutch+%21%21%21&currency_code=EUR)

*Read this in [French](https://github.com/Smeagolworms4/pop3_to_smtp/blob/main/README.fr.md).*

Collects your POP3 mailboxes and **forwards** everything to Gmail — by dropping straight
into it over IMAP, or through any SMTP server. A replacement for Gmail's "Check mail from
other accounts" feature, which is slow, unreliable and silently gives up. NestJS + Vue 3 / Vuetify, runs in Docker,
configured entirely from a web interface.

[![Docker Pulls](https://img.shields.io/docker/pulls/smeagolworms4/pop3_to_smtp)](https://hub.docker.com/r/smeagolworms4/pop3_to_smtp)
[![Image Size](https://img.shields.io/docker/image-size/smeagolworms4/pop3_to_smtp/latest)](https://hub.docker.com/r/smeagolworms4/pop3_to_smtp)
![arch](https://img.shields.io/badge/arch-amd64%20%7C%20arm64-6ee7a8)

## What it does

- **Collects** as many POP3 mailboxes as you like, on a schedule you choose.
- **Forwards** each message to the destination of your choice — one destination per
  mailbox, as many destinations as you want.
- **Two ways to deliver**: an **IMAP drop**, which files the message straight into the
  mailbox without going through any outgoing server, or a classic **SMTP send**. The
  first is the only one where Gmail does not display collected messages as sent by you
  (see *[The IMAP drop](#the-imap-drop-the-message-untouched-even-on-gmail)*).
- **Keeps the original message intact**: sender, subject, date, `Message-ID`, thread,
  attachments and even the DKIM signature. In Gmail it reads like a real redirection,
  not like a bot-generated copy (see *[Making it look like a real
  redirection](#making-it-look-like-a-real-redirection)*).
- **Copy or move**: leave the messages on the POP3 server, or delete them once they
  have been delivered.
- **Per-mailbox settings**: each mailbox has its own collection interval and its own
  per-pass cap, or simply follows the global ones.
- **Web interface** (port 8080, Vue 3 + Vuetify): add mailboxes and destinations,
  force a refresh, see the state of the last action **of each mailbox**, and open its
  own history — message by message, errors included.
- **Every setting is checked when saved**, and a *Test* button lets you re-run the
  check whenever you want.
- **Alerts on failure** by e-mail, ntfy, generic webhook or SMS (Free Mobile API).
- Everything is stored in plain JSON files under `data/`, so a backup is a file copy.

## Getting started

Nothing to clone, nothing to build: the image is published on
[Docker Hub](https://hub.docker.com/r/smeagolworms4/pop3_to_smtp). Create an empty
folder and put this `docker-compose.yml` in it:

```yaml
services:
  pop3-to-smtp:
    image: smeagolworms4/pop3_to_smtp:latest
    container_name: pop3-to-smtp
    restart: unless-stopped
    # Gives the current collection time to finish instead of cutting mid-send.
    stop_grace_period: 30s
    # Writes into ./data with your own UID rather than as root.
    user: "${PUID:-1000}:${PGID:-1000}"
    env_file:
      - .env
    ports:
      - "${WEB_PORT_HOST:-8080}:8080"
    volumes:
      - ./data:/data
```

Then, next to it:

```bash
touch .env            # may stay empty: everything is configurable from the interface
mkdir data
docker compose up -d
```

`env_file` is mandatory, so the `.env` file has to exist — but it may perfectly well be
empty. Set `PUID`/`PGID` in it if your user is not `1000:1000`, and `WEB_PORT_HOST` if
port 8080 is taken. See `.env.example` for the full list.

Then open **http://localhost:8080** and, in this order:

1. **Add a destination** — the SMTP server messages will leave through, and the address
   they should be dropped into.
2. **Add a POP3 mailbox** — and pick the destination it should be forwarded to.

Each save runs a real connection test and tells you what went wrong if anything did.
After that, nothing left to do: the timer handles the rest.

### The single-command equivalent

```bash
docker run -d \
  --name pop3-to-smtp \
  --restart unless-stopped \
  --stop-timeout 30 \
  --user 1000:1000 \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  smeagolworms4/pop3_to_smtp:latest
```

### Gmail: you need an app password

Gmail's SMTP server **rejects your account password**. You have to generate a
16-character *app password*, which requires two-step verification to be enabled on the
account first.

👉 **https://myaccount.google.com/apppasswords**

The interface shows this link directly in the destination form as soon as it detects a
Gmail server, along with the *Pre-fill for Gmail* button (`smtp.gmail.com`, port 587,
STARTTLS).

### Without Docker

```bash
npm install
npm run build
DATA_DIR=./data node dist/main.js
```

## Making it look like a real redirection

This is the whole point of the tool, and the part worth understanding.

A naive forwarder rebuilds a new message, and Gmail shows it as coming from your relay,
with the original mail quoted inside — replying then writes to the wrong person. Here,
the message is **relayed, not rebuilt**: the raw bytes come off the POP3 server and go
straight to the SMTP server. Two rules make that possible:

1. **The body is never decoded.** It stays a raw buffer from end to end, so
   attachments, exotic encodings and 8-bit content arrive byte for byte.
2. **Headers are only ever added on top.** A DKIM signature only covers the headers
   that existed when it was applied: as long as we merely prepend lines, it stays
   valid — and Gmail displays *"signed by: original-domain.com"*.

On top of that, the tool adds the trace headers a real mail server would
(`Delivered-To`, `Received`, `X-Forwarded-To`, `X-Forwarded-For`).

### The IMAP drop: the message untouched, even on Gmail

A destination comes in two flavours: an **SMTP send** or an **IMAP drop**. The latter
opens an IMAP session on the receiving mailbox and **files** the message there with an
`APPEND`, exactly the way a mail migration tool does.

Nothing is sent, so nothing can be rewritten: the `From:` stays the original sender's,
the DKIM signature stays valid, and neither SPF nor DMARC has any say — no message ever
travels. **This is the only way to stop Gmail showing every collected message as sent by
you**, which it does as soon as the `From:` carries your own account address.

All it takes is an IMAP server and the same app password the SMTP side uses:

| Field | Value for Gmail |
|---|---|
| IMAP server | `imap.gmail.com`, direct TLS, port `993` |
| Username | the full account address |
| Password | the 16-character app password |
| Folder | `INBOX` — or any label, created on demand |

Messages arrive **unread** (an option drops them already read, without a notification)
and **dated from their original date** rather than from the collection time, so a mailbox
collected in one go still files itself in the right order.

One thing to know: a dropped message does not go through Gmail's filters. Neither the
spam filter nor your own rules — it lands directly in the chosen folder.

### Two header modes, and why

These modes only apply to an **SMTP send**: an IMAP drop never rewrites anything, and the
interface hides those settings when the destination is one.

| Mode | What it does | When |
|---|---|---|
| **Faithful redirection** | The message goes out untouched: original `From`, original signature. | Any SMTP server that accepts sending on behalf of a third party: your ISP, a self-hosted relay, a transactional service. |
| **Gmail-compatible** | `From` becomes `Original Name (via your-mailbox@isp.fr) <your@gmail.com>`, and `Reply-To` points at the real sender. | `smtp.gmail.com`. |

The mode defaults to **Automatic**, which picks Gmail-compatible for
`smtp.gmail.com` and faithful redirection everywhere else. You can force either one per
destination.

**Why the second mode exists**: Gmail's submission server rewrites the `From:` header
whenever it is not the authenticated account (or a verified alias). Keeping the original
sender there is simply not possible — so rather than suffer a rewrite that leaves a
broken DKIM signature behind, the tool does it cleanly: the sender's name stays visible,
the original address goes into `X-Original-From`, and **`Reply-To` makes "Reply" write to
the right person**. Subject, date, `Message-ID` and threading headers are untouched
either way, so conversations still group correctly.

> **If you want the untouched version with a Gmail destination**, use an **IMAP drop**
> destination: that is exactly what it is for, and there is nothing else to configure.
> Failing that, do not send *through* Gmail but *to* the Gmail address through any other
> SMTP server (your ISP's, a relay you host, a transactional provider) in *Faithful
> redirection* mode — bearing in mind that the original sender's DMARC policy still
> applies: `p=reject` (LinkedIn, banks, most large senders) will get the message
> rejected. A domain of your own with SPF and DKIM makes this rock solid, but it is not
> required to get started.

### Envelope sender

The envelope sender (`MAIL FROM`) is what SPF checks and where bounces go. Automatic
mode uses the original sender in faithful mode, and the SMTP account in Gmail-compatible
mode — which is what authenticated relays require. You can force either.

## Configuration

Mailboxes, destinations and preferences live in `data/config.json` and are edited from
the interface. The `.env` file only holds what is specific to the deployment:

| Variable | Default | Purpose |
|---|---|---|
| `TZ` | `Europe/Paris` | Time zone for displayed and logged dates |
| `PUID` / `PGID` | `1000` | Owner of the `data` folder |
| `WEB_PORT_HOST` | `8080` | Host-side port if 8080 is taken |
| `WEB_USER` / `WEB_PASSWORD` | empty | Basic auth on the interface **and** the API |
| `REFRESH_MINUTES` | `10` | Delay between two collections. `0` disables the timer |
| `RUN_ON_START` | `true` | Collect once when the container starts |
| `MAX_PER_RUN` | `50` | Messages handled per mailbox per pass. `0` = no cap |
| `MAX_SIZE_MB` | `25` | Messages above this are skipped. `0` = no limit |
| `HISTORY_MAX` | `200` | Actions kept **per mailbox** in the history (10 minimum) |
| `POP3_TIMEOUT` / `SMTP_TIMEOUT` / `IMAP_TIMEOUT` | `60000` | Network timeouts, in milliseconds |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

The five middle ones are **defaults**: they can be changed from the interface, and the
change applies immediately. But a variable that is **set in `.env` locks the setting**:
the field appears greyed out with the name of the variable responsible. Handy to pin a
value down in a managed deployment, annoying when unintentional — hence the commented-out
lines in `.env.example`.

## Alerts

Three categories, each of which can be enabled separately: **failure** (on by default),
**successful forward**, and **every collection**.

Channels: e-mail (reusing one of your destinations' SMTP), **ntfy**, a **generic
webhook** with a free-form template (`{{title}}` / `{{text}}`, enough to plug in Gotify,
Home Assistant, Discord or Slack), and **SMS through the Free Mobile API**.

A failure alert lists the mailbox, the destination, the error, and the first messages
that failed with their reason. The *Send a test* button saves the form first, then fires
on every configured channel and reports each result.

## Good to know

- **First collection on an existing mailbox forwards everything it contains.** If the
  mailbox holds ten years of archives and you do not want them, use the 📋 button on the
  mailbox card: it marks the current content as already handled without sending anything.
- **A message is only marked as handled once the SMTP server has accepted it**, and only
  deleted from the source after that. A crash mid-collection costs you a duplicate at
  worst, never a lost message.
- **Move mode empties the source mailbox.** Deletions are only committed on `QUIT`, as
  the protocol mandates, so an interrupted collection leaves everything in place. Still:
  make sure the destination works before switching it on.
- `MAX_PER_RUN` spreads a large mailbox over several passes rather than flooding the
  destination SMTP in one go.
- POP3 has no folders and no notion of "read": the tool tracks what it has already seen
  by `UIDL`, the stable identifier the server assigns to each message.

## Architecture

```
src/
  main.ts                 HTTP server, static assets, vendor files
  env.ts                  .env → defaults, and which settings it locks
  scheduler.service.ts    the timer (re-armed after each pass, never overlapping)
  store/
    store.service.ts      data/config.json + data/state.json, atomic writes
  mail/
    pop3.ts               POP3 client (RFC 1939), hand-written, no dependency
    imap.ts               IMAP client (RFC 3501), trimmed to LOGIN, APPEND, STATUS
    rewrite.ts            header handling: the heart of the fidelity work
    headers.ts            byte-level RFC 5322 manipulation, RFC 2047 decoding
    smtp.service.ts       nodemailer, raw sending with an explicit envelope
    delivery.ts           the delivery channel: SMTP send or IMAP drop
    forwarder.service.ts  orchestration: collect → rewrite → deliver → record
  notify/notify.service.ts  e-mail / ntfy / webhook / SMS
  api/api.controller.ts   the REST API
  web/public/index.html   the whole interface, in one file, no build step
```

The POP3 client is hand-written on purpose. The protocol is ten commands and has not
changed since 1996, whereas the npm packages implementing it do break — `node-pop3`
0.15 ships ESM code inside a `.cjs` file, which simply cannot be loaded. Two hundred
lines under our control beat a dependency that needs fixing.

Vue, Vuetify and the icons are served from `node_modules`, never from a CDN: the
interface works on a network with no Internet access, and will not break the day a CDN
changes its URLs.

## Tests

```bash
npm test
```

67 tests, no network access needed: a fake POP3 server, a fake IMAP server and a real
SMTP server (`smtp-server`) are started on the fly. They cover byte-for-byte preservation
of an 8-bit message, dot-stuffing, folded headers, RFC 2047 decoding, both header modes,
the IMAP drop (literal, flags, internal date, folder creation, modified UTF-7 names),
absence of duplicates across two collections, move mode, an SMTP or IMAP rejection
leaving the message in place, oversized messages, concurrent collections, and persistence
across a restart.

They run on every push through GitHub Actions, on Node 22 and 24.

## Docker Hub image and automatic publication

**https://hub.docker.com/r/smeagolworms4/pop3_to_smtp**

Published for `linux/amd64` and `linux/arm64` from a single multi-arch manifest — the
same tag works on a PC, a NAS and a Raspberry Pi.

| Tag | Built on |
|---|---|
| `latest` | every push to `main`, and every git tag — the one to use |
| `main` | every push to the `main` branch |
| `<version>` (e.g. `1.0.0`) | creation of a git tag of that name, to pin a version |

### GitHub secrets to create by hand

Two workflows are provided in `.github/workflows/`: `build_images.yml` (multi-arch build
and push) and `push_readme.yml` (syncs the Docker Hub description from this README).
Both need **two repository secrets**, to be added in *Settings → Secrets and variables →
Actions*:

| Secret | Content |
|---|---|
| `DOCKER_USERNAME` | your Docker Hub username (also used to build the image name) |
| `DOCKER_PASSWORD` | a Docker Hub *access token* |

Without those two secrets, the workflows fail at the Docker Hub login step.

## Troubleshooting

**"Invalid login: 535-5.7.8 Username and Password not accepted"** — Gmail is refusing
your account password. Generate an [app
password](https://myaccount.google.com/apppasswords).

**Messages arrive from my own address instead of the sender's** — that is
Gmail-compatible mode, and it is expected when sending through `smtp.gmail.com`. The
original sender is on the *Reply-To* line, so replying works. To get the untouched
version, send through another SMTP server: see *[Making it look like a real
redirection](#making-it-look-like-a-real-redirection)*.

**Gmail hides some messages** — Gmail deduplicates by `Message-ID`, which is preserved
on purpose. If a message was already in the account, the copy is hidden. Turn on
*Regenerate the Message-ID* on the destination if it bothers you, at the cost of losing
the thread grouping.

**Same messages forwarded over and over** — some POP3 servers hand out a different
`UIDL` on every session. Switch the mailbox to move mode: what has been sent is deleted,
so nothing can come back.

**The collection never ends** — raise `POP3_TIMEOUT` and `SMTP_TIMEOUT`, or lower
`MAX_PER_RUN`. The history records the duration of each pass.

## Security

The POP3 and SMTP passwords are stored **in clear text** in `data/config.json` — the
protocols require them in clear, so there is nothing to gain from encrypting them next
to the key. Treat that folder as a secret, and set `WEB_USER` / `WEB_PASSWORD` as soon
as the interface leaves your local network: the API exposes the same configuration.

Passwords never travel back to the browser: the interface receives a mask, and sending
that mask back means "keep the current one".
