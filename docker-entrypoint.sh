#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/data}"

# Le conteneur tourne sous l'UID de l'hôte (`user:` dans le compose) : le
# dossier peut déjà exister et ne pas nous appartenir, auquel cas il est
# normal de ne pas pouvoir le recréer.
mkdir -p "$DATA_DIR" 2>/dev/null || true

if [ ! -w "$DATA_DIR" ]; then
  echo "ERREUR : $DATA_DIR n'est pas accessible en écriture." >&2
  echo "Vérifiez PUID/PGID dans .env, ou les droits du dossier ./data sur l'hôte." >&2
  exit 1
fi

exec "$@"
