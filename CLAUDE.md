# Treffen-App – Hinweise für die Arbeit am Repo

## ⚠️ Header und Footer gibt es DOPPELT – immer beide Repos pflegen

Diese App teilt sich das Erscheinungsbild mit der Vereins-Hauptseite
(Astro-Repo `../Spiele-Reviews`), aber **ohne geteilte Komponente**: Kopf- und
Fußzeile sind hier als HTML einkopiert.

| | Treffen-App (dieses Repo) | Astro-Seite (`../Spiele-Reviews`) |
|---|---|---|
| Header | `public/index.html` **und** `public/admin.html` | `src/components/Header.astro` |
| Footer | `public/index.html` **und** `public/admin.html` | `src/components/Footer.astro` |

**Jede Änderung an Navigation, Logo, Footer-Links oder deren Beschriftung muss in
beiden Repos gemacht werden – und hier in beiden HTML-Dateien.** Sonst sehen
`herbsttreffen.brettspielfamilie.de` und `brettspielfamilie.de` unterschiedlich aus
(ist schon mehrfach passiert).

Prüfen lässt sich das vom Astro-Repo aus:

```bash
npm run check:header
```

Treffen-spezifische Zusatz-Links (`⚙️ Admin`, Link zum Freizeitheim) sind erlaubt und
werden von der Prüfung ignoriert.

## Deployment

Diese App deployt **nicht** automatisch: nach dem Push in **Dokploy manuell neu
deployen**. Die Astro-Seite deployt dagegen automatisch – nach einer Änderung an beiden
Repos also daran denken, sonst ist nur die halbe Seite aktuell.

Das Event-Routing über Subdomains (`{slug}.brettspielfamilie.de`) läuft in `server.js`
per Host-Auswertung – beim Anfassen von Header/Footer nicht verändern.
