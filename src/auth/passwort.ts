/**
 * Passwort-Hashing für das Cockpit — Argon2id.
 *
 * Wichtig für das Review (Architektur-Vorschlag Abschnitt 13.2 verlangt
 * Argon2id): Better Auth hasht standardmäßig mit **scrypt**, nicht mit
 * Argon2id. Die Bibliothek bietet dafür aber den vorgesehenen Einhängepunkt
 * `emailAndPassword.password.hash`/`.verify`. Wir hängen dort die
 * Argon2id-Referenzimplementierung (`@node-rs/argon2`, Rust/`argon2`-Crate)
 * ein — es wird also weiterhin nichts selbst gehasht oder selbst verglichen,
 * nur ein anderes, von der ADR gefordertes Verfahren eingesetzt.
 *
 * Parameter nach OWASP-Empfehlung für Argon2id (Stand 2026):
 * m = 19 MiB, t = 2, p = 1.
 */
import { hash, verify, type Options } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id` aus `@node-rs/argon2` ist ein ambienter `const enum`
 * und lässt sich mit `verbatimModuleSyntax` nicht importieren — daher der
 * Zahlenwert mit Namen. (0 = Argon2d, 1 = Argon2i, 2 = Argon2id.)
 */
const ARGON2ID = 2;

const ARGON2_OPTIONEN: Options = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export async function passwortHashen(passwort: string): Promise<string> {
  return hash(passwort, ARGON2_OPTIONEN);
}

/**
 * Prüft ein Passwort gegen einen gespeicherten Argon2id-Hash. Der Vergleich
 * selbst steckt in der Bibliothek (konstante Laufzeit über den Hash-Vergleich);
 * ein defekter oder fremdformatiger Hash führt zu `false`, nie zu einem Fehler,
 * damit ein Angreifer daraus nichts ableiten kann.
 */
export async function passwortPruefen(daten: {
  hash: string;
  password: string;
}): Promise<boolean> {
  try {
    return await verify(daten.hash, daten.password, ARGON2_OPTIONEN);
  } catch {
    return false;
  }
}
