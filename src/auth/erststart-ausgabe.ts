/**
 * Ausgabe des Erststart-Tokens auf stdout (Architektur-Vorschlag 13.2).
 *
 * Bewusst `console.log` statt des Fastify-Loggers: der Token gehört in die
 * Container-Konsole, die der Betreiber beim Start liest — nicht in einen
 * strukturierten Log, der später eingesammelt oder weitergereicht wird.
 * Ausgegeben wird ein Token, nie ein fertiges Passwort, und ausschließlich
 * hier — in der Oberfläche taucht es nirgends auf.
 */
import type { ErststartToken } from './erststart-token.js';

const RAHMEN = '='.repeat(72);

export function erststartBlockBauen(token: ErststartToken, basisUrl: string): string {
  return [
    '',
    RAHMEN,
    '  COCKPIT — ERSTSTART',
    '',
    '  Es existiert noch kein Benutzer. Zugang einmalig einrichten unter:',
    '',
    `    ${basisUrl}/erststart/${token.token}`,
    '',
    `  Gültig bis: ${token.ablaufAm.toISOString()} (24 Stunden)`,
    '  Verfällt außerdem bei erster Nutzung und sobald ein Benutzer existiert.',
    '  Bei jedem Neustart ohne Benutzer wird ein neues Token erzeugt; das',
    '  vorherige verliert dabei seine Gültigkeit.',
    RAHMEN,
    '',
  ].join('\n');
}

export function erststartBlockAusgeben(text: string): void {
  // eslint-disable-next-line no-console
  console.log(text);
}
