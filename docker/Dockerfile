# syntax=docker/dockerfile:1
# Multi-Stage-Build → GHCR, SemVer+Digest gepinnt (Architektur-Vorschlag
# Abschnitt 2/8). Kundeninstanzen ziehen ausschließlich dieses Image, nie
# Quellcode.

FROM node:26-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# `prepare` (COPI-250) läuft bei jedem `npm ci`; ohne `src/` tut das Skript nichts, es muss nur vorhanden sein.
COPY scripts/kern-vorbereiten.mjs ./scripts/kern-vorbereiten.mjs
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build
# Stylesheet und Schriften (COPI-30): Tailwind läuft nur hier, nie im laufenden Image. Das Ergebnis
# liegt unter assets/gebaut und kommt mit dem `COPY … /app/assets` unten ins Runtime-Image.
RUN npm run assets

FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY scripts/kern-vorbereiten.mjs ./scripts/kern-vorbereiten.mjs
RUN npm ci --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S cockpit && adduser -S cockpit -G cockpit
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/views ./views
COPY --from=build /app/assets ./assets
# Die Migrationen (COPI-31): der Runner steckt in dist/datenbank, die SQL-Dateien liegen hier. Ohne sie
# gäbe es auf einer neuen Instanz keinen Weg zum Schema (`migrieren`, siehe Handbuch).
COPY --from=build /app/db/migrations ./db/migrations
COPY --from=build /app/config ./config
COPY package.json ./
# Version und Commit (COPI-39): beim Bauen gebacken, beim Start nach cockpit.instanz gemeldet. Der Release-Workflow
# übergibt sie (SemVer aus dem Tag, Commit); ohne Angabe meldet sich das Image mit der Version aus package.json
# und „lokal". Den Digest kennt das Image nicht — er ist ein Hash über dieses Image und kommt aus der
# Compose-Datei der Instanz (COCKPIT_IMAGE_DIGEST). Spät im Stage, damit ein neuer Commit die Schichten darüber
# nicht neu baut.
ARG COCKPIT_VERSION=""
ARG COCKPIT_COMMIT=""
ENV COCKPIT_VERSION=$COCKPIT_VERSION
ENV COCKPIT_COMMIT=$COCKPIT_COMMIT
USER cockpit
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/gesund').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
