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
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS train_station VARCHAR(100) DEFAULT NULL`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS train_time TIME DEFAULT NULL`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS train_number VARCHAR(50) DEFAULT NULL`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS arrival_time TIME DEFAULT NULL`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS departure_time TIME DEFAULT NULL`);

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
        departureCity: row.departure_city,
        trainStation: row.train_station,
        trainTime: row.train_time,
        trainNumber: row.train_number,
        arrivalTime: row.arrival_time,
        departureTime: row.departure_time
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
  const { name, roomRestriction, roomBeds, arrivalDate, departureDate, arrivalTime, departureTime, transport, needsPickup, canOfferRide, seatsAvailable, departureCity, trainStation, trainTime, trainNumber } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Hauptbuchung erstellen
    await client.query(`
      INSERT INTO bookings (bed_id, name, booked_at, status, blocked_by, arrival_date, departure_date, arrival_time, departure_time, transport, needs_pickup, can_offer_ride, seats_available, departure_city, train_station, train_time, train_number)
      VALUES ($1, $2, CURRENT_TIMESTAMP, 'booked', NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (bed_id) 
      DO UPDATE SET name = $2, booked_at = CURRENT_TIMESTAMP, status = 'booked', blocked_by = NULL,
                    arrival_date = $3, departure_date = $4, arrival_time = $5, departure_time = $6, transport = $7, needs_pickup = $8,
                    can_offer_ride = $9, seats_available = $10, departure_city = $11,
                    train_station = $12, train_time = $13, train_number = $14
    `, [bedId, name.trim(), arrivalDate || null, departureDate || null, arrivalTime || null, departureTime || null, transport || null, needsPickup || false, canOfferRide || false, seatsAvailable || 0, departureCity || null, trainStation || null, trainTime || null, trainNumber || null]);
    
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
  const { name, arrivalDate, departureDate, arrivalTime, departureTime, transport, needsPickup, canOfferRide, seatsAvailable, departureCity, trainStation, trainTime, trainNumber } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }

  try {
    await pool.query(`
      UPDATE bookings 
      SET name = $1, status = 'booked', booked_at = CURRENT_TIMESTAMP,
          arrival_date = $2, departure_date = $3, arrival_time = $4, departure_time = $5, transport = $6, needs_pickup = $7,
          can_offer_ride = $8, seats_available = $9, departure_city = $10,
          train_station = $11, train_time = $12, train_number = $13
      WHERE bed_id = $14 AND status IN ('women_only', 'men_only')
    `, [name.trim(), arrivalDate || null, departureDate || null, arrivalTime || null, departureTime || null, transport || null, needsPickup || false, canOfferRide || false, seatsAvailable || 0, departureCity || null, trainStation || null, trainTime || null, trainNumber || null, bedId]);
    
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
