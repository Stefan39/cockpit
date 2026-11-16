/**
 * Die Antworten der Agenten-API (COPI-35, COPI-36): JSON der Form `{"fehler": "…"}`, knapp und ohne
 * die Eingabe zu wiederholen. Jede trägt `Cache-Control: no-store`: kein Zwischenspeicher darf eine
 * Ablehnung oder ein Ergebnis für jemand anderen aufbewahren.
 */
import type { FastifyReply } from 'fastify';

export function antworten(
  reply: FastifyReply,
  status: number,
  fehler: string,
  kopf: Record<string, string> = {},
  zusatz: Record<string, unknown> = {},
): FastifyReply {
  return reply.code(status).headers({ 'cache-control': 'no-store', ...kopf }).send({ fehler, ...zusatz });
}
