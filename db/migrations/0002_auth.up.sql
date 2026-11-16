-- Epic E2 (COPI-10): Better-Auth-Grundschema + Erststart-Token.
--
-- Der Better-Auth-Teil (user/session/account/verification/twoFactor) ist
-- unverändert die Ausgabe von
--   npx auth@latest generate --config src/auth/auth.ts
-- mit `database.schemaName = "cockpit"` — dadurch sind alle Tabellen
-- schema-qualifiziert und landen nicht in `public`. Bitte beim Anheben der
-- better-auth-Version erneut generieren statt von Hand nachziehen.
--
-- Einzige Abweichung von der Generator-Ausgabe: deren `CREATE SCHEMA IF NOT
-- EXISTS "cockpit";` fehlt hier. Das Schema stellt 0001 her, und die Zeile
-- verlangt das Recht CREATE auf die Datenbank, das die Rolle cockpit bewusst
-- nicht hat (COPI-66). Beim Neugenerieren wieder entfernen.

CREATE TABLE "cockpit"."user" (
    "id" text NOT NULL PRIMARY KEY,
    "name" text NOT NULL,
    "email" text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL,
    "image" text,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "twoFactorEnabled" boolean
);

CREATE TABLE "cockpit"."session" (
    "id" text NOT NULL PRIMARY KEY,
    "expiresAt" timestamptz NOT NULL,
    "token" text NOT NULL UNIQUE,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamptz NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL REFERENCES "cockpit"."user" ("id") ON DELETE CASCADE
);

CREATE TABLE "cockpit"."account" (
    "id" text NOT NULL PRIMARY KEY,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES "cockpit"."user" ("id") ON DELETE CASCADE,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamptz,
    "refreshTokenExpiresAt" timestamptz,
    "scope" text,
    "password" text,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamptz NOT NULL
);

CREATE TABLE "cockpit"."verification" (
    "id" text NOT NULL PRIMARY KEY,
    "identifier" text NOT NULL,
    "value" text NOT NULL,
    "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE "cockpit"."twoFactor" (
    "id" text NOT NULL PRIMARY KEY,
    "secret" text NOT NULL,
    "backupCodes" text NOT NULL,
    "userId" text NOT NULL REFERENCES "cockpit"."user" ("id") ON DELETE CASCADE,
    "verified" boolean,
    "failedVerificationCount" integer,
    "lockedUntil" timestamptz
);

CREATE INDEX "session_userId_idx" ON "cockpit"."session" ("userId");
CREATE INDEX "account_userId_idx" ON "cockpit"."account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "cockpit"."verification" ("identifier");
CREATE INDEX "twoFactor_secret_idx" ON "cockpit"."twoFactor" ("secret");
CREATE INDEX "twoFactor_userId_idx" ON "cockpit"."twoFactor" ("userId");

-- Erststart-Token (Architektur-Vorschlag Abschnitt 13.2). Gespeichert wird
-- ausschließlich der SHA-256-Hash, nie das Token selbst.
CREATE TABLE "cockpit"."erststart_token" (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash    text        NOT NULL,
    erstellt_am   timestamptz NOT NULL DEFAULT now(),
    ablauf_am     timestamptz NOT NULL,
    verbraucht_am timestamptz
);

-- Es darf immer höchstens ein offenes Token geben: jeder Start entwertet
-- vorherige offene Token und legt genau eines neu an.
CREATE UNIQUE INDEX erststart_token_ein_offenes_idx
    ON "cockpit"."erststart_token" ((true))
    WHERE verbraucht_am IS NULL;
