#!/usr/bin/env bash
# Official PGDG packages, with signed repository verification (no curl-to-shell).
set -euo pipefail
source /etc/os-release
test "$ID" = ubuntu
test "$VERSION_CODENAME" = noble
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl --fail --silent --show-error --location \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  --output /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
printf '%s\n' \
  'Types: deb' \
  'URIs: https://apt.postgresql.org/pub/repos/apt' \
  'Suites: noble-pgdg' \
  "Architectures: $(dpkg --print-architecture)" \
  'Components: main' \
  'Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc' \
  | sudo tee /etc/apt/sources.list.d/honghao-ci-pgdg.sources > /dev/null
sudo apt-get update
sudo apt-get install --yes --no-install-recommends postgresql-client-18
for program in pg_dump pg_restore psql; do
  /usr/lib/postgresql/18/bin/"$program" --version
done
echo 'HONGHAO_PG_BIN=/usr/lib/postgresql/18/bin' >> "$GITHUB_ENV"
