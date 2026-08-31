#!/usr/bin/env bash
# server/scripts/setup-local-mongo.sh
#
# Installs and configures MongoDB on the factory server so EKC can run on its
# own disk instead of a 512 MB cloud tier. Run it on the factory box:
#
#     sudo -v && bash server/scripts/setup-local-mongo.sh
#
# It is SAFE TO RUN TWICE: every step checks whether it is already done. It
# never touches the EKC database, never edits .env, and never talks to Atlas —
# copying the data down and pointing the app at localhost stay manual, because
# those are the two steps where you want to be watching.
#
# The one thing this exists to get right: MongoDB must run as a REPLICA SET,
# even with a single node. The server pushes live updates through change
# streams, which do not exist on a standalone mongod — the app degrades to
# polling and the board stops moving, with only a line in the log to say so.
set -euo pipefail

MONGO_MAJOR="8.0"
DB_NAME="${DB_NAME:-test}"
APP_USER="ekc_app"
ADMIN_USER="ekc_admin"
REPL_SET="rs0"
CONF="/etc/mongod.conf"
SECRETS="${SECRETS:-$HOME/ekc-mongo-credentials.env}"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[0;32mok\033[0m   %s\n' "$*"; }
warn() { printf '   \033[0;33mnote\033[0m %s\n' "$*"; }
die()  { printf '\n\033[0;31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] && die "run this as your normal user (it calls sudo itself), not as root"
command -v sudo >/dev/null || die "sudo is required"

# ── 1 · install ──────────────────────────────────────────────────────────────
say "MongoDB $MONGO_MAJOR"
if command -v mongod >/dev/null; then
  ok "already installed: $(mongod --version | head -1)"
else
  CODENAME="$(lsb_release -cs)"
  case "$CODENAME" in
    noble|jammy|focal) ;;
    *) die "unsupported Ubuntu codename '$CODENAME' — check MongoDB's install docs for it" ;;
  esac
  sudo apt-get install -y gnupg curl >/dev/null
  curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_MAJOR}.asc" \
    | sudo gpg -o "/usr/share/keyrings/mongodb-server-${MONGO_MAJOR}.gpg" --dearmor --yes
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-${MONGO_MAJOR}.gpg ] https://repo.mongodb.org/apt/ubuntu ${CODENAME}/mongodb-org/${MONGO_MAJOR} multiverse" \
    | sudo tee "/etc/apt/sources.list.d/mongodb-org-${MONGO_MAJOR}.list" >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y mongodb-org >/dev/null
  ok "installed $(mongod --version | head -1)"
fi
command -v mongosh >/dev/null || die "mongosh missing — install mongodb-mongosh and re-run"

# ── 2 · replica set + loopback binding ───────────────────────────────────────
say "Configuring $CONF"
if grep -q "replSetName: *$REPL_SET" "$CONF"; then
  ok "replica set already configured"
else
  sudo cp "$CONF" "${CONF}.bak.$(date +%s)"
  # Append rather than rewrite: an existing storage/log path stays exactly as it is.
  sudo tee -a "$CONF" >/dev/null <<EOF

# Added by EKC setup-local-mongo.sh — change streams need a replica set,
# even one with a single member. The app watches machines + telemetries.
replication:
  replSetName: $REPL_SET
EOF
  ok "replSetName: $REPL_SET added (previous config backed up)"
fi
grep -qE '^\s*bindIp:\s*127\.0\.0\.1' "$CONF" \
  && ok "bound to 127.0.0.1 only" \
  || warn "bindIp is not 127.0.0.1 — the database is reachable off this machine; use an SSH tunnel instead"

sudo systemctl enable mongod >/dev/null 2>&1 || true
sudo systemctl restart mongod
for _ in $(seq 1 30); do mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1 && break; sleep 1; done

# ── 3 · initiate the set ─────────────────────────────────────────────────────
say "Replica set"
STATE="$(mongosh --quiet --eval 'try { rs.status().myState } catch (e) { 0 }' 2>/dev/null || echo 0)"
if [[ "$STATE" == "1" ]]; then
  ok "already primary"
else
  mongosh --quiet --eval "rs.initiate({_id:'$REPL_SET', members:[{_id:0, host:'127.0.0.1:27017'}]})" >/dev/null
  for _ in $(seq 1 30); do
    [[ "$(mongosh --quiet --eval 'try { rs.status().myState } catch (e) { 0 }')" == "1" ]] && break
    sleep 1
  done
  [[ "$(mongosh --quiet --eval 'rs.status().myState')" == "1" ]] || die "replica set did not reach PRIMARY"
  ok "initiated, now PRIMARY"
fi

# ── 4 · users (only while auth is still off) ─────────────────────────────────
say "Database users"
AUTH_ON=$(grep -qE '^\s*authorization:\s*enabled' "$CONF" && echo yes || echo no)
if [[ "$AUTH_ON" == "yes" ]]; then
  ok "authentication already enabled — leaving existing users alone"
else
  # Generated, never typed: a password you invent under time pressure is the one
  # that ends up in a chat message.
  ADMIN_PW="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  APP_PW="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  mongosh --quiet <<JS
const admin = db.getSiblingDB("admin");
if (!admin.getUser("$ADMIN_USER")) admin.createUser({ user: "$ADMIN_USER", pwd: "$ADMIN_PW", roles: [{ role: "root", db: "admin" }] });
if (!admin.getUser("$APP_USER"))   admin.createUser({ user: "$APP_USER",   pwd: "$APP_PW",   roles: [{ role: "readWrite", db: "$DB_NAME" }] });
JS
  APP_URI="mongodb://$APP_USER:$APP_PW@127.0.0.1:27017/$DB_NAME?authSource=admin&replicaSet=$REPL_SET"
  ADMIN_URI="mongodb://$ADMIN_USER:$ADMIN_PW@127.0.0.1:27017/?authSource=admin&replicaSet=$REPL_SET"
  umask 077
  cat > "$SECRETS" <<EOF
# EKC local MongoDB — generated $(date -Iseconds). Keep this file; it is the
# only copy of these passwords. Never commit it.
MONGO_URI=$APP_URI
MONGO_ADMIN_URI=$ADMIN_URI
EOF
  chmod 600 "$SECRETS"
  ok "created $ADMIN_USER and $APP_USER"
  ok "credentials written to $SECRETS (chmod 600, not printed here)"

  sudo tee -a "$CONF" >/dev/null <<'EOF'

security:
  authorization: enabled
EOF
  sudo systemctl restart mongod
  for _ in $(seq 1 30); do mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1 && break; sleep 1; done
  ok "authentication enabled"
fi

# ── 5 · prove it actually works ──────────────────────────────────────────────
say "Verifying"
[[ -f "$SECRETS" ]] || die "no credentials file at $SECRETS — re-run on a fresh install, or use your own URI"
# shellcheck disable=SC1090
ADMIN_URI="$(grep '^MONGO_ADMIN_URI=' "$SECRETS" | cut -d= -f2-)"
APP_URI="$(grep '^MONGO_URI=' "$SECRETS" | cut -d= -f2-)"

mongosh "$ADMIN_URI" --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null || die "admin cannot authenticate"
ok "admin authenticates"
mongosh "$APP_URI" --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null || die "app user cannot authenticate"
ok "app user authenticates against $DB_NAME"

# The whole reason for the replica set: ask the server to open a change stream.
CS=$(mongosh "$APP_URI" --quiet --eval \
  'try { db.runCommand({ aggregate: "smoke", pipeline: [{ $changeStream: {} }], cursor: {} }).ok } catch (e) { 0 }')
[[ "$CS" == "1" ]] || die "change streams are NOT available — the app would fall back to polling. Check replication in $CONF."
ok "change streams available (live dashboard updates will work)"

DISK=$(df -h /var/lib/mongodb --output=avail 2>/dev/null | tail -1 | tr -d ' ' || echo '?')
ok "free space on the data disk: $DISK"

say "Done — the database is ready. Two steps left, both by hand:"
cat <<EOF

  1 · Copy the data down from Atlas (reads still work even when it is full).
      Take the Atlas string from your current server/.env — do not retype it.

      export ATLAS_URI=\$(grep '^MONGO_URI=' ~/ekc/server/.env | cut -d= -f2-)
      mongodump --uri="\$ATLAS_URI" --db=$DB_NAME --out=/tmp/ekc-dump
      mongorestore --uri="\$(grep '^MONGO_URI=' $SECRETS | cut -d= -f2-)" \\
        --db=$DB_NAME /tmp/ekc-dump/$DB_NAME
      unset ATLAS_URI

  2 · Point the app at it, keeping the old line as your rollback:

      cd ~/ekc/server
      sed -i 's|^MONGO_URI=|# MONGO_URI=|' .env
      grep '^MONGO_URI=' $SECRETS >> .env
      pm2 restart ekc && pm2 logs ekc --lines 30

      Look for these two lines:
        [db] MongoDB connected -> db "$DB_NAME"
        [watch] change streams active on machines + telemetries

EOF
