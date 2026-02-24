# Maitreffen Zimmerbuchung 🌲

Interaktive Zimmerbelegung für das Maitreffen der Brettspielfamilie im Evangelischen Freizeitheim Halbe.

## Features

- 📱 Mobile-optimiert (Touch-freundlich)
- 🏠 Card-basiertes Zimmer-Layout
- 💾 Echtzeit-Buchungssystem mit PostgreSQL
- 🎨 Responsive Design für alle Geräte

## Zimmerübersicht

### Erdgeschoss (mit eigenem Bad)

| Zimmer | Betten | Besonderheit |
|--------|--------|--------------|
| Zi 1 | 3 | Eigenes Bad |
| Zi 2 | 2 | Eigenes Bad, ♿ Barrierefrei |
| Zi 3 | 2 | Eigenes Bad |

### Obergeschoss (Gemeinschaftsbäder)

| Zimmer | Betten |
|--------|--------|
| Zi 4 | 3 |
| Zi 5 | 4 |
| Zi 6 | 3 |
| Zi 7 | 3 |
| Zi 8 | 2 |
| Zi 9 | 3 |

**Gesamt: 25 Betten** (7 EG + 18 OG)

## Deployment mit Dokploy

1. Git Repository pushen
2. In Dokploy als "Application" hinzufügen (Dockerfile)
3. Environment Variable `DATABASE_URL` setzen:
   ```
   postgresql://brettspielfamilie:1qay2wsx3edc@brettspielfamilie-maitreffendb-epibyx:5432/maitreffen-db
   ```
4. Domain: `maitreffen.brettspielfamilie.de`
5. Port: `3000`

## Lokale Entwicklung

```bash
npm install
DATABASE_URL="postgresql://..." npm start
```

## Haus-Info

📍 **Evangelisches Freizeitheim Halbe**  
Kirchstraße 7, 15757 Halbe  
🌐 [www.freizeitheim-halbe.de](https://www.freizeitheim-halbe.de)
