# pop3_to_smtp

[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/coffee.png)](https://www.buymeacoffee.com/smeagolworms4)
[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/paypal.png)](https://www.paypal.com/donate/?business=SURRPGEXF4YVU&no_recurring=0&item_name=Hello%2C+I%27m+SmeagolWorms4.+For+my+open+source+projects.%0AThanks+you+very+mutch+%21%21%21&currency_code=EUR)

*Read this in [English](https://github.com/Smeagolworms4/pop3_to_smtp/blob/main/README.md).*

Relève vos boîtes POP3 et **redirige** tout vers Gmail — par dépôt IMAP direct, ou vers
n'importe quel serveur SMTP. De quoi remplacer la récupération POP3 de Gmail, lente, capricieuse et qui
abandonne en silence. NestJS + Vue 3 / Vuetify, tourne dans Docker, tout se configure
depuis une interface web.

[![Docker Pulls](https://img.shields.io/docker/pulls/smeagolworms4/pop3_to_smtp)](https://hub.docker.com/r/smeagolworms4/pop3_to_smtp)
[![Image Size](https://img.shields.io/docker/image-size/smeagolworms4/pop3_to_smtp/latest)](https://hub.docker.com/r/smeagolworms4/pop3_to_smtp)
![arch](https://img.shields.io/badge/arch-amd64%20%7C%20arm64-6ee7a8)

## Ce que ça fait

- **Relève** autant de boîtes POP3 que vous voulez, au rythme que vous choisissez.
- **Redirige** chaque message vers la destination de votre choix — une destination par
  boîte, autant de destinations que nécessaire.
- **Deux façons de livrer** : le **dépôt IMAP**, qui range le message dans la boîte sans
  passer par le moindre serveur d'envoi, ou l'**envoi SMTP** classique. Le premier est le
  seul où Gmail n'affiche pas les messages relevés comme envoyés par vous (voir
  *[Le dépôt IMAP](#le-dépôt-imap--le-message-intact-même-chez-gmail)*).
- **Garde le message d'origine intact** : expéditeur, objet, date, `Message-ID`, fil de
  discussion, pièces jointes, et jusqu'à la signature DKIM. Dans Gmail, ça se lit comme
  une vraie redirection, pas comme une copie fabriquée par un robot (voir
  *[Ressembler à une vraie redirection](#ressembler-à-une-vraie-redirection)*).
- **Copie ou déplacement** : les messages restent sur le serveur POP3, ou sont supprimés
  une fois remis.
- **Réglages par boîte** : chacune a son propre délai de relève et son propre plafond
  par passage, ou suit simplement les réglages globaux.
- **Interface web** (port 8080, Vue 3 + Vuetify) : ajout des boîtes et des destinations,
  relève forcée, état de la dernière action **de chaque boîte** — et un clic ouvre son
  historique propre, message par message, erreurs comprises.
- **Chaque configuration est vérifiée à l'enregistrement**, et un bouton *Tester* permet
  de relancer la vérification quand on veut.
- **Alertes en cas d'échec** par e-mail, ntfy, webhook générique ou SMS (API Free Mobile).
- Tout est enregistré dans de simples fichiers JSON sous `data/` : une sauvegarde, c'est
  une copie de fichier.

## Démarrage

Rien à cloner, rien à compiler : l'image est publiée sur
[Docker Hub](https://hub.docker.com/r/smeagolworms4/pop3_to_smtp). Créez un dossier vide
et mettez-y ce `docker-compose.yml` :

```yaml
services:
  pop3-to-smtp:
    image: smeagolworms4/pop3_to_smtp:latest
    container_name: pop3-to-smtp
    restart: unless-stopped
    # Laisse le temps de finir la relève en cours plutôt que de couper au milieu.
    stop_grace_period: 30s
    # Écrit dans ./data avec ton UID plutôt qu'en root.
    user: "${PUID:-1000}:${PGID:-1000}"
    env_file:
      - .env
    ports:
      - "${WEB_PORT_HOST:-8080}:8080"
    volumes:
      - ./data:/data
```

Puis, à côté :

```bash
touch .env            # peut rester vide : tout se configure depuis l'interface
mkdir data
docker compose up -d
```

`env_file` est obligatoire, donc le fichier `.env` doit exister — mais il peut très bien
être vide. Renseignez-y `PUID`/`PGID` si votre utilisateur n'est pas `1000:1000`, et
`WEB_PORT_HOST` si le port 8080 est déjà pris. Voir `.env.example` pour la liste complète.

Ouvrez ensuite **http://localhost:8080** et, dans cet ordre :

1. **Ajoutez une destination** — le serveur SMTP par lequel les messages repartiront, et
   l'adresse où les déposer.
2. **Ajoutez une boîte POP3** — et choisissez la destination vers laquelle la rediriger.

Chaque enregistrement lance un vrai test de connexion et vous dit ce qui cloche, le cas
échéant. Ensuite, plus rien à faire : le minuteur s'occupe du reste.

### L'équivalent en une commande

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

### Gmail : il faut un mot de passe d'application

Le SMTP de Gmail **refuse le mot de passe de votre compte**. Il faut générer un *mot de
passe d'application* de 16 caractères, ce qui suppose d'avoir activé la validation en
deux étapes sur le compte.

👉 **https://myaccount.google.com/apppasswords**

L'interface affiche ce lien directement dans le formulaire de destination dès qu'elle
reconnaît un serveur Gmail, à côté du bouton *Pré-remplir pour Gmail*
(`smtp.gmail.com`, port 587, STARTTLS).

### Sans Docker

```bash
npm install
npm run build
DATA_DIR=./data node dist/main.js
```

## Ressembler à une vraie redirection

C'est tout l'intérêt de l'outil, et la partie qui mérite d'être comprise.

Un transfert naïf refabrique un message : Gmail l'affiche comme venant de votre relais,
avec le mail d'origine cité dedans — et répondre écrit à la mauvaise personne. Ici, le
message est **relayé, pas reconstruit** : les octets bruts sortent du serveur POP3 et
partent tels quels vers le SMTP. Deux règles le permettent :

1. **Le corps n'est jamais décodé.** Il reste un tampon d'octets de bout en bout : les
   pièces jointes, les encodages exotiques et le 8 bits arrivent octet pour octet.
2. **On ajoute des en-têtes au-dessus, on n'en modifie pas.** Une signature DKIM ne
   couvre que les en-têtes présents au moment où elle a été posée : tant qu'on se
   contente de préfixer des lignes, elle reste valide — et Gmail affiche
   *« signé par : domaine-d-origine.com »*.

À cela s'ajoutent les en-têtes de traçage qu'un vrai serveur de mail poserait
(`Delivered-To`, `Received`, `X-Forwarded-To`, `X-Forwarded-For`).

### Le dépôt IMAP : le message intact, même chez Gmail

Une destination peut être de deux types : **envoi SMTP** ou **dépôt IMAP**. Le second
ouvre une session IMAP sur la boîte d'arrivée et y **dépose** le message par un `APPEND`,
exactement comme le fait un logiciel de migration de courrier.

Rien n'est expédié, donc rien ne peut être réécrit : le `From:` reste celui de
l'expéditeur, la signature DKIM reste valide, et SPF comme DMARC n'ont pas leur mot à
dire — puisque aucun message ne transite. **C'est le seul moyen d'éviter que Gmail
affiche tous vos messages relevés comme envoyés par vous**, ce qu'il fait dès que le
`From:` porte l'adresse de votre compte.

Il suffit d'un serveur IMAP et du même mot de passe d'application que pour le SMTP :

| Champ | Valeur pour Gmail |
|---|---|
| Serveur IMAP | `imap.gmail.com`, TLS direct, port `993` |
| Identifiant | l'adresse complète du compte |
| Mot de passe | le mot de passe d'application (16 caractères) |
| Dossier | `INBOX` — ou n'importe quel libellé, créé au besoin |

Les messages arrivent **non lus** (l'option existe pour les déposer déjà lus, sans
notification), et **datés de leur date d'origine** plutôt que de l'heure de la relève :
une boîte relevée d'un coup se range donc dans le bon ordre.

Seule chose à savoir : un message déposé ne passe pas par les filtres de Gmail. Ni par
l'antispam, ni par vos règles de tri — il atterrit directement dans le dossier choisi.

### Deux modes d'en-têtes, et pourquoi

Ces modes ne concernent que l'**envoi SMTP** : un dépôt IMAP ne réécrit jamais rien, et
l'interface masque d'ailleurs ces réglages quand la destination en est un.

| Mode | Ce qu'il fait | Quand |
|---|---|---|
| **Redirection fidèle** | Le message repart intact : `From` d'origine, signature d'origine. | Tout SMTP qui accepte d'expédier au nom d'un tiers : votre FAI, un relais auto-hébergé, un service transactionnel. |
| **Compatible Gmail** | Le `From` devient `Nom d'origine (via ma-boite@fai.fr) <vous@gmail.com>`, et le `Reply-To` pointe sur le vrai expéditeur. | `smtp.gmail.com`. |

Le mode est sur **Automatique** par défaut : compatible Gmail pour `smtp.gmail.com`,
redirection fidèle partout ailleurs. Vous pouvez forcer l'un ou l'autre par destination.

**Pourquoi le second mode existe** : le serveur de soumission de Gmail réécrit le `From:`
dès qu'il ne correspond pas au compte authentifié (ou à un alias vérifié). Y garder
l'expéditeur d'origine est tout simplement impossible — alors plutôt que de subir une
réécriture qui laisse derrière elle une signature DKIM cassée, l'outil le fait proprement :
le nom de l'expéditeur reste visible, son adresse part dans `X-Original-From`, et
**le `Reply-To` fait que « Répondre » écrit à la bonne personne**. Objet, date,
`Message-ID` et en-têtes de fil restent intacts dans les deux cas, donc les conversations
se regroupent normalement.

> **Si vous voulez la version intacte avec une destination Gmail**, prenez une
> destination de type **dépôt IMAP** : c'est fait pour ça, et il n'y a rien d'autre à
> configurer. À défaut, n'envoyez pas *via* Gmail mais *vers* l'adresse Gmail en passant
> par un autre SMTP (celui de votre FAI, un relais que vous hébergez, un service
> transactionnel) en mode *Redirection fidèle* — en gardant en tête que le DMARC de
> l'expéditeur d'origine s'appliquera : `p=reject` (LinkedIn, les banques, la plupart des
> grands émetteurs) fera rejeter le message. Un domaine à vous avec SPF et DKIM rend la
> chose imparable, mais ce n'est pas nécessaire pour commencer.

### Expéditeur d'enveloppe

L'expéditeur d'enveloppe (`MAIL FROM`) est ce que regarde SPF, et l'adresse où repartent
les rapports de non-remise. Le mode automatique prend l'expéditeur d'origine en
redirection fidèle, et le compte SMTP en mode compatible Gmail — ce qu'exigent les
relais authentifiés. Les deux peuvent être forcés.

## Configuration

Les boîtes, les destinations et les préférences vivent dans `data/config.json` et se
modifient depuis l'interface. Le `.env` ne porte que ce qui relève du déploiement :

| Variable | Défaut | Rôle |
|---|---|---|
| `TZ` | `Europe/Paris` | Fuseau horaire des dates affichées et journalisées |
| `PUID` / `PGID` | `1000` | Propriétaire du dossier `data` |
| `WEB_PORT_HOST` | `8080` | Port côté hôte si 8080 est pris |
| `WEB_USER` / `WEB_PASSWORD` | vide | Authentification de l'interface **et** de l'API |
| `REFRESH_MINUTES` | `10` | Délai entre deux relèves. `0` désactive le minuteur |
| `RUN_ON_START` | `true` | Relever une fois au démarrage du conteneur |
| `MAX_PER_RUN` | `50` | Messages traités par boîte et par passage. `0` = pas de plafond |
| `MAX_SIZE_MB` | `25` | Au-delà, le message est ignoré. `0` = pas de limite |
| `HISTORY_MAX` | `200` | Actions gardées **par boîte** dans l'historique (10 minimum) |
| `POP3_TIMEOUT` / `SMTP_TIMEOUT` / `IMAP_TIMEOUT` | `60000` | Délais réseau, en millisecondes |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` ou `error` |

Les cinq du milieu sont des **valeurs par défaut** : elles se changent depuis l'interface,
et le changement s'applique immédiatement. Mais une variable **renseignée dans le `.env`
verrouille le réglage** : le champ apparaît grisé, avec le nom de la variable responsable.
Pratique pour figer une valeur dans un déploiement géré, gênant quand c'est involontaire —
d'où les lignes commentées dans `.env.example`.

## Alertes

Trois catégories, activables séparément : **échec** (active par défaut), **redirection
réussie**, et **chaque relève**.

Canaux : e-mail (en réutilisant le SMTP d'une de vos destinations), **ntfy**, un
**webhook générique** au gabarit libre (`{{title}}` / `{{text}}`, de quoi brancher
Gotify, Home Assistant, Discord ou Slack), et **SMS via l'API Free Mobile**.

Une alerte d'échec liste la boîte, la destination, l'erreur, et les premiers messages en
échec avec leur raison. Le bouton *Envoyer un test* enregistre d'abord le formulaire,
puis tire sur tous les canaux configurés et rend compte de chacun.

## Bon à savoir

- **La première relève d'une boîte existante redirige tout ce qu'elle contient.** Si la
  boîte porte dix ans d'archives et que vous n'en voulez pas, utilisez le bouton 📋 sur
  la carte de la boîte : il marque le contenu actuel comme déjà traité sans rien envoyer.
- **Un message n'est marqué traité qu'une fois accepté par le serveur SMTP**, et n'est
  supprimé de la source qu'ensuite. Une panne au milieu d'une relève coûte au pire un
  doublon, jamais un message perdu.
- **Le mode déplacement vide la boîte source.** Les suppressions ne sont validées qu'au
  `QUIT`, comme l'exige le protocole : une relève interrompue laisse tout en place. Cela
  dit, vérifiez que la destination fonctionne avant de l'activer.
- `MAX_PER_RUN` étale une grosse boîte sur plusieurs passages plutôt que de noyer le
  SMTP de destination d'un coup.
- POP3 n'a ni dossiers ni notion de « lu » : l'outil suit ce qu'il a déjà vu par `UIDL`,
  l'identifiant stable que le serveur attribue à chaque message.

## Architecture

```
src/
  main.ts                 serveur HTTP, fichiers statiques, bibliothèques
  env.ts                  .env → valeurs par défaut, et ce qu'il verrouille
  scheduler.service.ts    le minuteur (réarmé après chaque passage, jamais empilé)
  store/
    store.service.ts      data/config.json + data/state.json, écritures atomiques
  mail/
    pop3.ts               client POP3 (RFC 1939), écrit à la main, sans dépendance
    imap.ts               client IMAP (RFC 3501), réduit au dépôt : LOGIN, APPEND, STATUS
    rewrite.ts            traitement des en-têtes : le cœur de la fidélité
    headers.ts            manipulation RFC 5322 au niveau octet, décodage RFC 2047
    smtp.service.ts       nodemailer, envoi brut avec enveloppe explicite
    delivery.ts           le canal de remise : envoi SMTP ou dépôt IMAP, au choix
    forwarder.service.ts  orchestration : relever → réécrire → remettre → consigner
  notify/notify.service.ts  e-mail / ntfy / webhook / SMS
  api/api.controller.ts   l'API REST
  web/public/index.html   toute l'interface, en un fichier, sans étape de build
```

Le client POP3 est écrit à la main, volontairement. Le protocole tient en dix commandes
et n'a pas bougé depuis 1996, alors que les paquets npm qui l'implémentent, eux, cassent —
`node-pop3` 0.15 livre du code ESM dans un fichier `.cjs`, donc impossible à charger.
Deux cents lignes sous contrôle valent mieux qu'une dépendance à réparer.

Vue, Vuetify et les icônes sont servis depuis `node_modules`, jamais depuis un CDN :
l'interface fonctionne sur un réseau coupé d'Internet, et ne cassera pas le jour où un
CDN change ses URL.

## Tests

```bash
npm test
```

67 tests, sans accès réseau : un faux serveur POP3, un faux serveur IMAP et un vrai
serveur SMTP (`smtp-server`) sont démarrés à la volée. Ils couvrent la préservation octet
pour octet d'un message 8 bits, le dot-stuffing, les en-têtes repliés, le décodage
RFC 2047, les deux modes d'en-têtes, le dépôt IMAP (littéral, drapeaux, date interne,
création du dossier, noms en UTF-7 modifié), l'absence de doublon entre deux relèves, le
mode déplacement, un refus SMTP ou IMAP qui laisse le message en place, les messages trop
gros, les relèves simultanées, et la persistance après redémarrage.

Ils tournent à chaque push via GitHub Actions, sur Node 22 et 24.

## Image Docker Hub et publication automatique

**https://hub.docker.com/r/smeagolworms4/pop3_to_smtp**

Publiée pour `linux/amd64` et `linux/arm64` depuis un manifeste multi-architecture unique —
le même tag fonctionne sur un PC, un NAS et un Raspberry Pi.

| Tag | Construit sur |
|---|---|
| `latest` | chaque push sur `main`, et chaque tag git — celui à utiliser |
| `main` | chaque push sur la branche `main` |
| `<version>` (ex. `1.0.0`) | création d'un tag git de ce nom, pour figer une version |

### Secrets GitHub à créer à la main

Deux workflows sont fournis dans `.github/workflows/` : `build_images.yml` (construction
multi-architecture et publication) et `push_readme.yml` (synchronisation de la
description Docker Hub depuis ce README). Les deux réclament **deux secrets de dépôt**, à
ajouter dans *Settings → Secrets and variables → Actions* :

| Secret | Contenu |
|---|---|
| `DOCKER_USERNAME` | votre identifiant Docker Hub (il sert aussi à construire le nom de l'image) |
| `DOCKER_PASSWORD` | un *access token* Docker Hub |

Sans ces deux secrets, les workflows échouent à l'étape de connexion à Docker Hub.

## En cas de problème

**« Invalid login: 535-5.7.8 Username and Password not accepted »** — Gmail refuse le
mot de passe de votre compte. Générez un [mot de passe
d'application](https://myaccount.google.com/apppasswords).

**Les messages arrivent de ma propre adresse au lieu de celle de l'expéditeur** — c'est
le mode compatible Gmail, et c'est attendu quand on passe par `smtp.gmail.com`.
L'expéditeur d'origine est en *Répondre à*, donc répondre fonctionne. Pour la version
intacte, passez par un autre SMTP : voir *[Ressembler à une vraie
redirection](#ressembler-à-une-vraie-redirection)*.

**Gmail masque certains messages** — Gmail déduplique par `Message-ID`, qu'on préserve
volontairement. Si un message était déjà dans le compte, la copie est masquée. Activez
*Regénérer le Message-ID* sur la destination si cela vous gêne, au prix du regroupement
en fil de discussion.

**Les mêmes messages sont redirigés en boucle** — certains serveurs POP3 donnent un
`UIDL` différent à chaque session. Passez la boîte en mode déplacement : ce qui est
envoyé est supprimé, donc rien ne peut revenir.

**La relève n'en finit pas** — augmentez `POP3_TIMEOUT` et `SMTP_TIMEOUT`, ou baissez
`MAX_PER_RUN`. L'historique indique la durée de chaque passage.

## Sécurité

Les mots de passe POP3 et SMTP sont stockés **en clair** dans `data/config.json` — les
protocoles les exigent en clair, il n'y a donc rien à gagner à les chiffrer à côté de la
clé. Traitez ce dossier comme un secret, et renseignez `WEB_USER` / `WEB_PASSWORD` dès
que l'interface sort de votre réseau local : l'API expose la même configuration.

Les mots de passe ne repartent jamais vers le navigateur : l'interface reçoit un masque,
et renvoyer ce masque signifie « garde celui d'avant ».
