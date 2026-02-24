const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://brettspielfamilie:1qay2wsx3edc@brettspielfamilie-maitreffendb-epibyx:5432/maitreffen-db',
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Datenbank initialisieren
async function initDB() {
  const client = await pool.connect();
  try {
    // Tabelle erstellen falls nicht vorhanden
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        bed_id VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        booked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(20) DEFAULT 'booked',
        blocked_by VARCHAR(50) DEFAULT NULL
      )
    `);
    
    // Status-Spalte hinzufügen falls nicht vorhanden (für bestehende DBs)
    await client.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'booked'
    `);
    
    // blocked_by-Spalte hinzufügen falls nicht vorhanden
    await client.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS blocked_by VARCHAR(50) DEFAULT NULL
    `);
    
    console.log('✅ Datenbank-Tabelle bereit');
  } catch (err) {
    console.error('❌ Fehler beim Initialisieren der Datenbank:', err.message);
  } finally {
    client.release();
  }
}

// API Routes

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Alle Buchungen abrufen
app.get('/api/bookings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bookings');
    const bookings = {};
    result.rows.forEach(row => {
      bookings[row.bed_id] = {
        name: row.name,
        bookedAt: row.booked_at,
        status: row.status || 'booked',
        blockedBy: row.blocked_by
      };
    });
    res.json(bookings);
  } catch (err) {
    console.error('Fehler beim Abrufen der Buchungen:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Buchung erstellen/aktualisieren
app.post('/api/bookings/:bedId', async (req, res) => {
  const { bedId } = req.params;
  const { name, blockRoom, roomBeds } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Hauptbuchung erstellen
    await client.query(`
      INSERT INTO bookings (bed_id, name, booked_at, status, blocked_by)
      VALUES ($1, $2, CURRENT_TIMESTAMP, 'booked', NULL)
      ON CONFLICT (bed_id) 
      DO UPDATE SET name = $2, booked_at = CURRENT_TIMESTAMP, status = 'booked', blocked_by = NULL
    `, [bedId, name.trim()]);
    
    // Wenn blockRoom aktiviert ist, restliche Betten blockieren
    if (blockRoom && roomBeds && Array.isArray(roomBeds)) {
      for (const otherBedId of roomBeds) {
        if (otherBedId !== bedId) {
          // Nur blockieren wenn das Bett noch frei ist
          const existing = await client.query('SELECT * FROM bookings WHERE bed_id = $1', [otherBedId]);
          if (existing.rows.length === 0) {
            await client.query(`
              INSERT INTO bookings (bed_id, name, booked_at, status, blocked_by)
              VALUES ($1, $2, CURRENT_TIMESTAMP, 'blocked', $3)
            `, [otherBedId, `🔒 ${name.trim()}`, bedId]);
          }
        }
      }
    }
    
    await client.query('COMMIT');
    res.json({ success: true, bedId, name });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Fehler beim Speichern der Buchung:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  } finally {
    client.release();
  }
});

// Buchung löschen
app.delete('/api/bookings/:bedId', async (req, res) => {
  const { bedId } = req.params;

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Auch alle Betten löschen, die von dieser Buchung blockiert wurden
    await client.query('DELETE FROM bookings WHERE blocked_by = $1', [bedId]);
    
    // Hauptbuchung löschen
    await client.query('DELETE FROM bookings WHERE bed_id = $1', [bedId]);
    
    await client.query('COMMIT');
    res.json({ success: true, bedId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Fehler beim Löschen der Buchung:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  } finally {
    client.release();
  }
});

// Einzelnes blockiertes Bett freigeben
app.delete('/api/bookings/:bedId/unblock', async (req, res) => {
  const { bedId } = req.params;

  try {
    // Nur löschen wenn es ein blockiertes Bett ist
    await pool.query("DELETE FROM bookings WHERE bed_id = $1 AND status = 'blocked'", [bedId]);
    res.json({ success: true, bedId });
  } catch (err) {
    console.error('Fehler beim Freigeben:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Fallback für SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server starten
app.listen(PORT, async () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
  await initDB();
});
