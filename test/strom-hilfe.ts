/**
 * Ein Server-Sent-Events-Stream über eine echte HTTP-Verbindung, für Tests gegen einen lauschenden Server (COPI-56,
 * COPI-61). `app.inject` genügt dafür nicht — ein Stream endet nie.
 */
import { request as httpAnfrage, type IncomingMessage } from 'node:http';

export interface Strom {
  readonly status: number;
  readonly kopf: IncomingMessage['headers'];
  /** Alles, was bisher ankam. */
  text(): string;
  /** Wartet, bis der Text die Bedingung erfüllt (höchstens 3 s). */
  warten(bedingung: (text: string) => boolean): Promise<string>;
  schliessen(): void;
}

/** Die IDs der Nachrichten-Ereignisse in der Reihenfolge ihres Eintreffens. */
export function ids(text: string): number[] {
  return [...text.matchAll(/id: (\d+)\nevent: nachricht\n/g)].map((treffer) => Number(treffer[1]));
}

/** Öffnet den Stream unter `url` und legt ihn in `offen` ab, damit der Test ihn danach schließt. */
export function stromOeffnen(url: string, offen: Strom[], kopf: Record<string, string> = {}): Promise<Strom> {
  return new Promise((fertig, fehler) => {
    const anfrage = httpAnfrage(url, { headers: { accept: 'text/event-stream', ...kopf } }, (antwort) => {
      let text = '';
      const wartende: (() => void)[] = [];
      antwort.setEncoding('utf8');
      antwort.on('data', (teil: string) => {
        text += teil;
        for (const wecken of wartende.splice(0)) {
          wecken();
        }
      });
      const strom: Strom = {
        status: antwort.statusCode ?? 0,
        kopf: antwort.headers,
        text: () => text,
        warten: (bedingung) =>
          new Promise((erfuellt, abgelaufen) => {
            const frist = setTimeout(() => {
              abgelaufen(new Error(`Nicht eingetroffen. Bisher:\n${text}`));
            }, 3000);
            const pruefen = (): void => {
              if (bedingung(text)) {
                clearTimeout(frist);
                erfuellt(text);
              } else {
                wartende.push(pruefen);
              }
            };
            pruefen();
          }),
        schliessen: () => {
          anfrage.destroy();
        },
      };
      offen.push(strom);
      fertig(strom);
    });
    anfrage.on('error', (grund: Error & { code?: string }) => {
      if (grund.code !== 'ECONNRESET') {
        fehler(grund);
      }
    });
    anfrage.end();
  });
}
