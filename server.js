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
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        bed_id VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        booked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
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
        bookedAt: row.booked_at
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
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }

  try {
    await pool.query(`
      INSERT INTO bookings (bed_id, name, booked_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (bed_id) 
      DO UPDATE SET name = $2, booked_at = CURRENT_TIMESTAMP
    `, [bedId, name.trim()]);
    
    res.json({ success: true, bedId, name });
  } catch (err) {
    console.error('Fehler beim Speichern der Buchung:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Buchung löschen
app.delete('/api/bookings/:bedId', async (req, res) => {
  const { bedId } = req.params;

  try {
    await pool.query('DELETE FROM bookings WHERE bed_id = $1', [bedId]);
    res.json({ success: true, bedId });
  } catch (err) {
    console.error('Fehler beim Löschen der Buchung:', err.message);
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
