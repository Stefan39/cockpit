/**
 * Was das Cockpit beim Start über sich meldet (COPI-39, ADR 13.1): Version und Digest des laufenden Images.
 *
 * **Klarstellung zur ADR.** Sie verlangt einen „ins Image gebackenen Digest". Das geht nicht: der Digest ist ein
 * Hash über den Inhalt des Images, ein Image kann ihn also nicht enthalten. Festgelegt ist deshalb
 * (`docs/adr/0001-digest-aus-der-umgebung.md`):
 *
 *   * **Version** (SemVer und Commit) wird beim Bauen gebacken: Build-Argumente `COCKPIT_VERSION` und
 *     `COCKPIT_COMMIT` (`docker/Dockerfile`, `.github/workflows/release.yaml`). Gespeichert als
 *     `1.4.0+0123456` — der Commit ist ein SemVer-Build-Metadatum.
 *   * **Digest** kommt aus der Umgebung: `COCKPIT_IMAGE_DIGEST` in `docker/compose.fragment.yaml`, mit demselben
 *     Platzhalter wie die `image:`-Zeile. Beide stimmen damit immer überein.
 *
 * **Nie wird ein Wert erfunden.** Ein fehlender oder kaputter Digest ist `undefined` (NULL in `cockpit.instanz`),
 * denn ein Update gilt erst als erledigt, wenn sich ein Cockpit mit dem Ziel-Digest meldet (COPI-41) — ein
 * erfundener könnte das vortäuschen. Eine kaputte Beschriftung hält den Start dagegen nicht auf: statt ihrer gilt
 * die Version aus `package.json`, und ein Hinweis steht im Log. Hinweise nennen nie den Wert selbst.
 */
import { readFileSync } from 'node:fs';

/** Ein vollständiger Digest, wie ihn die Datenbank verlangt (`instanz_digest_form`, Migration 0015). */
export const DIGEST_FORM = /^sha256:[0-9a-f]{64}$/;

/** SemVer 2.0 ohne Build-Metadaten (die hängt das Cockpit selbst an: den Commit). */
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Ein Git-Commit, gekürzt oder vollständig. */
const COMMIT = /^[0-9a-f]{7,40}$/;

export interface InstanzQuelle {
  readonly nodeEnv: 'development' | 'production' | 'test';
  /** `COCKPIT_VERSION`, beim Bauen gesetzt. */
  readonly version: string | undefined;
  /** `COCKPIT_COMMIT`, beim Bauen gesetzt. */
  readonly commit: string | undefined;
  /** `COCKPIT_IMAGE_DIGEST`, aus der Compose-Datei der Instanz. */
  readonly digest: string | undefined;
}

export interface InstanzAngaben {
  readonly version: string;
  readonly digest: string | undefined;
  /** Für das Log: was nicht stimmte, ohne den Wert zu nennen. */
  readonly hinweise: readonly string[];
}

/** Ein leeres Build-Argument (`ARG` ohne Wert) ist wie keins. */
function gesetzt(wert: string | undefined): wert is string {
  return wert !== undefined && wert !== '';
}

export function instanzAngaben(quelle: InstanzQuelle, paketVersion: string): InstanzAngaben {
  const hinweise: string[] = [];

  let version = paketVersion;
  if (gesetzt(quelle.version)) {
    if (SEMVER.test(quelle.version)) {
      version = quelle.version;
    } else {
      hinweise.push('COCKPIT_VERSION ist keine SemVer-Version; es gilt die Version aus package.json.');
    }
  }

  let bau = 'lokal';
  if (gesetzt(quelle.commit)) {
    if (COMMIT.test(quelle.commit)) {
      bau = quelle.commit.slice(0, 7);
    } else {
      hinweise.push('COCKPIT_COMMIT ist kein Commit-Hash; die Version trägt „lokal".');
    }
  }

  let digest: string | undefined;
  if (gesetzt(quelle.digest)) {
    if (DIGEST_FORM.test(quelle.digest)) {
      digest = quelle.digest;
    } else {
      hinweise.push('COCKPIT_IMAGE_DIGEST ist kein vollständiger sha256-Digest und bleibt leer.');
    }
  } else if (quelle.nodeEnv === 'production') {
    // Lokal gibt es keinen Digest; in einer Kundeninstanz fehlt dann die Zeile aus dem Compose-Fragment.
    hinweise.push('COCKPIT_IMAGE_DIGEST fehlt; ohne ihn lässt sich ein Update später nicht bestätigen (docker/compose.fragment.yaml).');
  }

  return { version: `${version}+${bau}`, digest, hinweise };
}

/**
 * Die Version für die Anzeige „Cockpit v0.6.0" (COPI-84): nur die SemVer-Version, ohne `+commit`. Dieselbe Prüfung
 * wie beim Start (`SEMVER`); fehlt `COCKPIT_VERSION` oder ist sie kaputt (lokal, Tests), gibt es keine Anzeige —
 * anders als beim Melden fällt sie nicht auf `package.json` zurück, denn eine geratene Version wäre eine falsche Angabe.
 */
export function anzeigeVersion(roh: string | undefined): string | undefined {
  if (!gesetzt(roh)) {
    return undefined;
  }
  const semver = roh.split('+')[0] ?? '';
  return SEMVER.test(semver) ? semver : undefined;
}

/**
 * Die Version aus `package.json`. Im Image liegt sie neben `dist/` (`/app/package.json`), im Quellbaum neben
 * `src/` — von `…/status/instanz.{ts,js}` aus in beiden Fällen zwei Ebenen höher.
 */
export function paketVersionLesen(): string {
  const paket = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof paket.version !== 'string' || paket.version === '') {
    throw new Error('package.json nennt keine Version');
  }
  return paket.version;
}
