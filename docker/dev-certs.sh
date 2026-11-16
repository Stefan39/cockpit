#!/bin/sh
# Erzeugt ein selbstsigniertes Zertifikat für den lokalen Mailpit (STARTTLS).
#
# Der Mailversand des Cockpits erzwingt STARTTLS (src/mail/versand.ts) — das
# gilt auch lokal. Mailpit bietet STARTTLS nur mit Zertifikat an. Der
# Cockpit-Server vertraut genau diesem Zertifikat über NODE_EXTRA_CA_CERTS,
# die Zertifikatsprüfung bleibt also eingeschaltet.
#
# Nur für die lokale Entwicklung. Der Schlüssel liegt unter docker/dev-certs/
# (gitignored) und darf nie irgendwo anders verwendet werden.
set -eu

dir="$(cd "$(dirname "$0")" && pwd)/dev-certs"

if [ -f "$dir/cert.pem" ] && [ -f "$dir/key.pem" ]; then
  exit 0
fi

mkdir -p "$dir"
konfig="$(mktemp)"
trap 'rm -f "$konfig"' EXIT

cat > "$konfig" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = localhost

[v3]
subjectAltName = DNS:localhost,IP:127.0.0.1
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" -config "$konfig" 2>/dev/null

# Der Mailpit-Container liest den Schlüssel über eine Bind-Mount als anderer
# Benutzer; für einen Wegwerf-Schlüssel ohne Aussagekraft ist 644 in Ordnung.
chmod 644 "$dir/key.pem" "$dir/cert.pem"

echo "Dev-Zertifikat erzeugt: $dir/cert.pem"
