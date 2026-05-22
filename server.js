const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const cookieParser = require('cookie-parser');

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
app.use(cookieParser()); // Cookie-Parser Middleware
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
    await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS bgg_min_age INTEGER DEFAULT NULL`);

    // "Ich spiel mit" - Interesse an Spielen bekunden
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_interests (
        id SERIAL PRIMARY KEY,
        game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
        person_name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(game_id, person_name)
      )
    `);

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

    // ==================== ESSENSPLANUNG ====================
    
    // Mahlzeiten pro Event (z.B. "Mittwoch Abend", "Donnerstag Mittag")
    await client.query(`
      CREATE TABLE IF NOT EXISTS meals (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        meal_date DATE NOT NULL,
        meal_time TIME NOT NULL,
        description TEXT DEFAULT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Gerichte pro Mahlzeit (z.B. "Chili con Carne", "Chili sin Carne")
    await client.query(`
      CREATE TABLE IF NOT EXISTS dishes (
        id SERIAL PRIMARY KEY,
        meal_id INTEGER REFERENCES meals(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        description TEXT DEFAULT NULL,
        diet_type VARCHAR(50) DEFAULT NULL,
        allergies VARCHAR(200) DEFAULT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Gerichte-Auswahl pro Person
    await client.query(`
      CREATE TABLE IF NOT EXISTS meal_selections (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        dish_id INTEGER REFERENCES dishes(id) ON DELETE CASCADE,
        person_name VARCHAR(100) NOT NULL,
        notes TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(dish_id, person_name)
      )
    `);
    
    // Migration: Kinderportion-Flag hinzufügen
    await client.query(`ALTER TABLE meal_selections ADD COLUMN IF NOT EXISTS is_child_portion BOOLEAN DEFAULT FALSE`);
    
    // ==================== MIGRATION: GRILL & FRÜHSTÜCK VEREINEN ====================
    // Füge meal_type zu meals hinzu
    await client.query(`ALTER TABLE meals ADD COLUMN IF NOT EXISTS meal_type VARCHAR(20) DEFAULT 'meal'`);
    
    // Erstelle meal_items Tabelle (für Grill & Frühstück)
    await client.query(`
      CREATE TABLE IF NOT EXISTS meal_items (
        id SERIAL PRIMARY KEY,
        meal_id INTEGER REFERENCES meals(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        item_type VARCHAR(100) DEFAULT NULL,
        unit VARCHAR(20) DEFAULT 'pieces',
        emoji VARCHAR(10) DEFAULT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Migration: emoji-Feld hinzufügen falls nicht vorhanden
    await client.query(`ALTER TABLE meal_items ADD COLUMN IF NOT EXISTS emoji VARCHAR(10) DEFAULT NULL`);
    
    // ==================== ITEM TEMPLATES (WIEDERVERWENDBARE LAYOUTS) ====================
    
    // Templates für Grill/Frühstück Items
    await client.query(`
      CREATE TABLE IF NOT EXISTS item_templates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        description TEXT DEFAULT NULL,
        template_type VARCHAR(20) NOT NULL CHECK (template_type IN ('grill', 'breakfast')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Items innerhalb eines Templates
    await client.query(`
      CREATE TABLE IF NOT EXISTS item_template_items (
        id SERIAL PRIMARY KEY,
        template_id INTEGER REFERENCES item_templates(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        item_type VARCHAR(100) DEFAULT NULL,
        unit VARCHAR(20) DEFAULT 'pieces',
        emoji VARCHAR(10) DEFAULT NULL,
        sort_order INTEGER DEFAULT 0
      )
    `);
    
    // Standard-Templates erstellen (nur beim ersten Start)
    const templateCheck = await client.query('SELECT COUNT(*) as count FROM item_templates');
    if (parseInt(templateCheck.rows[0].count) === 0) {
      console.log('🎉 Erstelle Standard-Templates...');
      
      // Grill-Standard Template
      const grillTemplate = await client.query(
        `INSERT INTO item_templates (name, description, template_type)
         VALUES ($1, $2, $3) RETURNING *`,
        ['Grill-Standard', 'Standard-Layout für Grill-Events', 'grill']
      );
      const grillId = grillTemplate.rows[0].id;
      
      const grillItems = [
        { name: 'Nürnberger Würstchen', item_type: 'Fleisch', unit: 'pieces', emoji: '🌭', sort_order: 1 },
        { name: 'Thüringer Würstchen Grob', item_type: 'Fleisch', unit: 'pieces', emoji: '🌭', sort_order: 2 },
        { name: 'Thüringer Würstchen Fein', item_type: 'Fleisch', unit: 'pieces', emoji: '🌭', sort_order: 3 },
        { name: 'Schweinenackensteak', item_type: 'Fleisch', unit: 'pieces', emoji: '🥩', sort_order: 4 },
        { name: 'Hähnchenbrust', item_type: 'Fleisch', unit: 'pieces', emoji: '🍗', sort_order: 5 },
        { name: 'Grillfackel', item_type: 'Fleisch', unit: 'pieces', emoji: '🔥', sort_order: 6 },
        { name: 'Hähnchenflügel', item_type: 'Fleisch', unit: 'pieces', emoji: '🍗', sort_order: 7 },
        { name: 'Hähnchenkeule', item_type: 'Fleisch', unit: 'pieces', emoji: '🍗', sort_order: 8 },
        { name: 'Grillkäse', item_type: 'Vegetarisch', unit: 'pieces', emoji: '🧀', sort_order: 9 },
        { name: 'Würstchen vegan', item_type: 'Vegan', unit: 'pieces', emoji: '🌭', sort_order: 10 },
        { name: 'Grillgemüse', item_type: 'Gemüse', unit: 'kg', emoji: '🌽', sort_order: 11 },
        { name: 'Nudelsalat', item_type: 'Beilage', unit: 'boolean', emoji: '🍝', sort_order: 12 },
        { name: 'Kartoffelsalat', item_type: 'Beilage', unit: 'boolean', emoji: '🥔', sort_order: 13 },
        { name: 'Baguette Knoblauch', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 14 },
        { name: 'Baguette Kräuter', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 15 },
        { name: 'Ketchup', item_type: 'Saucen', unit: 'ml', emoji: '🥫', sort_order: 16 },
        { name: 'Senf', item_type: 'Saucen', unit: 'ml', emoji: '🥫', sort_order: 17 },
        { name: 'Grillkohle', item_type: 'Sonstiges', unit: 'kg', emoji: '🪵', sort_order: 18 },
        { name: 'Grillanzünder', item_type: 'Sonstiges', unit: 'pieces', emoji: '🔥', sort_order: 19 }
      ];
      
      for (const item of grillItems) {
        await client.query(
          `INSERT INTO item_template_items (template_id, name, item_type, unit, emoji, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [grillId, item.name, item.item_type, item.unit, item.emoji, item.sort_order]
        );
      }
      
      // Frühstück-Standard Template
      const breakfastTemplate = await client.query(
        `INSERT INTO item_templates (name, description, template_type)
         VALUES ($1, $2, $3) RETURNING *`,
        ['Frühstück-Standard', 'Standard-Layout für Frühstück', 'breakfast']
      );
      const breakfastId = breakfastTemplate.rows[0].id;
      
      const breakfastItems = [
        { name: 'Brötchen', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 1 },
        { name: 'Brötchen Mehrkorn', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 2 },
        { name: 'Wurst Normal', item_type: 'Wurst & Käse', unit: 'g', emoji: '🥓', sort_order: 3 },
        { name: 'Wurst Vegan', item_type: 'Wurst & Käse', unit: 'g', emoji: '🥓', sort_order: 4 },
        { name: 'Käse Normal', item_type: 'Wurst & Käse', unit: 'g', emoji: '🧀', sort_order: 5 },
        { name: 'Käse Vegan', item_type: 'Wurst & Käse', unit: 'g', emoji: '🧀', sort_order: 6 },
        { name: 'Müsli', item_type: 'Sonstiges', unit: 'g', emoji: '🥣', sort_order: 7 },
        { name: 'Yoghurt', item_type: 'Sonstiges', unit: 'g', emoji: '🥛', sort_order: 8 },
        { name: 'Milch', item_type: 'Getränke', unit: 'l', emoji: '🥛', sort_order: 9 },
        { name: 'Haferdrink', item_type: 'Getränke', unit: 'l', emoji: '🥛', sort_order: 10 },
        { name: 'Nutella', item_type: 'Aufstriche', unit: 'g', emoji: '🍫', sort_order: 11 },
        { name: 'Hummus', item_type: 'Aufstriche', unit: 'g', emoji: '🫘', sort_order: 12 },
        { name: 'Vegiaufstrich', item_type: 'Aufstriche', unit: 'g', emoji: '🥬', sort_order: 13 },
        { name: 'Rührei ala Tim ohne Speck', item_type: 'Sonstiges', unit: 'boolean', emoji: '🍳', sort_order: 14 },
        { name: 'Rührei ala Tim mit Speck', item_type: 'Sonstiges', unit: 'boolean', emoji: '🍳', sort_order: 15 },
        { name: 'Marmelade Erdbeere', item_type: 'Aufstriche', unit: 'g', emoji: '🍓', sort_order: 16 },
        { name: 'Marmelade Aprikose', item_type: 'Aufstriche', unit: 'g', emoji: '🍑', sort_order: 17 },
        { name: 'Marmelade Pfirsich', item_type: 'Aufstriche', unit: 'g', emoji: '🍑', sort_order: 18 },
        { name: 'Marmelade Himbeere', item_type: 'Aufstriche', unit: 'g', emoji: '🫐', sort_order: 19 },
        { name: 'Kaffee', item_type: 'Getränke', unit: 'l', emoji: '☕', sort_order: 20 },
        { name: 'Tee', item_type: 'Getränke', unit: 'l', emoji: '🍵', sort_order: 21 },
        { name: 'Orangensaft', item_type: 'Getränke', unit: 'l', emoji: '🧃', sort_order: 22 },
        { name: 'Sonstiges', item_type: 'Sonstiges', unit: 'pieces', emoji: '📦', sort_order: 23 }
      ];
      
      for (const item of breakfastItems) {
        await client.query(
          `INSERT INTO item_template_items (template_id, name, item_type, unit, emoji, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [breakfastId, item.name, item.item_type, item.unit, item.emoji, item.sort_order]
        );
      }
      
      console.log('✅ Standard-Templates erstellt!');
    }
    
    // ==================== MIGRATION: DEUTSCHE TEMPLATES ====================
    // Prüfe ob alte Templates existieren (erkennbar an englischen item_type wie 'meat', 'bread')
    const oldTemplateCheck = await client.query(`
      SELECT COUNT(*) as count FROM item_template_items 
      WHERE item_type IN ('meat', 'bread', 'spread', 'topping', 'vegetables', 'dairy', 'drinks', 'other', 'sides', 'sauce', 'supplies', 'vegetarian')
    `);
    
    if (parseInt(oldTemplateCheck.rows[0].count) > 0) {
      console.log('🔄 Alte Templates gefunden, ersetze mit deutschen Templates...');
      
      // Lösche alle alten Templates
      await client.query('DELETE FROM item_templates');
      
      // Grill-Standard Template (NEU)
      const grillTemplate = await client.query(
        `INSERT INTO item_templates (name, description, template_type)
         VALUES ($1, $2, $3) RETURNING *`,
        ['Grill-Standard', 'Standard-Layout für Grill-Events', 'grill']
      );
      const grillId = grillTemplate.rows[0].id;
      
      const grillItems = [
        { name: 'Nürnberger Würstchen', item_type: 'Fleisch', unit: 'pieces', emoji: '🌭', sort_order: 1 },
        { name: 'Thüringer Würstchen Grob', item_type: 'Fleisch', unit: 'pieces', emoji: '🌭', sort_order: 2 },
        { name: 'Thüringer Würstchen Fein', item_type: 'Fleisch', unit: 'pieces', emoji: '🌭', sort_order: 3 },
        { name: 'Schweinenackensteak', item_type: 'Fleisch', unit: 'pieces', emoji: '🥩', sort_order: 4 },
        { name: 'Hähnchenbrust', item_type: 'Fleisch', unit: 'pieces', emoji: '🍗', sort_order: 5 },
        { name: 'Grillfackel', item_type: 'Fleisch', unit: 'pieces', emoji: '🔥', sort_order: 6 },
        { name: 'Hähnchenflügel', item_type: 'Fleisch', unit: 'pieces', emoji: '🍗', sort_order: 7 },
        { name: 'Hähnchenkeule', item_type: 'Fleisch', unit: 'pieces', emoji: '🍗', sort_order: 8 },
        { name: 'Grillkäse', item_type: 'Vegetarisch', unit: 'pieces', emoji: '🧀', sort_order: 9 },
        { name: 'Würstchen vegan', item_type: 'Vegan', unit: 'pieces', emoji: '🌭', sort_order: 10 },
        { name: 'Grillgemüse', item_type: 'Gemüse', unit: 'kg', emoji: '🌽', sort_order: 11 },
        { name: 'Nudelsalat', item_type: 'Beilage', unit: 'boolean', emoji: '🍝', sort_order: 12 },
        { name: 'Kartoffelsalat', item_type: 'Beilage', unit: 'boolean', emoji: '🥔', sort_order: 13 },
        { name: 'Baguette Knoblauch', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 14 },
        { name: 'Baguette Kräuter', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 15 },
        { name: 'Ketchup', item_type: 'Saucen', unit: 'ml', emoji: '🥫', sort_order: 16 },
        { name: 'Senf', item_type: 'Saucen', unit: 'ml', emoji: '🥫', sort_order: 17 },
        { name: 'Grillkohle', item_type: 'Sonstiges', unit: 'kg', emoji: '🪵', sort_order: 18 },
        { name: 'Grillanzünder', item_type: 'Sonstiges', unit: 'pieces', emoji: '🔥', sort_order: 19 }
      ];
      
      for (const item of grillItems) {
        await client.query(
          `INSERT INTO item_template_items (template_id, name, item_type, unit, emoji, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [grillId, item.name, item.item_type, item.unit, item.emoji, item.sort_order]
        );
      }
      
      // Frühstück-Standard Template (NEU)
      const breakfastTemplate = await client.query(
        `INSERT INTO item_templates (name, description, template_type)
         VALUES ($1, $2, $3) RETURNING *`,
        ['Frühstück-Standard', 'Standard-Layout für Frühstück', 'breakfast']
      );
      const breakfastId = breakfastTemplate.rows[0].id;
      
      const breakfastItems = [
        { name: 'Brötchen', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 1 },
        { name: 'Brötchen Mehrkorn', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 2 },
        { name: 'Wurst Normal', item_type: 'Wurst & Käse', unit: 'g', emoji: '🥓', sort_order: 3 },
        { name: 'Wurst Vegan', item_type: 'Wurst & Käse', unit: 'g', emoji: '🥓', sort_order: 4 },
        { name: 'Käse Normal', item_type: 'Wurst & Käse', unit: 'g', emoji: '🧀', sort_order: 5 },
        { name: 'Käse Vegan', item_type: 'Wurst & Käse', unit: 'g', emoji: '🧀', sort_order: 6 },
        { name: 'Müsli', item_type: 'Sonstiges', unit: 'g', emoji: '🥣', sort_order: 7 },
        { name: 'Yoghurt', item_type: 'Sonstiges', unit: 'g', emoji: '🥛', sort_order: 8 },
        { name: 'Milch', item_type: 'Getränke', unit: 'l', emoji: '🥛', sort_order: 9 },
        { name: 'Haferdrink', item_type: 'Getränke', unit: 'l', emoji: '🥛', sort_order: 10 },
        { name: 'Nutella', item_type: 'Aufstriche', unit: 'g', emoji: '🍫', sort_order: 11 },
        { name: 'Hummus', item_type: 'Aufstriche', unit: 'g', emoji: '🫘', sort_order: 12 },
        { name: 'Vegiaufstrich', item_type: 'Aufstriche', unit: 'g', emoji: '🥬', sort_order: 13 },
        { name: 'Rührei ala Tim ohne Speck', item_type: 'Sonstiges', unit: 'boolean', emoji: '🍳', sort_order: 14 },
        { name: 'Rührei ala Tim mit Speck', item_type: 'Sonstiges', unit: 'boolean', emoji: '🍳', sort_order: 15 },
        { name: 'Marmelade Erdbeere', item_type: 'Aufstriche', unit: 'g', emoji: '🍓', sort_order: 16 },
        { name: 'Marmelade Aprikose', item_type: 'Aufstriche', unit: 'g', emoji: '🍑', sort_order: 17 },
        { name: 'Marmelade Pfirsich', item_type: 'Aufstriche', unit: 'g', emoji: '🍑', sort_order: 18 },
        { name: 'Marmelade Himbeere', item_type: 'Aufstriche', unit: 'g', emoji: '🫐', sort_order: 19 },
        { name: 'Kaffee', item_type: 'Getränke', unit: 'l', emoji: '☕', sort_order: 20 },
        { name: 'Tee', item_type: 'Getränke', unit: 'l', emoji: '🍵', sort_order: 21 },
        { name: 'Orangensaft', item_type: 'Getränke', unit: 'l', emoji: '🧃', sort_order: 22 },
        { name: 'Sonstiges', item_type: 'Sonstiges', unit: 'pieces', emoji: '📦', sort_order: 23 }
      ];
      
      for (const item of breakfastItems) {
        await client.query(
          `INSERT INTO item_template_items (template_id, name, item_type, unit, emoji, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [breakfastId, item.name, item.item_type, item.unit, item.emoji, item.sort_order]
        );
      }
      
      console.log('✅ Deutsche Templates eingefügt!');
    }
    
    // Erstelle meal_item_selections Tabelle (Mengenauswahl)
    await client.query(`
      CREATE TABLE IF NOT EXISTS meal_item_selections (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        meal_item_id INTEGER REFERENCES meal_items(id) ON DELETE CASCADE,
        person_name VARCHAR(100) NOT NULL,
        quantity NUMERIC(10,2) DEFAULT 0,
        notes TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(meal_item_id, person_name)
      )
    `);
    
    // Migriere grill_events zu meals (meal_type='grill')
    const grillEventsExist = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'grill_events'
      )
    `);
    
    if (grillEventsExist.rows[0].exists) {
      // Kopiere grill_events zu meals
      await client.query(`
        INSERT INTO meals (event_id, name, meal_date, meal_time, description, sort_order, meal_type)
        SELECT event_id, title, grill_date, grill_time, description, sort_order, 'grill'
        FROM grill_events
        WHERE NOT EXISTS (
          SELECT 1 FROM meals m 
          WHERE m.name = grill_events.title 
          AND m.meal_date = grill_events.grill_date 
          AND m.meal_type = 'grill'
        )
      `);
      
      // Migriere grill_items zu meal_items
      await client.query(`
        INSERT INTO meal_items (meal_id, name, item_type, unit, sort_order)
        SELECT 
          m.id,
          gi.name,
          gi.item_type,
          gi.unit,
          gi.sort_order
        FROM grill_items gi
        JOIN grill_events ge ON gi.grill_event_id = ge.id
        JOIN meals m ON m.name = ge.title AND m.meal_date = ge.grill_date AND m.meal_type = 'grill'
        WHERE NOT EXISTS (
          SELECT 1 FROM meal_items mi
          WHERE mi.meal_id = m.id AND mi.name = gi.name
        )
      `);
      
      // Migriere grill_selections zu meal_item_selections
      await client.query(`
        INSERT INTO meal_item_selections (event_id, meal_item_id, person_name, quantity, notes)
        SELECT 
          ge.event_id,
          mi.id,
          gs.person_name,
          gs.quantity,
          gs.notes
        FROM grill_selections gs
        JOIN grill_items gi ON gs.grill_item_id = gi.id
        JOIN grill_events ge ON gi.grill_event_id = ge.id
        JOIN meals m ON m.name = ge.title AND m.meal_date = ge.grill_date AND m.meal_type = 'grill'
        JOIN meal_items mi ON mi.meal_id = m.id AND mi.name = gi.name
        WHERE NOT EXISTS (
          SELECT 1 FROM meal_item_selections mis
          WHERE mis.meal_item_id = mi.id AND mis.person_name = gs.person_name
        )
      `);
      
      // Lösche alte Grill-Tabellen
      await client.query(`DROP TABLE IF EXISTS grill_selections CASCADE`);
      await client.query(`DROP TABLE IF EXISTS grill_items CASCADE`);
      await client.query(`DROP TABLE IF EXISTS grill_events CASCADE`);
    }
    
    // Migriere breakfast_events zu meals (meal_type='breakfast')
    const breakfastEventsExist = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'breakfast_events'
      )
    `);
    
    if (breakfastEventsExist.rows[0].exists) {
      // Kopiere breakfast_events zu meals
      await client.query(`
        INSERT INTO meals (event_id, name, meal_date, meal_time, description, sort_order, meal_type)
        SELECT event_id, title, breakfast_date, breakfast_time, description, sort_order, 'breakfast'
        FROM breakfast_events
        WHERE NOT EXISTS (
          SELECT 1 FROM meals m 
          WHERE m.name = breakfast_events.title 
          AND m.meal_date = breakfast_events.breakfast_date 
          AND m.meal_type = 'breakfast'
        )
      `);
      
      // Migriere breakfast_items zu meal_items
      await client.query(`
        INSERT INTO meal_items (meal_id, name, item_type, unit, sort_order)
        SELECT 
          m.id,
          bi.name,
          bi.item_type,
          bi.unit,
          bi.sort_order
        FROM breakfast_items bi
        JOIN breakfast_events be ON bi.breakfast_event_id = be.id
        JOIN meals m ON m.name = be.title AND m.meal_date = be.breakfast_date AND m.meal_type = 'breakfast'
        WHERE NOT EXISTS (
          SELECT 1 FROM meal_items mi
          WHERE mi.meal_id = m.id AND mi.name = bi.name
        )
      `);
      
      // Migriere breakfast_selections zu meal_item_selections
      await client.query(`
        INSERT INTO meal_item_selections (event_id, meal_item_id, person_name, quantity, notes)
        SELECT 
          be.event_id,
          mi.id,
          bs.person_name,
          bs.quantity,
          bs.notes
        FROM breakfast_selections bs
        JOIN breakfast_items bi ON bs.breakfast_item_id = bi.id
        JOIN breakfast_events be ON bi.breakfast_event_id = be.id
        JOIN meals m ON m.name = be.title AND m.meal_date = be.breakfast_date AND m.meal_type = 'breakfast'
        JOIN meal_items mi ON mi.meal_id = m.id AND mi.name = bi.name
        WHERE NOT EXISTS (
          SELECT 1 FROM meal_item_selections mis
          WHERE mis.meal_item_id = mi.id AND mis.person_name = bs.person_name
        )
      `);
      
      // Lösche alte Frühstück-Tabellen
      await client.query(`DROP TABLE IF EXISTS breakfast_selections CASCADE`);
      await client.query(`DROP TABLE IF EXISTS breakfast_items CASCADE`);
      await client.query(`DROP TABLE IF EXISTS breakfast_events CASCADE`);
    }
    
    // ==================== GRILL-SYSTEM (ALT - WIRD MIGRIERT) ====================
    // Grill-Events pro Event (z.B. "Grillabend Samstag")
    await client.query(`
      CREATE TABLE IF NOT EXISTS grill_events (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        title VARCHAR(200) NOT NULL,
        grill_date DATE NOT NULL,
        grill_time TIME NOT NULL,
        description TEXT DEFAULT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Grill-Items pro Grill-Event (z.B. "Bratwurst", "Knoblauchbaguette")
    await client.query(`
      CREATE TABLE IF NOT EXISTS grill_items (
        id SERIAL PRIMARY KEY,
        grill_event_id INTEGER REFERENCES grill_events(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        item_type VARCHAR(50) DEFAULT 'meat',
        unit VARCHAR(20) DEFAULT 'pieces',
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Grill-Auswahl pro Person
    await client.query(`
      CREATE TABLE IF NOT EXISTS grill_selections (
        id SERIAL PRIMARY KEY,
        grill_event_id INTEGER REFERENCES grill_events(id) ON DELETE CASCADE,
        grill_item_id INTEGER REFERENCES grill_items(id) ON DELETE CASCADE,
        person_name VARCHAR(100) NOT NULL,
        quantity INTEGER DEFAULT 0,
        notes TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(grill_event_id, grill_item_id, person_name)
      )
    `);
    
    // ==================== FRÜHSTÜCK-SYSTEM ====================
    // Frühstück-Events pro Event (z.B. "Frühstück Samstag")
    await client.query(`
      CREATE TABLE IF NOT EXISTS breakfast_events (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        title VARCHAR(200) NOT NULL,
        breakfast_date DATE NOT NULL,
        breakfast_time TIME NOT NULL,
        description TEXT DEFAULT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Frühstück-Items pro Frühstück-Event (z.B. "Brötchen", "Joghurt")
    await client.query(`
      CREATE TABLE IF NOT EXISTS breakfast_items (
        id SERIAL PRIMARY KEY,
        breakfast_event_id INTEGER REFERENCES breakfast_events(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        item_type VARCHAR(50) DEFAULT 'bread',
        unit VARCHAR(20) DEFAULT 'pieces',
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Frühstück-Auswahl pro Person
    await client.query(`
      CREATE TABLE IF NOT EXISTS breakfast_selections (
        id SERIAL PRIMARY KEY,
        breakfast_event_id INTEGER REFERENCES breakfast_events(id) ON DELETE CASCADE,
        breakfast_item_id INTEGER REFERENCES breakfast_items(id) ON DELETE CASCADE,
        person_name VARCHAR(100) NOT NULL,
        quantity INTEGER DEFAULT 0,
        notes TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(breakfast_event_id, breakfast_item_id, person_name)
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
      
      // KEINE automatischen Zimmer mehr - Admin muss sie manuell anlegen!
      // Grund: Jedes Event hat unterschiedliche Locations mit unterschiedlichen Zimmern
      console.log(`✅ Event angelegt - Zimmer bitte im Admin-Panel anlegen`);
      
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
    
    // Zimmer-Migrations entfernt - jedes Event hat eigene Zimmer
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
  
  // Option 2: Session-Cookie (nach WordPress-Login)
  const sessionToken = req.cookies?.maitreffen_wp_token;
  if (sessionToken) {
    // Token ist gültig (kommt von unserem eigenen Callback)
    return next();
  }
  
  // Option 3: WordPress SSO Token validieren
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
    
    // Wenn WordPress-Login erfolgreich, setze Session-Cookie für diese Domain
    if (data.logged_in && data.token) {
      res.cookie('maitreffen_wp_token', data.token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 Stunden
      });
    }
    
    res.json(data);
  } catch (err) {
    console.error('WordPress SSO Fehler:', err.message);
    res.json({ logged_in: false, error: 'WordPress nicht erreichbar' });
  }
});

// Login-Redirect URL
app.get('/api/auth/login-url', (req, res) => {
  const returnUrl = req.query.return || req.headers.referer || '/';
  // Redirect zu WordPress mit Callback
  const callbackUrl = `https://herbsttreffen.brettspielfamilie.de/api/auth/callback?return=${encodeURIComponent(returnUrl)}`;
  const loginUrl = `https://brettspielfamilie.de/wp-login.php?redirect_to=${encodeURIComponent(callbackUrl)}`;
  res.json({ url: loginUrl });
});

// WordPress Login Callback - Setzt Session nach erfolgreichem Login
app.get('/api/auth/callback', async (req, res) => {
  const returnUrl = req.query.return || '/admin.html';
  const cookies = req.headers.cookie || '';
  
  try {
    // Prüfe WordPress-Login
    const wpRes = await fetch(WP_SSO_URL, {
      headers: { 'Cookie': cookies }
    });
    const data = await wpRes.json();
    
    if (data.logged_in && data.token) {
      // Setze Session-Cookie für diese Domain
      res.cookie('maitreffen_wp_token', data.token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
      });
      res.cookie('maitreffen_wp_user', JSON.stringify({
        id: data.id,
        name: data.display_name,
        email: data.email
      }), {
        httpOnly: false, // JS muss das lesen können
        secure: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
      });
    }
  } catch (err) {
    console.error('Callback Fehler:', err.message);
  }
  
  // Redirect zurück zur Admin-Seite
  res.redirect(returnUrl);
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

// ==================== ADMIN: ITEM TEMPLATES ====================

// Item-Vorlagen für Grill & Frühstück laden
app.get('/api/admin/item-templates', adminAuth, (req, res) => {
  const breakfastItems = [
    { name: 'Brötchen', itemType: 'bread', unit: 'pieces', sortOrder: 0 },
    { name: 'Toast', itemType: 'bread', unit: 'pieces', sortOrder: 1 },
    { name: 'Butter', itemType: 'spread', unit: 'g', sortOrder: 2 },
    { name: 'Marmelade', itemType: 'spread', unit: 'g', sortOrder: 3 },
    { name: 'Honig', itemType: 'spread', unit: 'g', sortOrder: 4 },
    { name: 'Nutella', itemType: 'spread', unit: 'g', sortOrder: 5 },
    { name: 'Käse', itemType: 'cold_cuts', unit: 'g', sortOrder: 6 },
    { name: 'Wurst', itemType: 'cold_cuts', unit: 'g', sortOrder: 7 },
    { name: 'Gurken', itemType: 'vegetables', unit: 'pieces', sortOrder: 8 },
    { name: 'Tomaten', itemType: 'vegetables', unit: 'pieces', sortOrder: 9 },
    { name: 'Paprika', itemType: 'vegetables', unit: 'pieces', sortOrder: 10 },
    { name: 'Eier', itemType: 'dairy', unit: 'pieces', sortOrder: 11 },
    { name: 'Müsli', itemType: 'cereals', unit: 'g', sortOrder: 12 },
    { name: 'Joghurt', itemType: 'dairy', unit: 'g', sortOrder: 13 },
    { name: 'Milch', itemType: 'dairy', unit: 'l', sortOrder: 14 },
    { name: 'Kaffee', itemType: 'drinks', unit: 'l', sortOrder: 15 },
    { name: 'Tee', itemType: 'drinks', unit: 'l', sortOrder: 16 },
    { name: 'Orangensaft', itemType: 'drinks', unit: 'l', sortOrder: 17 }
  ];

  const grillItems = [
    { name: 'Würstchen', itemType: 'meat', unit: 'pieces', sortOrder: 0 },
    { name: 'Bratwurst', itemType: 'meat', unit: 'pieces', sortOrder: 1 },
    { name: 'Steaks', itemType: 'meat', unit: 'pieces', sortOrder: 2 },
    { name: 'Hähnchen', itemType: 'meat', unit: 'pieces', sortOrder: 3 },
    { name: 'Grillkäse', itemType: 'vegetarian', unit: 'pieces', sortOrder: 4 },
    { name: 'Gemüsespieße', itemType: 'vegetarian', unit: 'pieces', sortOrder: 5 },
    { name: 'Folienkartoffeln', itemType: 'sides', unit: 'pieces', sortOrder: 6 },
    { name: 'Baguette', itemType: 'sides', unit: 'pieces', sortOrder: 7 },
    { name: 'Salat (gemischt)', itemType: 'salads', unit: 'g', sortOrder: 8 },
    { name: 'Gurkensalat', itemType: 'salads', unit: 'g', sortOrder: 9 },
    { name: 'Tomatensalat', itemType: 'salads', unit: 'g', sortOrder: 10 },
    { name: 'Ketchup', itemType: 'sauces', unit: 'ml', sortOrder: 11 },
    { name: 'Senf', itemType: 'sauces', unit: 'ml', sortOrder: 12 },
    { name: 'Mayo', itemType: 'sauces', unit: 'ml', sortOrder: 13 },
    { name: 'Grillsauce', itemType: 'sauces', unit: 'ml', sortOrder: 14 },
    { name: 'Bier', itemType: 'drinks', unit: 'l', sortOrder: 15 },
    { name: 'Limonade', itemType: 'drinks', unit: 'l', sortOrder: 16 },
    { name: 'Wasser', itemType: 'drinks', unit: 'l', sortOrder: 17 },
    { name: 'Grillkohle', itemType: 'supplies', unit: 'kg', sortOrder: 18 },
    { name: 'Grillanzünder', itemType: 'supplies', unit: 'pieces', sortOrder: 19 }
  ];

  res.json({ breakfast: breakfastItems, grill: grillItems });
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
// Holt auch Thumbnails per Batch-Request für bessere UX
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
    
    // XML Parsing - Sammle IDs
    const items = [];
    const itemMatches = xml.match(/<item.*?<\/item>/gs) || [];
    
    for (const item of itemMatches.slice(0, 10)) { // Nur Top 10 für Performance
      const idMatch = item.match(/id="(\d+)"/);
      const nameMatch = item.match(/<name.*?value="([^"]+)"/);
      const yearMatch = item.match(/<yearpublished.*?value="(\d+)"/);
      
      if (idMatch && nameMatch) {
        items.push({
          bggId: parseInt(idMatch[1]),
          name: nameMatch[1],
          year: yearMatch ? parseInt(yearMatch[1]) : null,
          thumbnail: null // Wird gleich geholt
        });
      }
    }
    
    // Batch-Request für Thumbnails (max 10 IDs gleichzeitig)
    if (items.length > 0) {
      const ids = items.map(i => i.bggId).join(',');
      const detailUrl = `https://boardgamegeek.com/xmlapi2/thing?id=${ids}`;
      
      try {
        const detailXml = await getCachedOrFetch(detailUrl);
        
        // Thumbnails aus Detail-Response extrahieren
        const detailItems = detailXml.match(/<item.*?<\/item>/gs) || [];
        
        for (const detailItem of detailItems) {
          const idMatch = detailItem.match(/id="(\d+)"/);
          const thumbnailMatch = detailItem.match(/<thumbnail>([^<]+)<\/thumbnail>/);
          
          if (idMatch && thumbnailMatch) {
            const itemId = parseInt(idMatch[1]);
            const item = items.find(i => i.bggId === itemId);
            if (item) {
              item.thumbnail = thumbnailMatch[1];
            }
          }
        }
      } catch (detailErr) {
        console.log('BGG Thumbnail-Batch Fehler (nicht kritisch):', detailErr.message);
        // Weiter ohne Thumbnails
      }
    }
    
    console.log(`BGG Suche "${query}": ${items.length} Ergebnisse (mit Thumbnails)`);
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
    const minAgeMatch = xml.match(/<minage.*?value="(\d+)"/);
    const thumbnailMatch = xml.match(/<thumbnail>([^<]+)<\/thumbnail>/);
    const imageMatch = xml.match(/<image>([^<]+)<\/image>/);
    
    const result = {
      bggId: parseInt(id),
      name: nameMatch ? nameMatch[1] : 'Unbekannt',
      year: yearMatch ? parseInt(yearMatch[1]) : null,
      minPlayers: minPlayersMatch ? parseInt(minPlayersMatch[1]) : null,
      maxPlayers: maxPlayersMatch ? parseInt(maxPlayersMatch[1]) : null,
      playtime: playtimeMatch ? playtimeMatch[1] : null,
      minAge: minAgeMatch ? parseInt(minAgeMatch[1]) : null,
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

// Alle Spiele laden (für aktuelles Event) - mit Interessen
app.get('/api/games', async (req, res) => {
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  try {
    // Spiele laden
    const gamesResult = await pool.query('SELECT * FROM games WHERE event_id = $1 ORDER BY created_at DESC', [req.eventId]);
    
    // Interessen laden (aggregiert pro Spiel)
    const interestsResult = await pool.query(`
      SELECT game_id, array_agg(person_name ORDER BY created_at) as interested_players
      FROM game_interests 
      WHERE game_id IN (SELECT id FROM games WHERE event_id = $1)
      GROUP BY game_id
    `, [req.eventId]);
    
    // Map für schnellen Lookup
    const interestsMap = {};
    interestsResult.rows.forEach(row => {
      interestsMap[row.game_id] = row.interested_players || [];
    });
    
    // Spiele mit Interessen anreichern
    const games = gamesResult.rows.map(game => ({
      ...game,
      interested_players: interestsMap[game.id] || []
    }));
    
    res.json(games);
  } catch (err) {
    console.error('Fehler beim Laden der Spiele:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Spiel hinzufügen (mit BGG Daten)
app.post('/api/games', async (req, res) => {
  const { gameName, personName, type, bggId, bggThumbnail, bggImage, bggYear, bggMinPlayers, bggMaxPlayers, bggPlaytime, bggMinAge, bggDescription } = req.body;
  
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
      `INSERT INTO games (event_id, game_name, person_name, type, bgg_id, bgg_thumbnail, bgg_image, bgg_year, bgg_min_players, bgg_max_players, bgg_playtime, bgg_min_age, bgg_description) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [req.eventId, gameName.trim(), personName.trim(), type, bggId || null, bggThumbnail || null, bggImage || null, bggYear || null, bggMinPlayers || null, bggMaxPlayers || null, bggPlaytime || null, bggMinAge || null, bggDescription || null]
    );
    res.json({ ...result.rows[0], interested_players: [] });
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

// Wunsch erfüllen (markiert Wunsch UND erstellt "bring" Eintrag)
app.post('/api/games/:id/fulfill', async (req, res) => {
  const { id } = req.params;
  const { fulfilledBy } = req.body;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  if (!fulfilledBy?.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Wunsch als erfüllt markieren
    const wishResult = await client.query(
      'UPDATE games SET fulfilled_by = $1 WHERE id = $2 AND event_id = $3 AND type = $4 RETURNING *',
      [fulfilledBy.trim(), id, req.eventId, 'wish']
    );
    
    if (wishResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wunsch nicht gefunden' });
    }
    
    const wish = wishResult.rows[0];
    
    // 2. "Bring" Eintrag erstellen (mit gleichen Spieldaten)
    const bringResult = await client.query(
      `INSERT INTO games (event_id, game_name, person_name, type, bgg_id, bgg_thumbnail, bgg_image, bgg_year, bgg_min_players, bgg_max_players, bgg_playtime, bgg_min_age, bgg_description, fulfilled_by) 
       VALUES ($1, $2, $3, 'bring', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [req.eventId, wish.game_name, fulfilledBy.trim(), wish.bgg_id, wish.bgg_thumbnail, wish.bgg_image, wish.bgg_year, wish.bgg_min_players, wish.bgg_max_players, wish.bgg_playtime, wish.bgg_min_age, wish.bgg_description, id] // fulfilled_by speichert ID des Wunsches für Rückverfolgung
    );
    
    await client.query('COMMIT');
    res.json({ wish: { ...wishResult.rows[0], interested_players: [] }, bring: { ...bringResult.rows[0], interested_players: [] } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  } finally {
    client.release();
  }
});

// Erfüllung zurücknehmen (entfernt fulfilled_by UND löscht "bring" Eintrag)
app.delete('/api/games/:id/fulfill', async (req, res) => {
  const { id } = req.params;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. "Bring" Eintrag löschen (der die Wunsch-ID als fulfilled_by hat)
    await client.query(
      "DELETE FROM games WHERE event_id = $1 AND type = 'bring' AND fulfilled_by = $2",
      [req.eventId, id.toString()]
    );
    
    // 2. Wunsch als nicht erfüllt markieren
    await client.query('UPDATE games SET fulfilled_by = NULL WHERE id = $1 AND event_id = $2', [id, req.eventId]);
    
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

// ==================== SPIEL-INTERESSEN ("Ich spiel mit") ====================

// Interesse an Spiel bekunden
app.post('/api/games/:id/interest', async (req, res) => {
  const { id } = req.params;
  const { personName } = req.body;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  
  if (!personName?.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }
  
  try {
    // Prüfe ob Spiel zum Event gehört
    const gameCheck = await pool.query('SELECT id FROM games WHERE id = $1 AND event_id = $2', [id, req.eventId]);
    if (gameCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Spiel nicht gefunden' });
    }
    
    await pool.query(
      `INSERT INTO game_interests (game_id, person_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, personName.trim()]
    );
    
    // Aktualisierte Liste zurückgeben
    const interests = await pool.query(
      'SELECT person_name FROM game_interests WHERE game_id = $1 ORDER BY created_at',
      [id]
    );
    
    res.json({ interested_players: interests.rows.map(r => r.person_name) });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Interesse zurücknehmen
app.delete('/api/games/:id/interest', async (req, res) => {
  const { id } = req.params;
  const { personName } = req.body;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  
  if (!personName?.trim()) {
    return res.status(400).json({ error: 'Name ist erforderlich' });
  }
  
  try {
    await pool.query(
      'DELETE FROM game_interests WHERE game_id = $1 AND person_name = $2',
      [id, personName.trim()]
    );
    
    // Aktualisierte Liste zurücknehmen
    const interests = await pool.query(
      'SELECT person_name FROM game_interests WHERE game_id = $1 ORDER BY created_at',
      [id]
    );
    
    res.json({ interested_players: interests.rows.map(r => r.person_name) });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==================== SPIELESAMMLUNG (PERSISTENT) ====================

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

// ==================== ESSENSPLANUNG API ====================

// ========== ADMIN: Mahlzeiten verwalten ==========

// Alle Mahlzeiten eines Events laden (mit Gerichten + Items)
app.get('/api/admin/events/:eventId/meals', adminAuth, async (req, res) => {
  const { eventId } = req.params;
  
  try {
    const mealsResult = await pool.query(
      'SELECT * FROM meals WHERE event_id = $1 ORDER BY meal_date, meal_time, sort_order',
      [eventId]
    );
    
    const dishesResult = await pool.query(`
      SELECT d.* FROM dishes d
      INNER JOIN meals m ON d.meal_id = m.id
      WHERE m.event_id = $1
      ORDER BY d.meal_id, d.sort_order
    `, [eventId]);
    
    const itemsResult = await pool.query(`
      SELECT mi.* FROM meal_items mi
      INNER JOIN meals m ON mi.meal_id = m.id
      WHERE m.event_id = $1
      ORDER BY mi.meal_id, mi.sort_order
    `, [eventId]);
    
    // Gerichte und Items den Mahlzeiten zuordnen
    const meals = mealsResult.rows.map(meal => ({
      ...meal,
      dishes: meal.meal_type === 'meal' ? dishesResult.rows.filter(d => d.meal_id === meal.id) : [],
      items: (meal.meal_type === 'grill' || meal.meal_type === 'breakfast') ? itemsResult.rows.filter(i => i.meal_id === meal.id) : []
    }));
    
    res.json(meals);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Mahlzeit erstellen
app.post('/api/admin/meals', adminAuth, async (req, res) => {
  const { eventId, name, mealDate, mealTime, description, sortOrder, mealType } = req.body;
  
  if (!eventId || !name?.trim() || !mealDate || !mealTime) {
    return res.status(400).json({ error: 'eventId, name, mealDate und mealTime sind erforderlich' });
  }
  
  const validTypes = ['meal', 'grill', 'breakfast'];
  const type = validTypes.includes(mealType) ? mealType : 'meal';
  
  try {
    const result = await pool.query(
      `INSERT INTO meals (event_id, name, meal_date, meal_time, description, sort_order, meal_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [eventId, name.trim(), mealDate, mealTime, description || null, sortOrder || 0, type]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Mahlzeit bearbeiten
app.put('/api/admin/meals/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { name, mealDate, mealTime, description, sortOrder, mealType } = req.body;
  
  const validTypes = ['meal', 'grill', 'breakfast'];
  const type = validTypes.includes(mealType) ? mealType : 'meal';
  
  try {
    const result = await pool.query(
      `UPDATE meals SET name = $1, meal_date = $2, meal_time = $3, description = $4, sort_order = $5, meal_type = $6
       WHERE id = $7 RETURNING *`,
      [name, mealDate, mealTime, description || null, sortOrder || 0, type, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Mahlzeit löschen
app.delete('/api/admin/meals/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query('DELETE FROM meals WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Mahlzeiten automatisch generieren basierend auf Event-Daten
app.post('/api/admin/events/:eventId/meals/generate', adminAuth, async (req, res) => {
  const { eventId } = req.params;
  
  try {
    // Event-Daten laden
    const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Event nicht gefunden' });
    }
    
    const event = eventResult.rows[0];
    const startDate = new Date(event.start_date);
    const endDate = new Date(event.end_date);
    
    // Prüfe ob bereits Mahlzeiten existieren
    const existingMeals = await pool.query('SELECT COUNT(*) as count FROM meals WHERE event_id = $1', [eventId]);
    if (parseInt(existingMeals.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Mahlzeiten existieren bereits für dieses Event' });
    }
    
    const mealsToCreate = [];
    let sortOrder = 0;
    
    // Alle Tage durchgehen
    for (let date = new Date(startDate); date <= endDate; date.setDate(date.getDate() + 1)) {
      const dateStr = date.toISOString().split('T')[0];
      const isFirstDay = date.getTime() === startDate.getTime();
      const isLastDay = date.getTime() === endDate.getTime();
      
      // Frühstück (außer am ersten Tag)
      if (!isFirstDay) {
        mealsToCreate.push({
          name: 'Frühstück',
          date: dateStr,
          time: '09:00',
          description: null,
          mealType: 'breakfast',  // 🥐 Frühstück ist immer breakfast
          sortOrder: sortOrder++
        });
      }
      
      // Abendessen (außer am letzten Tag)
      if (!isLastDay) {
        mealsToCreate.push({
          name: 'Abendessen',
          date: dateStr,
          time: '19:00',
          description: null,
          mealType: 'meal',  // 🍽️ Abendessen ist erstmal 'meal', kann später zu 'grill' geändert werden
          sortOrder: sortOrder++
        });
      }
    }
    
    // Mahlzeiten in DB einfügen
    for (const meal of mealsToCreate) {
      await pool.query(
        `INSERT INTO meals (event_id, name, meal_date, meal_time, description, meal_type, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [eventId, meal.name, meal.date, meal.time, meal.description, meal.mealType, meal.sortOrder]
      );
    }
    
    res.json({ success: true, count: mealsToCreate.length });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ========== ADMIN: Gerichte verwalten ==========

// Gericht zu Mahlzeit hinzufügen
app.post('/api/admin/meals/:mealId/dishes', adminAuth, async (req, res) => {
  const { mealId } = req.params;
  const { name, description, dietType, allergies, sortOrder } = req.body;
  
  if (!name?.trim()) {
    return res.status(400).json({ error: 'name ist erforderlich' });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO dishes (meal_id, name, description, diet_type, allergies, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [mealId, name.trim(), description || null, dietType || null, allergies || null, sortOrder || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Gericht bearbeiten
app.put('/api/admin/dishes/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { name, description, dietType, allergies, sortOrder } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE dishes SET name = $1, description = $2, diet_type = $3, allergies = $4, sort_order = $5
       WHERE id = $6 RETURNING *`,
      [name, description || null, dietType || null, allergies || null, sortOrder || 0, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Gericht löschen
app.delete('/api/admin/dishes/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query('DELETE FROM dishes WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ========== ADMIN: Einkaufsliste / Report ==========

// Einkaufsliste für Event generieren
app.get('/api/admin/events/:eventId/meals/report', adminAuth, async (req, res) => {
  const { eventId } = req.params;
  
  try {
    // Alle Mahlzeiten mit Gerichten und Auswahlen laden
    const result = await pool.query(`
      SELECT 
        m.id as meal_id,
        m.name as meal_name,
        m.meal_date,
        m.meal_time,
        d.id as dish_id,
        d.name as dish_name,
        d.diet_type,
        COUNT(ms.id) FILTER (WHERE ms.is_child_portion = false OR ms.is_child_portion IS NULL) as adult_count,
        COUNT(ms.id) FILTER (WHERE ms.is_child_portion = true) as child_count,
        array_agg(ms.person_name ORDER BY ms.person_name) FILTER (WHERE ms.is_child_portion = false OR ms.is_child_portion IS NULL) as adults,
        array_agg(ms.person_name ORDER BY ms.person_name) FILTER (WHERE ms.is_child_portion = true) as children
      FROM meals m
      LEFT JOIN dishes d ON d.meal_id = m.id
      LEFT JOIN meal_selections ms ON ms.dish_id = d.id
      WHERE m.event_id = $1
      GROUP BY m.id, m.name, m.meal_date, m.meal_time, d.id, d.name, d.diet_type
      ORDER BY m.meal_date, m.meal_time, d.sort_order
    `, [eventId]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ========== USER: Mahlzeiten ansehen ==========

// Alle Mahlzeiten für aktuelles Event (mit Gerichten + Items)
app.get('/api/meals', async (req, res) => {
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  
  try {
    const mealsResult = await pool.query(
      'SELECT * FROM meals WHERE event_id = $1 ORDER BY meal_date, meal_time, sort_order',
      [req.eventId]
    );
    
    const dishesResult = await pool.query(`
      SELECT d.* FROM dishes d
      INNER JOIN meals m ON d.meal_id = m.id
      WHERE m.event_id = $1
      ORDER BY d.meal_id, d.sort_order
    `, [req.eventId]);
    
    const itemsResult = await pool.query(`
      SELECT mi.* FROM meal_items mi
      INNER JOIN meals m ON mi.meal_id = m.id
      WHERE m.event_id = $1
      ORDER BY mi.meal_id, mi.sort_order
    `, [req.eventId]);
    
    // Gerichte und Items den Mahlzeiten zuordnen
    const meals = mealsResult.rows.map(meal => ({
      ...meal,
      dishes: meal.meal_type === 'meal' ? dishesResult.rows.filter(d => d.meal_id === meal.id) : [],
      items: (meal.meal_type === 'grill' || meal.meal_type === 'breakfast') ? itemsResult.rows.filter(i => i.meal_id === meal.id) : []
    }));
    
    res.json(meals);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ========== USER: Gerichte-Auswahl ==========

// Auswahl einer Person laden
app.get('/api/meals/selections/:personName', async (req, res) => {
  const { personName } = req.params;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  
  try {
    const result = await pool.query(
      'SELECT * FROM meal_selections WHERE event_id = $1 AND LOWER(person_name) = LOWER($2)',
      [req.eventId, personName]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Auswahl speichern (für eine Person)
app.post('/api/meals/selections', async (req, res) => {
  const { personName, selections } = req.body; // selections = [{ dishId, notes, isChildPortion }]
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  
  if (!personName?.trim() || !Array.isArray(selections)) {
    return res.status(400).json({ error: 'personName und selections sind erforderlich' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Alte Auswahlen löschen
    await client.query(
      'DELETE FROM meal_selections WHERE event_id = $1 AND LOWER(person_name) = LOWER($2)',
      [req.eventId, personName.trim()]
    );
    
    // Neue Auswahlen einfügen
    for (const selection of selections) {
      await client.query(
        `INSERT INTO meal_selections (event_id, dish_id, person_name, notes, is_child_portion)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.eventId, selection.dishId, personName.trim(), selection.notes || null, selection.isChildPortion || false]
      );
    }
    
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

// Essensauswahl löschen (für eine Person)
app.delete('/api/meals/selections/:personName', async (req, res) => {
  const { personName } = req.params;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  
  if (!personName?.trim()) {
    return res.status(400).json({ error: 'personName ist erforderlich' });
  }
  
  try {
    await pool.query(
      'DELETE FROM meal_selections WHERE event_id = $1 AND LOWER(person_name) = LOWER($2)',
      [req.eventId, personName.trim()]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ========== MEAL ITEM SELECTIONS (Grill & Frühstück mit Mengen) ==========

// User: Item-Auswahl speichern
app.post('/api/meals/item-selections', async (req, res) => {
  const { personName, itemSelections } = req.body; // itemSelections = [{ itemId, quantity, notes }]
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  
  if (!personName?.trim() || !Array.isArray(itemSelections)) {
    return res.status(400).json({ error: 'personName und itemSelections sind erforderlich' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Hole alle meal_item_ids für dieses Event
    const itemIdsResult = await client.query(
      `SELECT mi.id FROM meal_items mi
       JOIN meals m ON mi.meal_id = m.id
       WHERE m.event_id = $1`,
      [req.eventId]
    );
    const validItemIds = new Set(itemIdsResult.rows.map(row => row.id));
    
    // Lösche alte Auswahlen für diesen User bei diesem Event
    await client.query(
      `DELETE FROM meal_item_selections 
       WHERE event_id = $1 AND LOWER(person_name) = LOWER($2)`,
      [req.eventId, personName.trim()]
    );
    
    // Neue Auswahlen einfügen (nur wenn quantity > 0 und itemId valide)
    for (const selection of itemSelections) {
      if (selection.quantity > 0 && validItemIds.has(selection.itemId)) {
        await client.query(
          `INSERT INTO meal_item_selections (event_id, meal_item_id, person_name, quantity, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.eventId, selection.itemId, personName.trim(), selection.quantity, selection.notes || null]
        );
      }
    }
    
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

// User: Item-Auswahl für Person laden
app.get('/api/meals/item-selections/:personName', async (req, res) => {
  const { personName } = req.params;
  
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  
  try {
    const result = await pool.query(
      `SELECT mis.* FROM meal_item_selections mis
       WHERE mis.event_id = $1 AND LOWER(mis.person_name) = LOWER($2)`,
      [req.eventId, personName.trim()]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==================== ITEM TEMPLATES API ====================

// Mahlzeiten für ein Event laden (für Admin-UI)
app.get('/api/admin/events/:eventId/meals', adminAuth, async (req, res) => {
  const { eventId } = req.params;
  try {
    // Mahlzeiten laden
    const mealsResult = await pool.query(
      'SELECT * FROM meals WHERE event_id = $1 ORDER BY date, id',
      [eventId]
    );
    
    // Für jede Mahlzeit Items und Dishes laden
    const meals = [];
    for (const meal of mealsResult.rows) {
      const itemsResult = await pool.query(
        'SELECT * FROM meal_items WHERE meal_id = $1 ORDER BY sort_order',
        [meal.id]
      );
      
      const dishesResult = await pool.query(
        'SELECT * FROM meal_dishes WHERE meal_id = $1 ORDER BY id',
        [meal.id]
      );
      
      meals.push({
        ...meal,
        items: itemsResult.rows,
        dishes: dishesResult.rows
      });
    }
    
    res.json(meals);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Alle Templates laden
app.get('/api/admin/item-templates', adminAuth, async (req, res) => {
  try {
    const templatesResult = await pool.query(
      'SELECT * FROM item_templates ORDER BY template_type, name'
    );
    
    // Für jedes Template die Items laden
    const templates = [];
    for (const template of templatesResult.rows) {
      const itemsResult = await pool.query(
        'SELECT * FROM item_template_items WHERE template_id = $1 ORDER BY sort_order',
        [template.id]
      );
      templates.push({
        ...template,
        items: itemsResult.rows
      });
    }
    
    res.json(templates);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Template erstellen
app.post('/api/admin/item-templates', adminAuth, async (req, res) => {
  const { name, description, templateType, items } = req.body;
  
  if (!name?.trim() || !templateType || !['grill', 'breakfast'].includes(templateType)) {
    return res.status(400).json({ error: 'name und templateType sind erforderlich' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Template erstellen
    const templateResult = await client.query(
      `INSERT INTO item_templates (name, description, template_type)
       VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), description || null, templateType]
    );
    const templateId = templateResult.rows[0].id;
    
    // Items hinzufügen
    const itemsToReturn = [];
    if (items && Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemResult = await client.query(
          `INSERT INTO item_template_items (template_id, name, item_type, unit, emoji, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [templateId, item.name, item.itemType || null, item.unit || 'pieces', item.emoji || null, item.sortOrder || i]
        );
        itemsToReturn.push(itemResult.rows[0]);
      }
    }
    
    await client.query('COMMIT');
    res.json({ ...templateResult.rows[0], items: itemsToReturn });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  } finally {
    client.release();
  }
});

// Template bearbeiten
app.put('/api/admin/item-templates/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { name, description, templateType, items } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Template updaten
    const templateResult = await client.query(
      `UPDATE item_templates SET name = $1, description = $2, template_type = $3
       WHERE id = $4 RETURNING *`,
      [name, description || null, templateType, id]
    );
    
    if (templateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Template nicht gefunden' });
    }
    
    // Alte Items löschen
    await client.query('DELETE FROM item_template_items WHERE template_id = $1', [id]);
    
    // Neue Items hinzufügen
    const itemsToReturn = [];
    if (items && Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemResult = await client.query(
          `INSERT INTO item_template_items (template_id, name, item_type, unit, emoji, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [id, item.name, item.itemType || null, item.unit || 'pieces', item.emoji || null, item.sortOrder || i]
        );
        itemsToReturn.push(itemResult.rows[0]);
      }
    }
    
    await client.query('COMMIT');
    res.json({ ...templateResult.rows[0], items: itemsToReturn });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  } finally {
    client.release();
  }
});

// Template löschen
app.delete('/api/admin/item-templates/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM item_templates WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Templates zurücksetzen (auf deutsche Standardvorlagen)
app.post('/api/admin/item-templates/reset', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Lösche ALLE Templates
    await client.query('DELETE FROM item_templates');
    
    // Grill-Standard Template (NEU)
    const grillTemplate = await client.query(
      `INSERT INTO item_templates (name, description, template_type)
       VALUES ($1, $2, $3) RETURNING *`,
      ['Grill-Standard', 'Standard-Layout für Grill-Events', 'grill']
    );
    const grillId = grillTemplate.rows[0].id;
    
    const grillItems = [
      { name: 'Nürnberger Würstchen', item_type: 'Fleisch', unit: 'pieces', emoji: '🌭', sort_order: 1 },
      { name: 'Thüringer Würstchen Grob', item_type: 'Fleisch', unit: 'pieces', emoji: '🌭', sort_order: 2 },
      { name: 'Thüringer Würstchen Fein', item_type: 'Fleisch', unit: 'pieces', emoji: '🌭', sort_order: 3 },
      { name: 'Schweinenackensteak', item_type: 'Fleisch', unit: 'pieces', emoji: '🥩', sort_order: 4 },
      { name: 'Hähnchenbrust', item_type: 'Fleisch', unit: 'pieces', emoji: '🍗', sort_order: 5 },
      { name: 'Grillfackel', item_type: 'Fleisch', unit: 'pieces', emoji: '🔥', sort_order: 6 },
      { name: 'Hähnchenflügel', item_type: 'Fleisch', unit: 'pieces', emoji: '🍗', sort_order: 7 },
      { name: 'Hähnchenkeule', item_type: 'Fleisch', unit: 'pieces', emoji: '🍗', sort_order: 8 },
      { name: 'Grillkäse', item_type: 'Vegetarisch', unit: 'pieces', emoji: '🧀', sort_order: 9 },
      { name: 'Würstchen vegan', item_type: 'Vegan', unit: 'pieces', emoji: '🌭', sort_order: 10 },
      { name: 'Grillgemüse', item_type: 'Gemüse', unit: 'kg', emoji: '🌽', sort_order: 11 },
      { name: 'Nudelsalat', item_type: 'Beilage', unit: 'boolean', emoji: '🍝', sort_order: 12 },
      { name: 'Kartoffelsalat', item_type: 'Beilage', unit: 'boolean', emoji: '🥔', sort_order: 13 },
      { name: 'Baguette Knoblauch', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 14 },
      { name: 'Baguette Kräuter', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 15 },
      { name: 'Ketchup', item_type: 'Saucen', unit: 'ml', emoji: '🥫', sort_order: 16 },
      { name: 'Senf', item_type: 'Saucen', unit: 'ml', emoji: '🥫', sort_order: 17 },
      { name: 'Grillkohle', item_type: 'Sonstiges', unit: 'kg', emoji: '🪵', sort_order: 18 },
      { name: 'Grillanzünder', item_type: 'Sonstiges', unit: 'pieces', emoji: '🔥', sort_order: 19 }
    ];
    
    for (const item of grillItems) {
      await client.query(
        `INSERT INTO item_template_items (template_id, name, item_type, unit, emoji, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [grillId, item.name, item.item_type, item.unit, item.emoji, item.sort_order]
      );
    }
    
    // Frühstück-Standard Template (NEU)
    const breakfastTemplate = await client.query(
      `INSERT INTO item_templates (name, description, template_type)
       VALUES ($1, $2, $3) RETURNING *`,
      ['Frühstück-Standard', 'Standard-Layout für Frühstück', 'breakfast']
    );
    const breakfastId = breakfastTemplate.rows[0].id;
    
    const breakfastItems = [
      { name: 'Brötchen', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 1 },
      { name: 'Brötchen Mehrkorn', item_type: 'Backwaren', unit: 'pieces', emoji: '🥖', sort_order: 2 },
      { name: 'Wurst Normal', item_type: 'Wurst & Käse', unit: 'g', emoji: '🥓', sort_order: 3 },
      { name: 'Wurst Vegan', item_type: 'Wurst & Käse', unit: 'g', emoji: '🥓', sort_order: 4 },
      { name: 'Käse Normal', item_type: 'Wurst & Käse', unit: 'g', emoji: '🧀', sort_order: 5 },
      { name: 'Käse Vegan', item_type: 'Wurst & Käse', unit: 'g', emoji: '🧀', sort_order: 6 },
      { name: 'Müsli', item_type: 'Sonstiges', unit: 'g', emoji: '🥣', sort_order: 7 },
      { name: 'Yoghurt', item_type: 'Sonstiges', unit: 'g', emoji: '🥛', sort_order: 8 },
      { name: 'Milch', item_type: 'Getränke', unit: 'l', emoji: '🥛', sort_order: 9 },
      { name: 'Haferdrink', item_type: 'Getränke', unit: 'l', emoji: '🥛', sort_order: 10 },
      { name: 'Nutella', item_type: 'Aufstriche', unit: 'g', emoji: '🍫', sort_order: 11 },
      { name: 'Hummus', item_type: 'Aufstriche', unit: 'g', emoji: '🫘', sort_order: 12 },
      { name: 'Vegiaufstrich', item_type: 'Aufstriche', unit: 'g', emoji: '🥬', sort_order: 13 },
      { name: 'Rührei ala Tim ohne Speck', item_type: 'Sonstiges', unit: 'boolean', emoji: '🍳', sort_order: 14 },
      { name: 'Rührei ala Tim mit Speck', item_type: 'Sonstiges', unit: 'boolean', emoji: '🍳', sort_order: 15 },
      { name: 'Marmelade Erdbeere', item_type: 'Aufstriche', unit: 'g', emoji: '🍓', sort_order: 16 },
      { name: 'Marmelade Aprikose', item_type: 'Aufstriche', unit: 'g', emoji: '🍑', sort_order: 17 },
      { name: 'Marmelade Pfirsich', item_type: 'Aufstriche', unit: 'g', emoji: '🍑', sort_order: 18 },
      { name: 'Marmelade Himbeere', item_type: 'Aufstriche', unit: 'g', emoji: '🫐', sort_order: 19 },
      { name: 'Kaffee', item_type: 'Getränke', unit: 'l', emoji: '☕', sort_order: 20 },
      { name: 'Tee', item_type: 'Getränke', unit: 'l', emoji: '🍵', sort_order: 21 },
      { name: 'Orangensaft', item_type: 'Getränke', unit: 'l', emoji: '🧃', sort_order: 22 },
      { name: 'Sonstiges', item_type: 'Sonstiges', unit: 'pieces', emoji: '📦', sort_order: 23 }
    ];
    
    for (const item of breakfastItems) {
      await client.query(
        `INSERT INTO item_template_items (template_id, name, item_type, unit, emoji, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [breakfastId, item.name, item.item_type, item.unit, item.emoji, item.sort_order]
      );
    }
    
    await client.query('COMMIT');
    res.json({ success: true, message: 'Templates wurden zurückgesetzt' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  } finally {
    client.release();
  }
});

// Template auf Mahlzeit anwenden
app.post('/api/admin/meals/:mealId/apply-template/:templateId', adminAuth, async (req, res) => {
  const { mealId, templateId } = req.params;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Prüfe ob Mahlzeit existiert und den richtigen Typ hat
    const mealResult = await client.query(
      'SELECT * FROM meals WHERE id = $1',
      [mealId]
    );
    
    if (mealResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Mahlzeit nicht gefunden' });
    }
    
    const meal = mealResult.rows[0];
    if (meal.meal_type !== 'grill' && meal.meal_type !== 'breakfast') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Mahlzeit muss Typ "grill" oder "breakfast" haben' });
    }
    
    // Template laden
    const templateResult = await client.query(
      'SELECT * FROM item_templates WHERE id = $1',
      [templateId]
    );
    
    if (templateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Template nicht gefunden' });
    }
    
    // Template-Items laden
    const templateItemsResult = await client.query(
      'SELECT * FROM item_template_items WHERE template_id = $1 ORDER BY sort_order',
      [templateId]
    );
    
    // Items zur Mahlzeit hinzufügen
    const createdItems = [];
    for (const templateItem of templateItemsResult.rows) {
      const itemResult = await client.query(
        `INSERT INTO meal_items (meal_id, name, item_type, unit, emoji, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [mealId, templateItem.name, templateItem.item_type, templateItem.unit, templateItem.emoji, templateItem.sort_order]
      );
      createdItems.push(itemResult.rows[0]);
    }
    
    await client.query('COMMIT');
    res.json({ success: true, itemsCreated: createdItems.length, items: createdItems });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  } finally {
    client.release();
  }
});

// ==================== ALT: GRILL-SYSTEM APIS ====================

// Admin: Alle Grill-Events für ein Event
app.get('/api/admin/events/:eventId/grill-events', adminAuth, async (req, res) => {
  const { eventId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM grill_events WHERE event_id = $1 ORDER BY grill_date, grill_time',
      [eventId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Grill-Event anlegen
app.post('/api/admin/grill-events', adminAuth, async (req, res) => {
  const { eventId, title, grillDate, grillTime, description, sortOrder } = req.body;
  if (!eventId || !title || !grillDate || !grillTime) {
    return res.status(400).json({ error: 'eventId, title, grillDate und grillTime sind erforderlich' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO grill_events (event_id, title, grill_date, grill_time, description, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [eventId, title, grillDate, grillTime, description || null, sortOrder || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ========== ADMIN: Meal Items (für Grill & Frühstück) ==========

// Items für eine Mahlzeit laden
app.get('/api/admin/meals/:mealId/items', adminAuth, async (req, res) => {
  const { mealId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM meal_items WHERE meal_id = $1 ORDER BY sort_order',
      [mealId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Item zu Mahlzeit hinzufügen
app.post('/api/admin/meals/:mealId/items', adminAuth, async (req, res) => {
  const { mealId } = req.params;
  const { name, itemType, unit, emoji, sortOrder } = req.body;
  
  if (!name?.trim()) {
    return res.status(400).json({ error: 'name ist erforderlich' });
  }
  
  try {
    const result = await pool.query(
      `INSERT INTO meal_items (meal_id, name, item_type, unit, emoji, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [mealId, name.trim(), itemType || null, unit || 'pieces', emoji || null, sortOrder || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Item bearbeiten
app.put('/api/admin/meal-items/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { name, itemType, unit, emoji, sortOrder } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE meal_items SET name = $1, item_type = $2, unit = $3, emoji = $4, sort_order = $5
       WHERE id = $6 RETURNING *`,
      [name, itemType || null, unit || 'pieces', emoji || null, sortOrder || 0, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Item löschen
app.delete('/api/admin/meal-items/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM meal_items WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ========== ITEM-VORLAGEN ==========

// Item-Vorlagen abrufen (hardcodiert, später DB-basiert)
app.get('/api/admin/item-templates', adminAuth, async (req, res) => {
  const templates = {
    breakfast: [
      { name: 'Brötchen', itemType: 'Backwaren', unit: 'pieces', sortOrder: 1 },
      { name: 'Toast', itemType: 'Backwaren', unit: 'pieces', sortOrder: 2 },
      { name: 'Butter', itemType: 'Aufstrich', unit: 'g', sortOrder: 10 },
      { name: 'Marmelade', itemType: 'Aufstrich', unit: 'g', sortOrder: 11 },
      { name: 'Honig', itemType: 'Aufstrich', unit: 'g', sortOrder: 12 },
      { name: 'Nutella', itemType: 'Aufstrich', unit: 'g', sortOrder: 13 },
      { name: 'Käse (Scheiben)', itemType: 'Belag', unit: 'g', sortOrder: 20 },
      { name: 'Wurst (Aufschnitt)', itemType: 'Belag', unit: 'g', sortOrder: 21 },
      { name: 'Gurken', itemType: 'Gemüse', unit: 'pieces', sortOrder: 30 },
      { name: 'Tomaten', itemType: 'Gemüse', unit: 'pieces', sortOrder: 31 },
      { name: 'Paprika', itemType: 'Gemüse', unit: 'pieces', sortOrder: 32 },
      { name: 'Eier', itemType: 'Sonstiges', unit: 'pieces', sortOrder: 40 },
      { name: 'Müsli', itemType: 'Sonstiges', unit: 'g', sortOrder: 41 },
      { name: 'Joghurt', itemType: 'Sonstiges', unit: 'g', sortOrder: 42 },
      { name: 'Milch', itemType: 'Getränke', unit: 'l', sortOrder: 50 },
      { name: 'Kaffee', itemType: 'Getränke', unit: 'l', sortOrder: 51 },
      { name: 'Tee', itemType: 'Getränke', unit: 'l', sortOrder: 52 },
      { name: 'Orangensaft', itemType: 'Getränke', unit: 'l', sortOrder: 53 },
    ],
    grill: [
      { name: 'Würstchen', itemType: 'Fleisch', unit: 'pieces', sortOrder: 1 },
      { name: 'Bratwurst', itemType: 'Fleisch', unit: 'pieces', sortOrder: 2 },
      { name: 'Steaks', itemType: 'Fleisch', unit: 'pieces', sortOrder: 3 },
      { name: 'Hähnchen', itemType: 'Fleisch', unit: 'pieces', sortOrder: 4 },
      { name: 'Grillkäse', itemType: 'Vegetarisch', unit: 'pieces', sortOrder: 10 },
      { name: 'Gemüsespieße', itemType: 'Vegetarisch', unit: 'pieces', sortOrder: 11 },
      { name: 'Folienkartoffeln', itemType: 'Beilage', unit: 'pieces', sortOrder: 20 },
      { name: 'Baguette', itemType: 'Beilage', unit: 'pieces', sortOrder: 21 },
      { name: 'Salat (gemischt)', itemType: 'Beilage', unit: 'kg', sortOrder: 22 },
      { name: 'Gurkensalat', itemType: 'Beilage', unit: 'kg', sortOrder: 23 },
      { name: 'Tomatensalat', itemType: 'Beilage', unit: 'kg', sortOrder: 24 },
      { name: 'Ketchup', itemType: 'Sauce', unit: 'ml', sortOrder: 30 },
      { name: 'Senf', itemType: 'Sauce', unit: 'ml', sortOrder: 31 },
      { name: 'Mayo', itemType: 'Sauce', unit: 'ml', sortOrder: 32 },
      { name: 'Grillsauce', itemType: 'Sauce', unit: 'ml', sortOrder: 33 },
      { name: 'Bier', itemType: 'Getränke', unit: 'l', sortOrder: 40 },
      { name: 'Limonade', itemType: 'Getränke', unit: 'l', sortOrder: 41 },
      { name: 'Wasser', itemType: 'Getränke', unit: 'l', sortOrder: 42 },
      { name: 'Grillkohle', itemType: 'Sonstiges', unit: 'kg', sortOrder: 50 },
      { name: 'Grillanzünder', itemType: 'Sonstiges', unit: 'pieces', sortOrder: 51 },
    ]
  };
  
  res.json(templates);
});

// Report für Grill/Frühstück (Mengenauswertung)
app.get('/api/admin/meals/:mealId/items/report', adminAuth, async (req, res) => {
  const { mealId } = req.params;
  try {
    const result = await pool.query(`
      SELECT 
        mi.id as item_id,
        mi.name as item_name,
        mi.item_type,
        mi.unit,
        COALESCE(SUM(mis.quantity), 0) as total_quantity,
        COUNT(mis.id) as selection_count,
        array_agg(mis.person_name || ': ' || mis.quantity ORDER BY mis.person_name) FILTER (WHERE mis.id IS NOT NULL) as selections
      FROM meal_items mi
      LEFT JOIN meal_item_selections mis ON mis.meal_item_id = mi.id
      WHERE mi.meal_id = $1
      GROUP BY mi.id, mi.name, mi.item_type, mi.unit
      ORDER BY mi.sort_order
    `, [mealId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ========== ALT: Grill-APIs (werden entfernt) ==========

// Admin: Grill-Event bearbeiten
app.put('/api/admin/grill-events/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { title, grillDate, grillTime, description, sortOrder } = req.body;
  try {
    const result = await pool.query(
      `UPDATE grill_events SET title = $1, grill_date = $2, grill_time = $3, description = $4, sort_order = $5
       WHERE id = $6 RETURNING *`,
      [title, grillDate, grillTime, description || null, sortOrder || 0, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Grill-Event löschen
app.delete('/api/admin/grill-events/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM grill_events WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Alle Items für ein Grill-Event
app.get('/api/admin/grill-events/:grillEventId/items', adminAuth, async (req, res) => {
  const { grillEventId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM grill_items WHERE grill_event_id = $1 ORDER BY sort_order, name',
      [grillEventId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Item hinzufügen
app.post('/api/admin/grill-events/:grillEventId/items', adminAuth, async (req, res) => {
  const { grillEventId } = req.params;
  const { name, itemType, unit, sortOrder } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name ist erforderlich' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO grill_items (grill_event_id, name, item_type, unit, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [grillEventId, name, itemType || 'meat', unit || 'pieces', sortOrder || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Item bearbeiten
app.put('/api/admin/grill-items/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { name, itemType, unit, sortOrder } = req.body;
  try {
    const result = await pool.query(
      `UPDATE grill_items SET name = $1, item_type = $2, unit = $3, sort_order = $4
       WHERE id = $5 RETURNING *`,
      [name, itemType, unit, sortOrder || 0, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Item löschen
app.delete('/api/admin/grill-items/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM grill_items WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Report/Einkaufsliste
app.get('/api/admin/grill-events/:grillEventId/report', adminAuth, async (req, res) => {
  const { grillEventId } = req.params;
  try {
    const result = await pool.query(`
      SELECT 
        gi.id, gi.name, gi.item_type, gi.unit,
        COALESCE(SUM(gs.quantity), 0) as total_quantity,
        json_agg(json_build_object('personName', gs.person_name, 'quantity', gs.quantity, 'notes', gs.notes) 
                 ORDER BY gs.person_name) FILTER (WHERE gs.person_name IS NOT NULL) as selections
      FROM grill_items gi
      LEFT JOIN grill_selections gs ON gi.id = gs.grill_item_id
      WHERE gi.grill_event_id = $1
      GROUP BY gi.id, gi.name, gi.item_type, gi.unit
      ORDER BY gi.sort_order, gi.name
    `, [grillEventId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// User: Alle Grill-Events
app.get('/api/grill-events', async (req, res) => {
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  try {
    const events = await pool.query(
      'SELECT * FROM grill_events WHERE event_id = $1 ORDER BY grill_date, grill_time',
      [req.eventId]
    );
    
    // Für jedes Grill-Event die Items laden
    for (const event of events.rows) {
      const items = await pool.query(
        'SELECT * FROM grill_items WHERE grill_event_id = $1 ORDER BY sort_order, name',
        [event.id]
      );
      event.items = items.rows;
    }
    
    res.json(events.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// User: Auswahl für eine Person abrufen
app.get('/api/grill-selections/:personName', async (req, res) => {
  const { personName } = req.params;
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  try {
    const result = await pool.query(`
      SELECT gs.*, ge.id as grill_event_id
      FROM grill_selections gs
      JOIN grill_events ge ON gs.grill_event_id = ge.id
      WHERE ge.event_id = $1 AND LOWER(gs.person_name) = LOWER($2)
    `, [req.eventId, personName]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// User: Auswahl speichern
app.post('/api/grill-selections', async (req, res) => {
  const { personName, grillEventId, selections } = req.body; // selections = [{ itemId, quantity, notes }]
  if (!personName?.trim() || !grillEventId || !Array.isArray(selections)) {
    return res.status(400).json({ error: 'personName, grillEventId und selections sind erforderlich' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Alte Auswahlen für dieses Grill-Event löschen
    await client.query(
      'DELETE FROM grill_selections WHERE grill_event_id = $1 AND LOWER(person_name) = LOWER($2)',
      [grillEventId, personName.trim()]
    );
    
    // Neue Auswahlen einfügen (nur wenn quantity > 0)
    for (const selection of selections) {
      if (selection.quantity > 0) {
        await client.query(
          `INSERT INTO grill_selections (grill_event_id, grill_item_id, person_name, quantity, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [grillEventId, selection.itemId, personName.trim(), selection.quantity, selection.notes || null]
        );
      }
    }
    
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

// User: Auswahl löschen
app.delete('/api/grill-selections/:personName/:grillEventId', async (req, res) => {
  const { personName, grillEventId } = req.params;
  try {
    await pool.query(
      'DELETE FROM grill_selections WHERE grill_event_id = $1 AND LOWER(person_name) = LOWER($2)',
      [grillEventId, personName]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ==================== FRÜHSTÜCK-SYSTEM APIS ====================

// Admin: Alle Frühstück-Events für ein Event
app.get('/api/admin/events/:eventId/breakfast-events', adminAuth, async (req, res) => {
  const { eventId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM breakfast_events WHERE event_id = $1 ORDER BY breakfast_date, breakfast_time',
      [eventId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Frühstück-Event anlegen
app.post('/api/admin/breakfast-events', adminAuth, async (req, res) => {
  const { eventId, title, breakfastDate, breakfastTime, description, sortOrder } = req.body;
  if (!eventId || !title || !breakfastDate || !breakfastTime) {
    return res.status(400).json({ error: 'eventId, title, breakfastDate und breakfastTime sind erforderlich' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO breakfast_events (event_id, title, breakfast_date, breakfast_time, description, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [eventId, title, breakfastDate, breakfastTime, description || null, sortOrder || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Frühstück-Event bearbeiten
app.put('/api/admin/breakfast-events/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { title, breakfastDate, breakfastTime, description, sortOrder } = req.body;
  try {
    const result = await pool.query(
      `UPDATE breakfast_events SET title = $1, breakfast_date = $2, breakfast_time = $3, description = $4, sort_order = $5
       WHERE id = $6 RETURNING *`,
      [title, breakfastDate, breakfastTime, description || null, sortOrder || 0, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Frühstück-Event löschen
app.delete('/api/admin/breakfast-events/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM breakfast_events WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Alle Items für ein Frühstück-Event
app.get('/api/admin/breakfast-events/:breakfastEventId/items', adminAuth, async (req, res) => {
  const { breakfastEventId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM breakfast_items WHERE breakfast_event_id = $1 ORDER BY sort_order, name',
      [breakfastEventId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Item hinzufügen
app.post('/api/admin/breakfast-events/:breakfastEventId/items', adminAuth, async (req, res) => {
  const { breakfastEventId } = req.params;
  const { name, itemType, unit, sortOrder } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name ist erforderlich' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO breakfast_items (breakfast_event_id, name, item_type, unit, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [breakfastEventId, name, itemType || 'bread', unit || 'pieces', sortOrder || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Item bearbeiten
app.put('/api/admin/breakfast-items/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { name, itemType, unit, sortOrder } = req.body;
  try {
    const result = await pool.query(
      `UPDATE breakfast_items SET name = $1, item_type = $2, unit = $3, sort_order = $4
       WHERE id = $5 RETURNING *`,
      [name, itemType, unit, sortOrder || 0, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Item löschen
app.delete('/api/admin/breakfast-items/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM breakfast_items WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// Admin: Report/Einkaufsliste
app.get('/api/admin/breakfast-events/:breakfastEventId/report', adminAuth, async (req, res) => {
  const { breakfastEventId } = req.params;
  try {
    const result = await pool.query(`
      SELECT 
        bi.id, bi.name, bi.item_type, bi.unit,
        COALESCE(SUM(bs.quantity), 0) as total_quantity,
        json_agg(json_build_object('personName', bs.person_name, 'quantity', bs.quantity, 'notes', bs.notes) 
                 ORDER BY bs.person_name) FILTER (WHERE bs.person_name IS NOT NULL) as selections
      FROM breakfast_items bi
      LEFT JOIN breakfast_selections bs ON bi.id = bs.breakfast_item_id
      WHERE bi.breakfast_event_id = $1
      GROUP BY bi.id, bi.name, bi.item_type, bi.unit
      ORDER BY bi.sort_order, bi.name
    `, [breakfastEventId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// User: Alle Frühstück-Events
app.get('/api/breakfast-events', async (req, res) => {
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  try {
    const events = await pool.query(
      'SELECT * FROM breakfast_events WHERE event_id = $1 ORDER BY breakfast_date, breakfast_time',
      [req.eventId]
    );
    
    // Für jedes Frühstück-Event die Items laden
    for (const event of events.rows) {
      const items = await pool.query(
        'SELECT * FROM breakfast_items WHERE breakfast_event_id = $1 ORDER BY sort_order, name',
        [event.id]
      );
      event.items = items.rows;
    }
    
    res.json(events.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// User: Auswahl für eine Person abrufen
app.get('/api/breakfast-selections/:personName', async (req, res) => {
  const { personName } = req.params;
  if (!req.eventId) {
    return res.status(404).json({ error: 'Kein Event gefunden' });
  }
  try {
    const result = await pool.query(`
      SELECT bs.*, be.id as breakfast_event_id
      FROM breakfast_selections bs
      JOIN breakfast_events be ON bs.breakfast_event_id = be.id
      WHERE be.event_id = $1 AND LOWER(bs.person_name) = LOWER($2)
    `, [req.eventId, personName]);
    res.json(result.rows);
  } catch (err) {
    console.error('Fehler:', err.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// User: Auswahl speichern
app.post('/api/breakfast-selections', async (req, res) => {
  const { personName, breakfastEventId, selections } = req.body; // selections = [{ itemId, quantity, notes }]
  if (!personName?.trim() || !breakfastEventId || !Array.isArray(selections)) {
    return res.status(400).json({ error: 'personName, breakfastEventId und selections sind erforderlich' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Alte Auswahlen für dieses Frühstück-Event löschen
    await client.query(
      'DELETE FROM breakfast_selections WHERE breakfast_event_id = $1 AND LOWER(person_name) = LOWER($2)',
      [breakfastEventId, personName.trim()]
    );
    
    // Neue Auswahlen einfügen (nur wenn quantity > 0)
    for (const selection of selections) {
      if (selection.quantity > 0) {
        await client.query(
          `INSERT INTO breakfast_selections (breakfast_event_id, breakfast_item_id, person_name, quantity, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [breakfastEventId, selection.itemId, personName.trim(), selection.quantity, selection.notes || null]
        );
      }
    }
    
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

// User: Auswahl löschen
app.delete('/api/breakfast-selections/:personName/:breakfastEventId', async (req, res) => {
  const { personName, breakfastEventId } = req.params;
  try {
    await pool.query(
      'DELETE FROM breakfast_selections WHERE breakfast_event_id = $1 AND LOWER(person_name) = LOWER($2)',
      [breakfastEventId, personName]
    );
    res.json({ success: true });
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
