/**
 * Kleine Helfer für den Übergang zwischen Better Auth (Web-`Headers`) und
 * Fastify. Bewusst an einer Stelle, damit die Cookie-Weitergabe nicht in
 * jeder Route erneut ausgeschrieben wird.
 */
import type { FastifyReply } from 'fastify';

/**
 * Übernimmt die `Set-Cookie`-Kopfzeilen einer Better-Auth-Antwort in die
 * Fastify-Antwort. Ohne das käme die neue Sitzung nie beim Browser an.
 */
export function cookiesUebernehmen(reply: FastifyReply, headers: Headers): void {
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) {
    reply.header('set-cookie', cookies);
  }
}

/**
 * Die Cookies einer Better-Auth-Antwort als `Cookie`-Kopf einer Folgeanfrage — für
 * den Fall, dass die Anwendung die eben entstandene Sitzung selbst wieder beenden will.
 */
export function cookieKopfAus(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((eintrag) => eintrag.split(';')[0])
    .join('; ');
}

export async function htmlSenden(
  reply: FastifyReply,
  html: string,
  status = 200,
): Promise<void> {
  await reply.code(status).type('text/html; charset=utf-8').send(html);
}
