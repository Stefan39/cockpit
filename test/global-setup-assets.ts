/**
 * Einmal je Testlauf (COPI-30): das Stylesheet und die Schriften bauen.
 *
 * Jede Seite verweist auf das gehashte Stylesheet, und `buildApp` liest das Manifest beim Start —
 * ohne gebaute Assets liefe kein einziger Test, der die Anwendung aufbaut. Der Build dauert
 * knapp eine Sekunde und läuft mit demselben Code wie `npm run assets` und das Docker-Image.
 */
import { assetsBauen } from '../src/assets/bauen.js';

export default function setup(): void {
  assetsBauen();
}
