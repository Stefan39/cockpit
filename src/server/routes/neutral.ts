/**
 * Die neutrale „nicht gefunden"-Antwort für alles, was eine Route nicht verraten soll
 * (Einladung, Wiederherstellung): sie verrät weder, ob es die Route gibt, noch, ob es ein
 * Token gab. Dieselbe Antwort für „nicht angemeldet", „falsche Rolle", „Token unbekannt",
 * „Token abgelaufen" und „Token verbraucht" — wortgleich mit der des Tors.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { htmlSenden } from '../../auth/antwort.js';

export async function nichtGefunden(app: FastifyInstance, reply: FastifyReply): Promise<void> {
  const html = await app.render('nicht-gefunden.eta', { titel: 'Nicht gefunden' });
  await htmlSenden(reply, html, 404);
}
