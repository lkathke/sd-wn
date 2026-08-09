# Setup auf einem neuen Rechner

Kurzanleitung, um den Whatnot Stream Deck Controller auf einem zweiten/neuen Rechner
lauffähig zu bekommen. Siehe `CLAUDE.md` für Architektur-Hintergrund.

## Variante A: Nur ausführen (kein Code ändern)

1. **Elgato Stream Deck Software** installieren (mind. Version 7.1). Node.js wird dafür
   **nicht** benötigt — Stream Deck bringt seine eigene Node.js-Runtime mit (siehe
   `"Nodejs": {"Version": "24"}` in `streamdeck-plugin/com.lkathke.whatnot-controller.sdPlugin/manifest.json`)
   und führt das fertig gebaute Plugin direkt darüber aus.
2. Dieses Repo auf den neuen Rechner klonen/kopieren (z. B. `git clone`).
3. Den Ordner `streamdeck-plugin/com.lkathke.whatnot-controller.sdPlugin/` in Stream Decks
   Plugin-Verzeichnis kopieren:
   - Windows: `%APPDATA%\Elgato\StreamDeck\Plugins\`
   - Mac: `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`
4. Stream Deck App neu starten — das Plugin ("Whatnot Controller") sollte automatisch
   erkannt werden.
5. **Tastenbelegung übernehmen**: `Default Profile.streamDeckProfile` (im Repo-Root) in der
   Stream Deck App über *Profile → Importieren* einlesen, statt alle Tasten von Hand neu
   anzulegen.
6. **Chrome-Extension**: `chrome://extensions` → Entwicklermodus aktivieren → "Entpackt
   laden" → Ordner `whatnot-helper/` auswählen.

## Variante B: Auch weiter am Code arbeiten

Zusätzlich zu Variante A:

1. **Node.js** installieren (aktuelle LTS-Version, 20+ reicht — nur zum *Bauen*, nicht zum
   Ausführen).
2. Im Ordner `streamdeck-plugin/`:
   ```
   npm install
   npm run build
   ```
3. Statt Schritt 3 aus Variante A einmalig ausführen (registriert den Ordner offiziell bei
   Stream Deck statt ihn nur zu kopieren):
   ```
   npx @elgato/cli link
   ```
   Danach funktionieren die üblichen Dev-Befehle:
   ```
   npm run build
   npx @elgato/cli validate com.lkathke.whatnot-controller.sdPlugin
   npx @elgato/cli restart com.lkathke.whatnot-controller
   ```

### Bekannter Stolperstein: "restart" startet nicht wirklich neu

`streamdeck restart <uuid>` meldet manchmal Erfolg, ohne dass der alte Node-Prozess wirklich
beendet wird. Falls sich das Plugin nach einem Rebuild nicht wie erwartet verhält, PID prüfen:

```powershell
Get-NetTCPConnection -LocalPort 9271 | Select OwningProcess
# ... nach restart erneut prüfen — gleiche PID? Dann hat der Restart nicht gegriffen.
```

Falls die PID gleich geblieben ist, den Prozess manuell beenden (`Stop-Process -Id <pid> -Force`)
und danach erneut `restart` ausführen.

## Voraussetzungen, die unverändert bleiben

- Ein Elgato Stream Deck (Hardware) ist für den produktiven Einsatz nötig, für reine
  Code-Arbeit nicht zwingend.
- Der Chrome-Tab mit dem Whatnot-Live-Dashboard muss offen sein, damit sich die Extension
  mit dem Plugin verbinden kann (Status-Punkt im Overlay zeigt grün, wenn verbunden).
- **Nur einen** Whatnot-Live-Dashboard-Tab gleichzeitig offen halten — mehrere Tabs führen
  dazu, dass die Anzeige-Tasten (Preis/Versand) zwischen den Tabs "flackern", da jeder Tab
  unabhängig seinen eigenen Stand an das Plugin meldet.
