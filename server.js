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
    // Buchungen-Tabelle
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        bed_id VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        booked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(20) DEFAULT 'booked',
        blocked_by VARCHAR(50) DEFAULT NULL,
        arrival_date DATE DEFAULT NULL,
        departure_date DATE DEFAULT NULL,
        transport VARCHAR(20) DEFAULT NULL,
        needs_pickup BOOLEAN DEFAULT FALSE,
        can_offer_ride BOOLEAN DEFAULT FALSE,
        seats_available INTEGER DEFAULT 0,
        departure_city VARCHAR(100) DEFAULT NULL
      )
    `);
    
    // Spalten hinzufügen falls nicht vorhanden (für bestehende DBs)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'booked'`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS blocked_by VARCHAR(50) DEFAULT NULL`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS arrival_date DATE DEFAULT NULL`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS departure_date DATE DEFAULT NULL`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS transport VARCHAR(20) DEFAULT NULL`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS needs_pickup BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS can_offer_ride BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS seats_available INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS departure_city VARCHAR(100) DEFAULT NULL`);

    // Warteliste-Tabelle
    await client.query(`
      CREATE TABLE IF NOT EXISTS waitlist (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        comment VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Datenbank-Tabellen bereit');
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
        blockedBy: row.blocked_by,
        arrivalDate: row.arrival_date,
        departureDate: row.departure_date,
        transport: row.transport,
        needsPickup: row.needs_pickup,
        canOfferRide: row.can_offer_ride,
        seatsAvailable: row.seats_available,
        departureCity: row.departure_city
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
  const { name, roomRestriction, roomBeds, arrivalDate, departureDate, transport, needsPickup, canOfferRide, seatsAvailable, departureCity } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Hauptbuchung erstellen
    await client.query(`
      INSERT INTO bookings (bed_id, name, booked_at, status, blocked_by, arrival_date, departure_date, transport, needs_pickup, can_offer_ride, seats_available, departure_city)
      VALUES ($1, $2, CURRENT_TIMESTAMP, 'booked', NULL, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (bed_id) 
      DO UPDATE SET name = $2, booked_at = CURRENT_TIMESTAMP, status = 'booked', blocked_by = NULL,
                    arrival_date = $3, departure_date = $4, transport = $5, needs_pickup = $6,
                    can_offer_ride = $7, seats_available = $8, departure_city = $9
    `, [bedId, name.trim(), arrivalDate || null, departureDate || null, transport || null, needsPickup || false, canOfferRide || false, seatsAvailable || 0, departureCity || null]);
    
    // Zimmer-Einschränkung setzen
    if (roomRestriction && roomRestriction !== 'none' && roomBeds && Array.isArray(roomBeds)) {
      for (const otherBedId of roomBeds) {
        if (otherBedId !== bedId) {
          const existing = await client.query('SELECT * FROM bookings WHERE bed_id = $1', [otherBedId]);
          if (existing.rows.length === 0) {
            let status, displayName;
            
            if (roomRestriction === 'blocked') {
              status = 'blocked';
              displayName = `🔒 ${name.trim()}`;
            } else if (roomRestriction === 'women') {
              status = 'women_only';
              displayName = '♀️ Frauenzimmer';
            } else if (roomRestriction === 'men') {
              status = 'men_only';
              displayName = '♂️ Männerzimmer';
            }
            
            if (status) {
              await client.query(`
                INSERT INTO bookings (bed_id, name, booked_at, status, blocked_by)
                VALUES ($1, $2, CURRENT_TIMESTAMP, $3, $4)
              `, [otherBedId, displayName, status, bedId]);
            }
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
    await client.query('DELETE FROM bookings WHERE blocked_by = $1', [bedId]);
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

// Einzelnes blockiertes/markiertes Bett freigeben
app.delete('/api/bookings/:bedId/unblock', async (req, res) => {
  const { bedId } = req.params;

  try {
    await pool.query("DELETE FROM bookings WHERE bed_id = $1 AND status IN ('blocked', 'women_only', 'men_only')", [bedId]);
    res.json({ success: true, bedId });
  } catch (err) {
    console.error('Fehler beim Freigeben:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Markiertes Bett buchen (Frau/Mann bucht in Frauen-/Männerzimmer)
app.post('/api/bookings/:bedId/claim', async (req, res) => {
  const { bedId } = req.params;
  const { name, arrivalDate, departureDate, transport, needsPickup, canOfferRide, seatsAvailable, departureCity } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }

  try {
    await pool.query(`
      UPDATE bookings 
      SET name = $1, status = 'booked', booked_at = CURRENT_TIMESTAMP,
          arrival_date = $2, departure_date = $3, transport = $4, needs_pickup = $5,
          can_offer_ride = $6, seats_available = $7, departure_city = $8
      WHERE bed_id = $9 AND status IN ('women_only', 'men_only')
    `, [name.trim(), arrivalDate || null, departureDate || null, transport || null, needsPickup || false, canOfferRide || false, seatsAvailable || 0, departureCity || null, bedId]);
    
    res.json({ success: true, bedId, name });
  } catch (err) {
    console.error('Fehler beim Buchen:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==================== WARTELISTE ====================

app.get('/api/waitlist', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM waitlist ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler beim Abrufen der Warteliste:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.post('/api/waitlist', async (req, res) => {
  const { name, comment } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }

  try {
    const result = await pool.query(`
      INSERT INTO waitlist (name, comment, created_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      RETURNING *
    `, [name.trim(), comment?.trim() || null]);
    
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('Fehler beim Hinzufügen zur Warteliste:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.delete('/api/waitlist/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('DELETE FROM waitlist WHERE id = $1', [id]);
    res.json({ success: true, id });
  } catch (err) {
    console.error('Fehler beim Entfernen von der Warteliste:', err.message);
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
