# --- Compilation -------------------------------------------------------------
# `--platform=$BUILDPLATFORM` épingle cette étape sur l'architecture de la
# machine qui construit, jamais sur celle qui est visée. C'est indispensable
# pour la construction multi-architecture : sous QEMU, le V8 de Node 22/musl
# exécute des instructions que l'émulateur ne sait pas traduire, et `npm ci`
# meurt en « illegal instruction ».
#
# La copie du résultat vers l'image arm64 n'est légitime que parce que toutes
# les dépendances de production sont du JavaScript pur — aucun binaire natif,
# aucun paquet marqué `os`/`cpu`. Le test `npm test` le vérifie.
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# On ne garde que les dépendances de production : c'est ce dossier qui part
# tel quel dans l'image finale.
RUN npm prune --omit=dev && npm cache clean --force

# --- Image finale ------------------------------------------------------------
FROM node:22-alpine

# tini : sans lui, le processus Node est PID 1 et n'a pas de gestionnaire de
# signaux par défaut — un `docker stop` finirait en SIGKILL au bout de 10 s,
# au milieu d'une relève.
RUN apk add --no-cache tini

WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# L'interface est un fichier statique : elle n'a rien à faire dans la compilation.
COPY src/web/public ./web/public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_PORT=8080

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
