/**
 * Herkunftsprüfung für die Formulare der Anmeldung (COPI-13) und, strenger, für den Update-Antrag (COPI-40).
 *
 * Warum überhaupt, obwohl alle Sitzungs-Cookies `SameSite=Lax` tragen: Lax
 * schützt jede fremde POST-Anfrage, die einen **vorhandenen** Cookie braucht —
 * der Cookie wird dabei nicht mitgeschickt. Die Anmeldung braucht aber keinen
 * Cookie. Eine fremde Seite könnte also ein Formular mit Zugangsdaten des
 * Angreifers an `/anmelden` schicken und die angemeldete Person unbemerkt in
 * ein fremdes Konto setzen („Login-CSRF"). Dagegen hilft nur, die Herkunft zu
 * prüfen.
 *
 * Verglichen wird der **Host**, nicht das Schema: hinter Caddy ist es immer
 * `https`, in der lokalen Entwicklung `http`, und Caddy gibt den ursprünglichen
 * `Host` unverändert weiter.
 *
 * Fehlt jede Herkunftsangabe, wird die Anfrage zugelassen: Browser setzen bei
 * fremden POST-Anfragen immer `Origin`, ohne Angabe kommt die Anfrage also
 * nicht aus einem fremden Formular (sondern z. B. von `curl` oder aus einem
 * Test). Genau deshalb ist die Prüfung wirksam, ohne Werkzeuge auszusperren.
 */

export function herkunftErlaubt(
  origin: string | undefined,
  referer: string | undefined,
  host: string | undefined,
): boolean {
  const gemeldet = origin ?? referer;
  if (gemeldet === undefined || gemeldet.length === 0) {
    return true;
  }
  return herkunftBelegt(origin, referer, host);
}

/**
 * Die strenge Form für Formulare, die mit einer Sitzung etwas verändern (Update-Antrag, COPI-40): eine
 * Herkunftsangabe **muss** da sein und zur eigenen Adresse passen. Browser schicken bei einem POST-Formular
 * immer `Origin`; ohne Angabe kommt die Anfrage also nicht aus dem eigenen Formular.
 *
 * Warum das neben `SameSite=Lax` nötig ist: „same site" ist die registrierbare Domain. Unter
 * `<kuerzel>.example.com` ist jede andere Subdomain derselben Domain „same site" — ihr Formular bekäme das
 * Sitzungs-Cookie mit. Die Herkunft nennt dagegen den vollständigen Host.
 */
export function herkunftBelegt(
  origin: string | undefined,
  referer: string | undefined,
  host: string | undefined,
): boolean {
  const gemeldet = origin ?? referer;
  if (gemeldet === undefined || gemeldet.length === 0 || host === undefined || host.length === 0) {
    return false;
  }
  try {
    // `Origin: null` (etwa aus einem abgeschotteten Rahmen) ist keine gültige
    // URL und fällt damit durch — richtig, denn es ist keine eigene Herkunft.
    return new URL(gemeldet).host === host;
  } catch {
    return false;
  }
}
