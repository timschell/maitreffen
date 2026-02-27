/**
 * Migration Script: Maitreffen 2026 als erstes Event anlegen
 * 
 * Dieses Script:
 * 1. Erstellt das Maitreffen 2026 Event
 * 2. Legt alle 9 Zimmer mit korrekter Konfiguration an
 * 3. Verknüpft bestehende Buchungen, Spiele und Warteliste mit dem Event
 * 
 * Ausführen mit: node migrate-to-events.js
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://brettspielfamilie:1qay2wsx3edc@brettspielfamilie-maitreffendb-epibyx:5432/maitreffen-db',
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// Maitreffen 2026 Event-Daten
const EVENT = {
  slug: 'maitreffen',
  name: 'Maitreffen 2026',
  description: 'Das jährliche Brettspieltreffen der Brettspielfamilie',
  start_date: '2026-05-13',
  end_date: '2026-05-17',
  location_name: 'Evangelisches Freizeitheim Halbe',
  location_address: 'Kirchstraße 7, 15757 Halbe',
  location_url: 'https://www.freizeitheim-halbe.de',
  check_in_time: '16:00',
  check_out_time: '11:00'
};

// Zimmer-Konfiguration für Freizeitheim Halbe
const ROOMS = [
  { room_name: 'Zimmer 1', floor: 'EG', beds_count: 3, has_private_bath: true, is_accessible: false, sort_order: 1 },
  { room_name: 'Zimmer 2', floor: 'EG', beds_count: 2, has_private_bath: true, is_accessible: true, sort_order: 2, notes: 'Barrierefrei' },
  { room_name: 'Zimmer 3', floor: 'EG', beds_count: 2, has_private_bath: true, is_accessible: false, sort_order: 3 },
  { room_name: 'Zimmer 4', floor: 'OG', beds_count: 3, has_private_bath: false, is_accessible: false, sort_order: 4 },
  { room_name: 'Zimmer 5', floor: 'OG', beds_count: 4, has_private_bath: false, is_accessible: false, sort_order: 5 },
  { room_name: 'Zimmer 6', floor: 'OG', beds_count: 3, has_private_bath: false, is_accessible: false, sort_order: 6 },
  { room_name: 'Zimmer 7', floor: 'OG', beds_count: 3, has_private_bath: false, is_accessible: false, sort_order: 7 },
  { room_name: 'Zimmer 8', floor: 'OG', beds_count: 2, has_private_bath: false, is_accessible: false, sort_order: 8 },
  { room_name: 'Zimmer 9', floor: 'OG', beds_count: 3, has_private_bath: false, is_accessible: false, sort_order: 9 },
];

async function migrate() {
  const client = await pool.connect();
  
  try {
    console.log('🚀 Starte Migration...\n');
    
    await client.query('BEGIN');
    
    // 1. Prüfen ob Event schon existiert
    const existingEvent = await client.query('SELECT id FROM events WHERE slug = $1', [EVENT.slug]);
    
    let eventId;
    
    if (existingEvent.rows.length > 0) {
      eventId = existingEvent.rows[0].id;
      console.log(`✅ Event "${EVENT.name}" existiert bereits (ID: ${eventId})`);
    } else {
      // Event anlegen
      const eventResult = await client.query(`
        INSERT INTO events (slug, name, description, start_date, end_date, location_name, location_address, location_url, check_in_time, check_out_time, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
        RETURNING id
      `, [EVENT.slug, EVENT.name, EVENT.description, EVENT.start_date, EVENT.end_date, EVENT.location_name, EVENT.location_address, EVENT.location_url, EVENT.check_in_time, EVENT.check_out_time]);
      
      eventId = eventResult.rows[0].id;
      console.log(`✅ Event "${EVENT.name}" angelegt (ID: ${eventId})`);
    }
    
    // 2. Zimmer anlegen (falls nicht vorhanden)
    const existingRooms = await client.query('SELECT COUNT(*) as count FROM event_rooms WHERE event_id = $1', [eventId]);
    
    if (parseInt(existingRooms.rows[0].count) === 0) {
      for (const room of ROOMS) {
        await client.query(`
          INSERT INTO event_rooms (event_id, room_name, floor, beds_count, has_private_bath, is_accessible, notes, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [eventId, room.room_name, room.floor, room.beds_count, room.has_private_bath, room.is_accessible, room.notes || null, room.sort_order]);
      }
      console.log(`✅ ${ROOMS.length} Zimmer angelegt (${ROOMS.reduce((sum, r) => sum + r.beds_count, 0)} Betten total)`);
    } else {
      console.log(`✅ Zimmer existieren bereits (${existingRooms.rows[0].count} Zimmer)`);
    }
    
    // 3. Bestehende Buchungen mit Event verknüpfen
    const bookingsResult = await client.query('UPDATE bookings SET event_id = $1 WHERE event_id IS NULL', [eventId]);
    console.log(`✅ ${bookingsResult.rowCount} Buchungen mit Event verknüpft`);
    
    // 4. Bestehende Spiele mit Event verknüpfen
    const gamesResult = await client.query('UPDATE games SET event_id = $1 WHERE event_id IS NULL', [eventId]);
    console.log(`✅ ${gamesResult.rowCount} Spiele mit Event verknüpft`);
    
    // 5. Bestehende Warteliste mit Event verknüpfen
    const waitlistResult = await client.query('UPDATE waitlist SET event_id = $1 WHERE event_id IS NULL', [eventId]);
    console.log(`✅ ${waitlistResult.rowCount} Wartelisten-Einträge mit Event verknüpft`);
    
    await client.query('COMMIT');
    
    console.log('\n🎉 Migration erfolgreich abgeschlossen!\n');
    
    // Zusammenfassung
    const stats = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM bookings WHERE event_id = $1 AND status = 'booked') as bookings,
        (SELECT COUNT(*) FROM games WHERE event_id = $1) as games,
        (SELECT COUNT(*) FROM waitlist WHERE event_id = $1) as waitlist
    `, [eventId]);
    
    console.log('📊 Aktueller Stand:');
    console.log(`   - ${stats.rows[0].bookings} Buchungen`);
    console.log(`   - ${stats.rows[0].games} Spiele`);
    console.log(`   - ${stats.rows[0].waitlist} auf der Warteliste`);
    console.log('');
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration fehlgeschlagen:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
