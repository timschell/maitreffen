const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

// BGG API Token (Non-Commercial License)
const BGG_API_TOKEN = process.env.BGG_API_TOKEN || '';

// Einfacher In-Memory Cache für BGG Requests (1 Stunde)
const bggCache = new Map();
const BGG_CACHE_TTL = 60 * 60 * 1000; // 1 Stunde

const getCachedOrFetch = async (url) => {
  const cached = bggCache.get(url);
  if (cached && Date.now() - cached.timestamp < BGG_CACHE_TTL) {
    console.log('BGG Cache Hit:', url);
    return cached.data;
  }
  
  console.log('BGG Fetching:', url);
  const headers = {};
  if (BGG_API_TOKEN) {
    headers['Authorization'] = `Bearer ${BGG_API_TOKEN}`;
  }
  
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`BGG API Error: ${response.status}`);
  }
  
  const data = await response.text();
  bggCache.set(url, { data, timestamp: Date.now() });
  
  // Cache aufräumen (max 500 Einträge)
  if (bggCache.size > 500) {
    const oldestKey = bggCache.keys().next().value;
    bggCache.delete(oldestKey);
  }
  
  return data;
};

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

// Event-Erkennung Middleware (erkennt Event anhand Subdomain)
app.use(async (req, res, next) => {
  // Skip für statische Dateien und Admin-Routes
  if (req.path.startsWith('/api/admin') || !req.path.startsWith('/api/')) {
    return next();
  }
  
  try {
    const host = req.hostname || req.headers.host || '';
    const subdomain = host.split('.')[0];
    
    // Versuche Event anhand Subdomain zu finden
    let event = null;
    if (subdomain && subdomain !== 'www' && subdomain !== 'localhost') {
      const result = await pool.query(
        'SELECT * FROM events WHERE slug = $1',
        [subdomain]
      );
      if (result.rows.length > 0) {
        event = result.rows[0];
      }
    }
    
    // Fallback: Aktives Event laden
    if (!event) {
      const result = await pool.query(
        'SELECT * FROM events WHERE is_active = true LIMIT 1'
      );
      if (result.rows.length > 0) {
        event = result.rows[0];
      }
    }
    
    req.event = event;
    req.eventId = event?.id || null;
    next();
  } catch (err) {
    console.error('Event-Middleware Fehler:', err.message);
    next();
  }
});

// Datenbank initialisieren
async function initDB() {
  const client = await pool.connect();
  try {
    // ==================== MULTI-EVENT SYSTEM ====================
    
    // Events-Tabelle (persistent)
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(200) NOT NULL,
        description TEXT DEFAULT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        location_name VARCHAR(200) DEFAULT NULL,
        location_address TEXT DEFAULT NULL,
        location_url VARCHAR(500) DEFAULT NULL,
        check_in_time TIME DEFAULT '15:00',
        check_out_time TIME DEFAULT '11:00',
        is_active BOOLEAN DEFAULT FALSE,
        is_booking_open BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Zimmer pro Event (konfigurierbar statt hardcoded)
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_rooms (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        room_name VARCHAR(100) NOT NULL,
        floor VARCHAR(50) DEFAULT NULL,
        beds_count INTEGER NOT NULL DEFAULT 1,
        has_private_bath BOOLEAN DEFAULT FALSE,
        is_accessible BOOLEAN DEFAULT FALSE,
        notes TEXT DEFAULT NULL,
        sort_order INTEGER DEFAULT 0
      )
    `);

    // Nutzer-Tabelle (persistent über Events hinweg)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        pin_hash VARCHAR(64) DEFAULT NULL,
        is_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP DEFAULT NULL
      )
    `);

    // Buchungen-Tabelle (mit event_id für Multi-Event Support)
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        bed_id VARCHAR(100) NOT NULL,
        name VARCHAR(100) NOT NULL,
        booked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(20) DEFAULT 'booked',
        blocked_by VARCHAR(100) DEFAULT NULL,
        arrival_date DATE DEFAULT NULL,
        departure_date DATE DEFAULT NULL,
        transport VARCHAR(20) DEFAULT NULL,
        needs_pickup BOOLEAN DEFAULT FALSE,
        can_offer_ride BOOLEAN DEFAULT FALSE,
        seats_available INTEGER DEFAULT 0,
        departure_city VARCHAR(100) DEFAULT NULL,
        UNIQUE(event_id, bed_id)
      )
    `);
    
    // Migration: Spalten hinzufügen falls nicht vorhanden (für bestehende DBs)
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id) ON DELETE CASCADE`);
    
    // Unique Constraint anpassen: von (bed_id) zu (event_id, bed_id)
    // Erst alte Constraint entfernen (falls vorhanden), dann neue hinzufügen
    try {
      await client.query(`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_bed_id_key`);
    } catch (e) { /* Constraint existiert nicht, ignorieren */ }
    
    // Neue Constraint nur hinzufügen wenn sie nicht existiert
    try {
      await client.query(`ALTER TABLE bookings ADD CONSTRAINT bookings_event_bed_unique UNIQUE (event_id, bed_id)`);
    } catch (e) { /* Constraint existiert bereits, ignorieren */ }
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'booked'`);
    await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS blocked_by VARCHAR(100) DEFAULT NULL`);
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

    // Spiele-Tabelle (mit event_id)
    await client.query(`
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        game_name VARCHAR(200) NOT NULL,
        person_name VARCHAR(100) NOT NULL,
        type VARCHAR(20) NOT NULL DEFAULT 'bring',
        fulfilled_by VARCHAR(100) DEFAULT NULL,
        bgg_id INTEGER DEFAULT NULL,
        bgg_thumbnail VARCHAR(500) DEFAULT NULL,
        bgg_image VARCHAR(500) DEFAULT NULL,
        bgg_year INTEGER DEFAULT NULL,
        bgg_min_players INTEGER DEFAULT NULL,
        bgg_max_players INTEGER DEFAULT NULL,
        bgg_playtime VARCHAR(50) DEFAULT NULL,
        bgg_description TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Migration: Spalten zu games hinzufügen falls nicht vorhanden
    await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id) ON DELETE CASCADE`);
    await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS bgg_id INTEGER DEFAULT NULL`);
    await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS bgg_thumbnail VARCHAR(500) DEFAULT NULL`);
    await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS bgg_image VARCHAR(500) DEFAULT NULL`);
    await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS bgg_year INTEGER DEFAULT NULL`);
    await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS bgg_min_players INTEGER DEFAULT NULL`);
    await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS bgg_max_players INTEGER DEFAULT NULL`);
    await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS bgg_playtime VARCHAR(50) DEFAULT NULL`);
    await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS bgg_description TEXT DEFAULT NULL`);

    // Warteliste-Tabelle (mit event_id)
    await client.query(`
      CREATE TABLE IF NOT EXISTS waitlist (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        comment VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Migration: event_id zu waitlist hinzufügen
    await client.query(`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id) ON DELETE CASCADE`);

    // Persönliche Spielesammlungen (persistent über Events hinweg)
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_collections (
        id SERIAL PRIMARY KEY,
        owner_name VARCHAR(100) NOT NULL,
        bgg_id INTEGER NOT NULL,
        game_name VARCHAR(200) NOT NULL,
        bgg_thumbnail VARCHAR(500) DEFAULT NULL,
        bgg_image VARCHAR(500) DEFAULT NULL,
        bgg_year INTEGER DEFAULT NULL,
        bgg_min_players INTEGER DEFAULT NULL,
        bgg_max_players INTEGER DEFAULT NULL,
        bgg_playtime VARCHAR(50) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(owner_name, bgg_id)
      )
    `);
    
    console.log('✅ Datenbank-Tabellen bereit');

    // ==================== AUTO-MIGRATION: Maitreffen 2026 ====================
    // Prüfe ob ein Event existiert, falls nicht, lege Maitreffen 2026 an
    const eventCheck = await client.query('SELECT id FROM events LIMIT 1');
    
    if (eventCheck.rows.length === 0) {
      console.log('📦 Kein Event gefunden, lege Maitreffen 2026 an...');
      
      // Event anlegen
      const eventResult = await client.query(`
        INSERT INTO events (slug, name, description, start_date, end_date, location_name, location_address, location_url, check_in_time, check_out_time, is_active)
        VALUES ('maitreffen', 'Maitreffen 2026', 'Das jährliche Brettspieltreffen der Brettspielfamilie', '2026-05-13', '2026-05-17', 'Evangelisches Freizeitheim Halbe', 'Kirchstraße 7, 15757 Halbe', 'https://www.freizeitheim-halbe.de', '16:00', '11:00', true)
        RETURNING id
      `);
      
      const eventId = eventResult.rows[0].id;
      console.log(`✅ Event angelegt (ID: ${eventId})`);
      
      // Zimmer anlegen
      const rooms = [
        { room_name: 'Zimmer 1', floor: 'EG', beds_count: 3, has_private_bath: true, is_accessible: false, sort_order: 1 },
        { room_name: 'Zimmer 2', floor: 'EG', beds_count: 2, has_private_bath: true, is_accessible: true, sort_order: 2 },
        { room_name: 'Zimmer 3', floor: 'EG', beds_count: 2, has_private_bath: true, is_accessible: false, sort_order: 3 },
        { room_name: 'Zimmer 4', floor: 'OG', beds_count: 3, has_private_bath: false, is_accessible: false, sort_order: 4 },
        { room_name: 'Zimmer 5', floor: 'OG', beds_count: 4, has_private_bath: false, is_accessible: false, sort_order: 5 },
        { room_name: 'Zimmer 6', floor: 'OG', beds_count: 3, has_private_bath: false, is_accessible: false, sort_order: 6 },
        { room_name: 'Zimmer 7', floor: 'OG', beds_count: 3, has_private_bath: false, is_accessible: false, sort_order: 7 },
        { room_name: 'Zimmer 8', floor: 'OG', beds_count: 2, has_private_bath: false, is_accessible: false, sort_order: 8 },
        { room_name: 'Zimmer 9', floor: 'OG', beds_count: 3, has_private_bath: false, is_accessible: false, sort_order: 9 },
      ];
      
      for (const room of rooms) {
        await client.query(`
          INSERT INTO event_rooms (event_id, room_name, floor, beds_count, has_private_bath, is_accessible, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [eventId, room.room_name, room.floor, room.beds_count, room.has_private_bath, room.is_accessible, room.sort_order]);
      }
      console.log(`✅ 9 Zimmer angelegt (25 Betten)`);
      
      // Bestehende Daten mit Event verknüpfen
      const bookingsLinked = await client.query('UPDATE bookings SET event_id = $1 WHERE event_id IS NULL', [eventId]);
      const gamesLinked = await client.query('UPDATE games SET event_id = $1 WHERE event_id IS NULL', [eventId]);
      const waitlistLinked = await client.query('UPDATE waitlist SET event_id = $1 WHERE event_id IS NULL', [eventId]);
      
      if (bookingsLinked.rowCount > 0 || gamesLinked.rowCount > 0 || waitlistLinked.rowCount > 0) {
        console.log(`✅ Bestehende Daten verknüpft: ${bookingsLinked.rowCount} Buchungen, ${gamesLinked.rowCount} Spiele, ${waitlistLinked.rowCount} Warteliste`);
      }
    } else {
      // Event existiert - prüfe ob es verwaiste Daten gibt und verknüpfe sie mit aktivem Event
      const activeEvent = await client.query('SELECT id FROM events WHERE is_active = true LIMIT 1');
      if (activeEvent.rows.length > 0) {
        const eventId = activeEvent.rows[0].id;
        const orphanedBookings = await client.query('UPDATE bookings SET event_id = $1 WHERE event_id IS NULL', [eventId]);
        const orphanedGames = await client.query('UPDATE games SET event_id = $1 WHERE event_id IS NULL', [eventId]);
        const orphanedWaitlist = await client.query('UPDATE waitlist SET event_id = $1 WHERE event_id IS NULL', [eventId]);
        
        if (orphanedBookings.rowCount > 0 || orphanedGames.rowCount > 0 || orphanedWaitlist.rowCount > 0) {
          console.log(`✅ Verwaiste Daten verknüpft: ${orphanedBookings.rowCount} Buchungen, ${orphanedGames.rowCount} Spiele, ${orphanedWaitlist.rowCount} Warteliste`);
        }
      }
    }
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

// ==================== EVENT API ====================

// Aktuelles Event abrufen (basierend auf Subdomain/aktivem Event)
app.get('/api/event', async (req, res) => {
  if (!req.event) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  
  try {
    // Zimmer für dieses Event laden
    const roomsResult = await pool.query(
      'SELECT * FROM event_rooms WHERE event_id = $1 ORDER BY sort_order, room_name',
      [req.event.id]
    );
    
    res.json({
      ...req.event,
      rooms: roomsResult.rows
    });
  } catch (err) {
    console.error('Fehler beim Laden des Events:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==================== ADMIN API ====================

// Admin-Passwort (Fallback, WordPress SSO ist primär)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'brettspielfamilie2026';

// WordPress SSO URL
const WP_SSO_URL = process.env.WP_SSO_URL || 'https://brettspielfamilie.de/wp-json/bsf/v1/me';

// WordPress Token-Validierung URL
const WP_VALIDATE_URL = process.env.WP_VALIDATE_URL || 'https://brettspielfamilie.de/wp-json/bsf/v1/validate-token';

// Admin-Auth Middleware (WordPress Token oder Passwort)
const adminAuth = async (req, res, next) => {
  // Option 1: Passwort-Token
  const token = req.headers['x-admin-token'];
  if (token === ADMIN_PASSWORD) {
    return next();
  }
  
  // Option 2: WordPress SSO Token validieren
  const wpToken = req.headers['x-wp-token'];
  if (wpToken) {
    try {
      const wpRes = await fetch(WP_VALIDATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: wpToken })
      });
      
      if (wpRes.ok) {
        const data = await wpRes.json();
        if (data.valid) {
          req.wpUser = data;
          return next();
        }
      }
    } catch (err) {
      console.error('WordPress Token-Validierung fehlgeschlagen:', err.message);
    }
  }
  
  return res.status(401).json({ error: 'Nicht autorisiert' });
};

// Debug: Cookie-Check (temporär)
app.get('/api/debug/cookies', async (req, res) => {
  const cookies = req.headers.cookie || '';
  let wpResult = null;
  
  if (cookies) {
    try {
      const wpRes = await fetch(WP_SSO_URL, {
        headers: { 'Cookie': cookies }
      });
      wpResult = await wpRes.json();
    } catch (err) {
      wpResult = { error: err.message };
    }
  }
  
  res.json({
    hasCookies: !!cookies,
    cookieLength: cookies.length,
    cookiePreview: cookies.substring(0, 100) + '...',
    wpResult
  });
});

// Admin Login (Passwort-Fallback)
app.post('/api/admin/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Falsches Passwort' });
  }
});

// ==================== WORDPRESS SSO ====================

// SSO Status prüfen (Proxy zu WordPress)
app.get('/api/auth/me', async (req, res) => {
  // Cookies vom Client an WordPress weiterleiten
  const cookies = req.headers.cookie || '';
  
  try {
    const wpRes = await fetch(WP_SSO_URL, {
      headers: {
        'Cookie': cookies
      }
    });
    
    const data = await wpRes.json();
    res.json(data);
  } catch (err) {
    console.error('WordPress SSO Fehler:', err.message);
    res.json({ logged_in: false, error: 'WordPress nicht erreichbar' });
  }
});

// Login-Redirect URL
app.get('/api/auth/login-url', (req, res) => {
  const returnUrl = req.query.return || req.headers.referer || '/';
  const loginUrl = `https://brettspielfamilie.de/wp-login.php?redirect_to=${encodeURIComponent(returnUrl)}`;
  res.json({ url: loginUrl });
});

// Alle Events auflisten
app.get('/api/admin/events', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events ORDER BY start_date DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Neues Event erstellen
app.post('/api/admin/events', adminAuth, async (req, res) => {
  const { slug, name, description, startDate, endDate, locationName, locationAddress, locationUrl, checkInTime, checkOutTime } = req.body;
  
  if (!slug?.trim() || !name?.trim() || !startDate || !endDate) {
    return res.status(400).json({ error: 'slug, name, startDate und endDate sind erforderlich' });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO events (slug, name, description, start_date, end_date, location_name, location_address, location_url, check_in_time, check_out_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [slug.trim().toLowerCase(), name.trim(), description || null, startDate, endDate, locationName || null, locationAddress || null, locationUrl || null, checkInTime || '15:00', checkOutTime || '11:00']
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Event aktualisieren
app.put('/api/admin/events/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { slug, name, description, startDate, endDate, locationName, locationAddress, locationUrl, checkInTime, checkOutTime } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE events SET slug = $1, name = $2, description = $3, start_date = $4, end_date = $5, 
       location_name = $6, location_address = $7, location_url = $8, check_in_time = $9, check_out_time = $10
       WHERE id = $11 RETURNING *`,
      [slug, name, description || null, startDate, endDate, locationName || null, locationAddress || null, locationUrl || null, checkInTime || '15:00', checkOutTime || '11:00', id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Event löschen
app.delete('/api/admin/events/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query('DELETE FROM events WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Event aktivieren (nur eines kann aktiv sein)
app.post('/api/admin/events/:id/activate', adminAuth, async (req, res) => {
  const { id } = req.params;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE events SET is_active = false');
    await client.query('UPDATE events SET is_active = true WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  } finally {
    client.release();
  }
});

// Zimmer zu Event hinzufügen
app.post('/api/admin/events/:eventId/rooms', adminAuth, async (req, res) => {
  const { eventId } = req.params;
  const { roomName, floor, bedsCount, hasPrivateBath, isAccessible, notes, sortOrder } = req.body;
  
  if (!roomName?.trim() || !bedsCount) {
    return res.status(400).json({ error: 'roomName und bedsCount sind erforderlich' });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO event_rooms (event_id, room_name, floor, beds_count, has_private_bath, is_accessible, notes, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [eventId, roomName.trim(), floor || null, bedsCount, hasPrivateBath || false, isAccessible || false, notes || null, sortOrder || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Alle Zimmer eines Events abrufen
app.get('/api/admin/events/:eventId/rooms', adminAuth, async (req, res) => {
  const { eventId } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT * FROM event_rooms WHERE event_id = $1 ORDER BY sort_order, room_name',
      [eventId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Zimmer aktualisieren
app.put('/api/admin/rooms/:roomId', adminAuth, async (req, res) => {
  const { roomId } = req.params;
  const { roomName, floor, bedsCount, hasPrivateBath, isAccessible, notes, sortOrder } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE event_rooms SET room_name = $1, floor = $2, beds_count = $3, has_private_bath = $4, is_accessible = $5, notes = $6, sort_order = $7
       WHERE id = $8 RETURNING *`,
      [roomName, floor || null, bedsCount, hasPrivateBath || false, isAccessible || false, notes || null, sortOrder || 0, roomId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Zimmer löschen
app.delete('/api/admin/rooms/:roomId', adminAuth, async (req, res) => {
  const { roomId } = req.params;
  
  try {
    await pool.query('DELETE FROM event_rooms WHERE id = $1', [roomId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==================== ADMIN: NUTZERVERWALTUNG ====================

// Alle Nutzer auflisten
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, pin_hash IS NOT NULL as has_pin, is_admin, created_at, last_login FROM users ORDER BY name ASC');
    // pin_hash nicht zurückgeben, nur ob einer gesetzt ist
    res.json(result.rows.map(u => ({
      ...u,
      pin_hash: u.has_pin ? 'set' : null
    })));
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// PIN zurücksetzen
app.post('/api/admin/users/:id/reset-pin', adminAuth, async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query('UPDATE users SET pin_hash = NULL WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin-Status ändern
app.post('/api/admin/users/:id/admin', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { isAdmin } = req.body;
  
  try {
    await pool.query('UPDATE users SET is_admin = $1 WHERE id = $2', [isAdmin, id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==================== BUCHUNGEN ====================

// Alle Buchungen abrufen (für aktuelles Event)
app.get('/api/bookings', async (req, res) => {
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  
  try {
    const result = await pool.query('SELECT * FROM bookings WHERE event_id = $1', [req.eventId]);
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

  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Hauptbuchung erstellen
    await client.query(`
      INSERT INTO bookings (event_id, bed_id, name, booked_at, status, blocked_by, arrival_date, departure_date, arrival_time, departure_time, transport, needs_pickup, can_offer_ride, seats_available, departure_city, train_station, train_time, train_number)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP, 'booked', NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (event_id, bed_id) 
      DO UPDATE SET name = $3, booked_at = CURRENT_TIMESTAMP, status = 'booked', blocked_by = NULL,
                    arrival_date = $4, departure_date = $5, arrival_time = $6, departure_time = $7, transport = $8, needs_pickup = $9,
                    can_offer_ride = $10, seats_available = $11, departure_city = $12,
                    train_station = $13, train_time = $14, train_number = $15
    `, [req.eventId, bedId, name.trim(), arrivalDate || null, departureDate || null, arrivalTime || null, departureTime || null, transport || null, needsPickup || false, canOfferRide || false, seatsAvailable || 0, departureCity || null, trainStation || null, trainTime || null, trainNumber || null]);
    
    // Zimmer-Einschränkung setzen
    if (roomRestriction && roomRestriction !== 'none' && roomBeds && Array.isArray(roomBeds)) {
      for (const otherBedId of roomBeds) {
        if (otherBedId !== bedId) {
          const existing = await client.query('SELECT * FROM bookings WHERE event_id = $1 AND bed_id = $2', [req.eventId, otherBedId]);
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
                INSERT INTO bookings (event_id, bed_id, name, booked_at, status, blocked_by)
                VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, $5)
              `, [req.eventId, otherBedId, displayName, status, bedId]);
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

  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM bookings WHERE event_id = $1 AND blocked_by = $2', [req.eventId, bedId]);
    await client.query('DELETE FROM bookings WHERE event_id = $1 AND bed_id = $2', [req.eventId, bedId]);
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

  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  try {
    await pool.query("DELETE FROM bookings WHERE event_id = $1 AND bed_id = $2 AND status IN ('blocked', 'women_only', 'men_only')", [req.eventId, bedId]);
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

  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

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
      WHERE event_id = $14 AND bed_id = $15 AND status IN ('women_only', 'men_only')
    `, [name.trim(), arrivalDate || null, departureDate || null, arrivalTime || null, departureTime || null, transport || null, needsPickup || false, canOfferRide || false, seatsAvailable || 0, departureCity || null, trainStation || null, trainTime || null, trainNumber || null, req.eventId, bedId]);
    
    res.json({ success: true, bedId, name });
  } catch (err) {
    console.error('Fehler beim Buchen:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==================== WARTELISTE ====================

app.get('/api/waitlist', async (req, res) => {
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  try {
    const result = await pool.query('SELECT * FROM waitlist WHERE event_id = $1 ORDER BY created_at ASC', [req.eventId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler beim Abrufen der Warteliste:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.post('/api/waitlist', async (req, res) => {
  const { name, comment } = req.body;

  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }

  try {
    const result = await pool.query(`
      INSERT INTO waitlist (event_id, name, comment, created_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      RETURNING *
    `, [req.eventId, name.trim(), comment?.trim() || null]);
    
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('Fehler beim Hinzufügen zur Warteliste:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.delete('/api/waitlist/:id', async (req, res) => {
  const { id } = req.params;

  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  try {
    await pool.query('DELETE FROM waitlist WHERE id = $1 AND event_id = $2', [id, req.eventId]);
    res.json({ success: true, id });
  } catch (err) {
    console.error('Fehler beim Entfernen von der Warteliste:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// === SPIELE API ===

// BGG API Status Endpoint
app.get('/api/bgg/status', (req, res) => {
  res.json({ 
    configured: !!BGG_API_TOKEN,
    cacheSize: bggCache.size
  });
});

// BGG Suche (Server-side mit Caching gemäß BGG Richtlinien)
app.get('/api/bgg/search', async (req, res) => {
  const { query } = req.query;
  
  if (!query?.trim()) {
    return res.json([]);
  }
  
  if (!BGG_API_TOKEN) {
    console.log('BGG: Kein API Token konfiguriert');
    return res.json([]);
  }
  
  try {
    // WICHTIG: boardgamegeek.com OHNE www (gemäß BGG Richtlinien)
    const searchUrl = `https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(query)}&type=boardgame`;
    const xml = await getCachedOrFetch(searchUrl);
    
    // XML Parsing
    const items = [];
    const itemMatches = xml.match(/<item.*?<\/item>/gs) || [];
    
    for (const item of itemMatches.slice(0, 15)) {
      const idMatch = item.match(/id="(\d+)"/);
      const nameMatch = item.match(/<name.*?value="([^"]+)"/);
      const yearMatch = item.match(/<yearpublished.*?value="(\d+)"/);
      
      if (idMatch && nameMatch) {
        items.push({
          bggId: parseInt(idMatch[1]),
          name: nameMatch[1],
          year: yearMatch ? parseInt(yearMatch[1]) : null
        });
      }
    }
    
    console.log(`BGG Suche "${query}": ${items.length} Ergebnisse`);
    res.json(items);
  } catch (err) {
    console.error('BGG Suche Fehler:', err.message);
    res.json([]);
  }
});

// BGG Details abrufen (Server-side mit Caching)
app.get('/api/bgg/details/:id', async (req, res) => {
  const { id } = req.params;
  
  if (!BGG_API_TOKEN) {
    return res.status(503).json({ error: 'BGG API nicht konfiguriert' });
  }
  
  try {
    // WICHTIG: boardgamegeek.com OHNE www
    const detailUrl = `https://boardgamegeek.com/xmlapi2/thing?id=${id}`;
    const xml = await getCachedOrFetch(detailUrl);
    
    const nameMatch = xml.match(/<name type="primary".*?value="([^"]+)"/);
    const yearMatch = xml.match(/<yearpublished.*?value="(\d+)"/);
    const minPlayersMatch = xml.match(/<minplayers.*?value="(\d+)"/);
    const maxPlayersMatch = xml.match(/<maxplayers.*?value="(\d+)"/);
    const playtimeMatch = xml.match(/<playingtime.*?value="(\d+)"/);
    const thumbnailMatch = xml.match(/<thumbnail>([^<]+)<\/thumbnail>/);
    const imageMatch = xml.match(/<image>([^<]+)<\/image>/);
    
    const result = {
      bggId: parseInt(id),
      name: nameMatch ? nameMatch[1] : 'Unbekannt',
      year: yearMatch ? parseInt(yearMatch[1]) : null,
      minPlayers: minPlayersMatch ? parseInt(minPlayersMatch[1]) : null,
      maxPlayers: maxPlayersMatch ? parseInt(maxPlayersMatch[1]) : null,
      playtime: playtimeMatch ? playtimeMatch[1] : null,
      thumbnail: thumbnailMatch ? thumbnailMatch[1] : null,
      image: imageMatch ? imageMatch[1] : null
    };
    
    console.log(`BGG Details für ${id}: ${result.name}`);
    res.json(result);
  } catch (err) {
    console.error('BGG Details Fehler:', err.message);
    res.status(500).json({ error: 'BGG Fehler' });
  }
});

// Alle Spiele laden (für aktuelles Event)
app.get('/api/games', async (req, res) => {
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  try {
    const result = await pool.query('SELECT * FROM games WHERE event_id = $1 ORDER BY created_at DESC', [req.eventId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler beim Laden der Spiele:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Spiel hinzufügen (mit BGG Daten)
app.post('/api/games', async (req, res) => {
  const { gameName, personName, type, bggId, bggThumbnail, bggImage, bggYear, bggMinPlayers, bggMaxPlayers, bggPlaytime, bggDescription } = req.body;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  if (!gameName?.trim() || !personName?.trim()) {
    return res.status(400).json({ error: 'Spielname und Name sind erforderlich' });
  }
  
  if (!['bring', 'wish'].includes(type)) {
    return res.status(400).json({ error: 'Ungültiger Typ' });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO games (event_id, game_name, person_name, type, bgg_id, bgg_thumbnail, bgg_image, bgg_year, bgg_min_players, bgg_max_players, bgg_playtime, bgg_description) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [req.eventId, gameName.trim(), personName.trim(), type, bggId || null, bggThumbnail || null, bggImage || null, bggYear || null, bggMinPlayers || null, bggMaxPlayers || null, bggPlaytime || null, bggDescription || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler beim Hinzufügen:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Spiel löschen
app.delete('/api/games/:id', async (req, res) => {
  const { id } = req.params;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  try {
    await pool.query('DELETE FROM games WHERE id = $1 AND event_id = $2', [id, req.eventId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler beim Löschen:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Wunsch erfüllen
app.post('/api/games/:id/fulfill', async (req, res) => {
  const { id } = req.params;
  const { fulfilledBy } = req.body;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  if (!fulfilledBy?.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }
  
  try {
    const result = await pool.query(
      'UPDATE games SET fulfilled_by = $1 WHERE id = $2 AND event_id = $3 AND type = $4 RETURNING *',
      [fulfilledBy.trim(), id, req.eventId, 'wish']
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Erfüllung zurücknehmen
app.delete('/api/games/:id/fulfill', async (req, res) => {
  const { id } = req.params;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  try {
    await pool.query('UPDATE games SET fulfilled_by = NULL WHERE id = $1 AND event_id = $2', [id, req.eventId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==================== SPIELESAMMLUNG (PERSISTENT) ====================

// Spielesammlung eines Nutzers laden
app.get('/api/collection/:ownerName', async (req, res) => {
  const { ownerName } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM game_collections WHERE LOWER(owner_name) = LOWER($1) ORDER BY game_name ASC',
      [ownerName]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler beim Laden der Sammlung:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Alle Sammlungen laden (für Übersicht)
app.get('/api/collections', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT owner_name, COUNT(*) as game_count 
      FROM game_collections 
      GROUP BY owner_name 
      ORDER BY owner_name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Spiel zur Sammlung hinzufügen
app.post('/api/collection', async (req, res) => {
  const { ownerName, bggId, gameName, bggThumbnail, bggImage, bggYear, bggMinPlayers, bggMaxPlayers, bggPlaytime } = req.body;
  
  if (!ownerName?.trim() || !bggId || !gameName?.trim()) {
    return res.status(400).json({ error: 'ownerName, bggId und gameName sind erforderlich' });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO game_collections (owner_name, bgg_id, game_name, bgg_thumbnail, bgg_image, bgg_year, bgg_min_players, bgg_max_players, bgg_playtime) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
       ON CONFLICT (owner_name, bgg_id) DO NOTHING
       RETURNING *`,
      [ownerName.trim(), bggId, gameName.trim(), bggThumbnail || null, bggImage || null, bggYear || null, bggMinPlayers || null, bggMaxPlayers || null, bggPlaytime || null]
    );
    res.json(result.rows[0] || { exists: true });
  } catch (err) {
    console.error('Fehler beim Hinzufügen zur Sammlung:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Spiel aus Sammlung entfernen
app.delete('/api/collection/:ownerName/:bggId', async (req, res) => {
  const { ownerName, bggId } = req.params;
  try {
    await pool.query(
      'DELETE FROM game_collections WHERE LOWER(owner_name) = LOWER($1) AND bgg_id = $2',
      [ownerName, bggId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler beim Entfernen aus Sammlung:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Spiel aus Sammlung zum Event hinzufügen
app.post('/api/collection/bring', async (req, res) => {
  const { ownerName, bggId } = req.body;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  if (!ownerName?.trim() || !bggId) {
    return res.status(400).json({ error: 'ownerName und bggId sind erforderlich' });
  }
  
  try {
    // Spiel aus Sammlung holen
    const collectionResult = await pool.query(
      'SELECT * FROM game_collections WHERE LOWER(owner_name) = LOWER($1) AND bgg_id = $2',
      [ownerName, bggId]
    );
    
    if (collectionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Spiel nicht in Sammlung gefunden' });
    }
    
    const game = collectionResult.rows[0];
    
    // Zum Event hinzufügen
    const result = await pool.query(
      `INSERT INTO games (event_id, game_name, person_name, type, bgg_id, bgg_thumbnail, bgg_image, bgg_year, bgg_min_players, bgg_max_players, bgg_playtime) 
       VALUES ($1, $2, $3, 'bring', $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.eventId, game.game_name, ownerName.trim(), game.bgg_id, game.bgg_thumbnail, game.bgg_image, game.bgg_year, game.bgg_min_players, game.bgg_max_players, game.bgg_playtime]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Fallback für SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server starten (initDB MUSS vor Listen laufen)
async function startServer() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`🚀 Server läuft auf Port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Server konnte nicht gestartet werden:', err.message);
    process.exit(1);
  }
}

startServer();
