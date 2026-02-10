/**
 * Oracle → Railway Import Script (SLIM - no codes, memory-efficient)
 */
import oracledb from 'oracledb';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const ORACLE_CONFIG = {
  user: 'sys',
  password: 'Rampod99',
  connectString: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=uhhy-db-300vdev.rampod.net)(PORT=1521))(CONNECT_DATA=(SID=rampdb)))',
  privilege: oracledb.SYSDBA
};

const PG_URL = 'postgresql://postgres:FeCspMIEYGRplFVZCbyylDXymoqeBgxe@nozomi.proxy.rlwy.net:46042/railway';

const ASSETS_PER_PROGRAM = 1250;
const PROGRAMS = {
  'ACTS_LOC': { id: 1, name: 'ACTS Program', cd: 'ACTS' },
  'ARDS_LOC': { id: 2, name: 'ARDS Program', cd: 'ARDS' },
  'CRIIS_LOC': { id: 3, name: 'CRIIS Program', cd: 'CRIIS' },
  '236_LOC': { id: 4, name: '236 Program', cd: '236' }
};

async function main() {
  let oraConn, pgClient;
  const startTime = Date.now();
  
  try {
    console.log('🚀 Starting Oracle → Railway import (SLIM)...\n');
    
    console.log('Connecting to Oracle...');
    oraConn = await oracledb.getConnection(ORACLE_CONFIG);
    console.log('✓ Connected to Oracle');
    
    console.log('Connecting to Railway PostgreSQL...');
    pgClient = new pg.Client(PG_URL);
    await pgClient.connect();
    console.log('✓ Connected to Railway PostgreSQL\n');
    
    // STEP 1: Get locations for each program
    console.log('━━━ STEP 1: Fetching location mappings ━━━');
    const locsByProgram = {};
    const allLocIds = new Set();
    
    for (const [setName, pgm] of Object.entries(PROGRAMS)) {
      const result = await oraConn.execute(
        `SELECT loc_id FROM GLOBALEYE.LOC_SET WHERE set_name = :pgm AND active = 'Y'`,
        { pgm: setName }
      );
      locsByProgram[setName] = result.rows.map(r => r[0]);
      result.rows.forEach(r => allLocIds.add(r[0]));
      console.log(`  ${pgm.cd}: ${locsByProgram[setName].length} locations`);
    }
    console.log(`  Total unique locations: ${allLocIds.size}\n`);
    
    // STEP 2: Clear Railway tables
    console.log('━━━ STEP 2: Clearing Railway tables ━━━');
    const tablesToClear = [
      'labor', 'repair', 'event', 'asset', 'loc_set', 'part_list', 'location', 'program', 'users'
    ];
    for (const t of tablesToClear) {
      try { await pgClient.query(`TRUNCATE TABLE "${t}" CASCADE`); } catch (e) {}
    }
    console.log('  ✓ Tables cleared\n');
    
    // STEP 3: Create programs
    console.log('━━━ STEP 3: Creating programs ━━━');
    for (const [setName, pgm] of Object.entries(PROGRAMS)) {
      await pgClient.query(
        `INSERT INTO program (pgm_id, pgm_cd, pgm_name, active) VALUES ($1, $2, $3, true)`,
        [pgm.id, pgm.cd, pgm.name]
      );
    }
    console.log('  ✓ 4 programs created\n');
    
    // STEP 4: Import locations
    console.log('━━━ STEP 4: Importing locations ━━━');
    const locIdsArray = [...allLocIds];
    const locResult = await oraConn.execute(
      `SELECT loc_id, description, display_name, active FROM GLOBALEYE.LOCATION WHERE loc_id IN (${locIdsArray.join(',')})`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    
    let locsImported = 0;
    for (const loc of locResult.rows) {
      try {
        await pgClient.query(
          `INSERT INTO location (loc_id, description, display_name, active) VALUES ($1, $2, $3, $4)`,
          [loc.LOC_ID, loc.DESCRIPTION, loc.DISPLAY_NAME || loc.DESCRIPTION, loc.ACTIVE === 'Y']
        );
        locsImported++;
      } catch (e) {}
    }
    console.log(`  ✓ ${locsImported} locations imported\n`);
    
    // STEP 5: Import loc_set
    console.log('━━━ STEP 5: Importing loc_set mappings ━━━');
    let setId = 1, locSetCount = 0;
    for (const [setName, locs] of Object.entries(locsByProgram)) {
      const pgmId = PROGRAMS[setName].id;
      for (const locId of locs) {
        try {
          await pgClient.query(
            `INSERT INTO loc_set (set_id, set_name, pgm_id, loc_id, active) VALUES ($1, $2, $3, $4, true)`,
            [setId++, setName, pgmId, locId]
          );
          locSetCount++;
        } catch (e) {}
      }
    }
    console.log(`  ✓ ${locSetCount} loc_set mappings created\n`);
    
    // STEP 6: Fetch assets
    console.log('━━━ STEP 6: Fetching assets from Oracle ━━━');
    const allAssets = [];
    const partnoIdsNeeded = new Set();
    
    for (const [setName, locs] of Object.entries(locsByProgram)) {
      if (locs.length === 0) continue;
      const assetsResult = await oraConn.execute(
        `SELECT * FROM (
           SELECT asset_id, partno_id, serno, status_cd, loc_ida, loc_idc, active
           FROM GLOBALEYE.ASSET WHERE loc_ida IN (${locs.join(',')}) AND active = 'Y'
           ORDER BY DBMS_RANDOM.VALUE
         ) WHERE ROWNUM <= :limit`,
        { limit: ASSETS_PER_PROGRAM },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      for (const a of assetsResult.rows) {
        allAssets.push(a);
        if (a.PARTNO_ID) partnoIdsNeeded.add(a.PARTNO_ID);
      }
      console.log(`  ${PROGRAMS[setName].cd}: ${assetsResult.rows.length} assets`);
    }
    console.log(`  Total: ${allAssets.length} assets, ${partnoIdsNeeded.size} unique parts needed\n`);
    
    // STEP 7: Import parts (only those needed)
    console.log('━━━ STEP 7: Importing parts ━━━');
    const partnoIdArray = [...partnoIdsNeeded];
    let partsImported = 0;
    
    for (let i = 0; i < partnoIdArray.length; i += 500) {
      const chunk = partnoIdArray.slice(i, i + 500);
      const partsResult = await oraConn.execute(
        `SELECT partno_id, partno, nsn, noun, sys_type, active FROM GLOBALEYE.PART_LIST WHERE partno_id IN (${chunk.join(',')})`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      for (const p of partsResult.rows) {
        try {
          await pgClient.query(
            `INSERT INTO part_list (partno_id, partno, nsn, noun, pgm_id, sys_type, active) VALUES ($1, $2, $3, $4, 1, $5, $6)`,
            [p.PARTNO_ID, p.PARTNO || 'UNKNOWN', p.NSN, p.NOUN, p.SYS_TYPE?.toString() || '', p.ACTIVE === 'Y']
          );
          partsImported++;
        } catch (e) {}
      }
      process.stdout.write(`\r  Parts: ${partsImported}/${partnoIdsNeeded.size}`);
    }
    console.log(`\n  ✓ ${partsImported} parts imported\n`);
    
    // STEP 8: Import assets
    console.log('━━━ STEP 8: Importing assets ━━━');
    const assetIds = [];
    let assetsImported = 0;
    
    for (const a of allAssets) {
      try {
        await pgClient.query(
          `INSERT INTO asset (asset_id, partno_id, serno, status_cd, loc_ida, loc_idc, active) VALUES ($1, $2, $3, 'FMC', $4, $5, $6)`,
          [a.ASSET_ID, a.PARTNO_ID, a.SERNO, a.LOC_IDA, a.LOC_IDC, a.ACTIVE === 'Y']
        );
        assetIds.push(a.ASSET_ID);
        assetsImported++;
        if (assetsImported % 500 === 0) process.stdout.write(`\r  Assets: ${assetsImported}/${allAssets.length}`);
      } catch (e) {}
    }
    console.log(`\n  ✓ ${assetsImported} assets imported\n`);
    
    // STEP 9: Import events (limited)
    console.log('━━━ STEP 9: Importing events ━━━');
    let eventsImported = 0;
    const maxEvents = 10000;
    
    for (let i = 0; i < assetIds.length && eventsImported < maxEvents; i += 500) {
      const chunk = assetIds.slice(i, i + 500);
      if (chunk.length === 0) break;
      const eventsResult = await oraConn.execute(
        `SELECT event_id, asset_id, event_type, discrepancy, how_mal, when_disc, loc_id, priority, ins_date
         FROM GLOBALEYE.EVENT WHERE asset_id IN (${chunk.join(',')}) AND ROWNUM <= 2000`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      for (const e of eventsResult.rows) {
        if (eventsImported >= maxEvents) break;
        try {
          await pgClient.query(
            `INSERT INTO event (event_id, asset_id, event_type, discrepancy, how_mal, when_disc, loc_id, priority, ins_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (event_id) DO NOTHING`,
            [e.EVENT_ID, e.ASSET_ID, e.EVENT_TYPE, e.DISCREPANCY, e.HOW_MAL, e.WHEN_DISC, e.LOC_ID, e.PRIORITY, e.INS_DATE]
          );
          eventsImported++;
        } catch (err) {}
      }
      process.stdout.write(`\r  Events: ${eventsImported}`);
    }
    console.log(`\n  ✓ ${eventsImported} events imported\n`);
    
    // STEP 10: Import repairs (limited)
    console.log('━━━ STEP 10: Importing repairs ━━━');
    let repairsImported = 0;
    const maxRepairs = 5000;
    
    for (let i = 0; i < assetIds.length && repairsImported < maxRepairs; i += 500) {
      const chunk = assetIds.slice(i, i + 500);
      if (chunk.length === 0) break;
      const repairsResult = await oraConn.execute(
        `SELECT repair_id, event_id, asset_id, start_date, stop_date, type_maint, narrative
         FROM GLOBALEYE.REPAIR WHERE asset_id IN (${chunk.join(',')}) AND ROWNUM <= 1000`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      for (const r of repairsResult.rows) {
        if (repairsImported >= maxRepairs) break;
        try {
          await pgClient.query(
            `INSERT INTO repair (repair_id, event_id, asset_id, start_date, stop_date, type_maint, narrative)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (repair_id) DO NOTHING`,
            [r.REPAIR_ID, r.EVENT_ID, r.ASSET_ID, r.START_DATE, r.STOP_DATE, r.TYPE_MAINT, r.NARRATIVE]
          );
          repairsImported++;
        } catch (err) {}
      }
      process.stdout.write(`\r  Repairs: ${repairsImported}`);
    }
    console.log(`\n  ✓ ${repairsImported} repairs imported\n`);
    
    // STEP 11: Import labors (limited)
    console.log('━━━ STEP 11: Importing labors ━━━');
    let laborsImported = 0;
    const maxLabors = 10000;
    
    for (let i = 0; i < assetIds.length && laborsImported < maxLabors; i += 500) {
      const chunk = assetIds.slice(i, i + 500);
      if (chunk.length === 0) break;
      const laborsResult = await oraConn.execute(
        `SELECT labor_id, repair_id, asset_id, action_taken, type_maint, start_date, stop_date, hours
         FROM GLOBALEYE.LABOR WHERE asset_id IN (${chunk.join(',')}) AND ROWNUM <= 2000`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      for (const l of laborsResult.rows) {
        if (laborsImported >= maxLabors) break;
        try {
          await pgClient.query(
            `INSERT INTO labor (labor_id, repair_id, asset_id, action_taken, type_maint, start_date, stop_date, hours)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (labor_id) DO NOTHING`,
            [l.LABOR_ID, l.REPAIR_ID, l.ASSET_ID, l.ACTION_TAKEN, l.TYPE_MAINT, l.START_DATE, l.STOP_DATE, l.HOURS]
          );
          laborsImported++;
        } catch (err) {}
      }
      process.stdout.write(`\r  Labors: ${laborsImported}`);
    }
    console.log(`\n  ✓ ${laborsImported} labors imported\n`);
    
    // STEP 12: Create users
    console.log('━━━ STEP 12: Creating users ━━━');
    const pwHash = await bcrypt.hash('admin123', 10);
    const users = [
      [1, 'admin', 'admin@rimss.mil', 'Admin', 'User', 'ADMIN'],
      [2, 'viewer', 'viewer@rimss.mil', 'Viewer', 'User', 'VIEWER'],
      [3, 'field_tech', 'field@rimss.mil', 'Field', 'Tech', 'FIELD_TECHNICIAN'],
      [4, 'depot_mgr', 'depot@rimss.mil', 'Depot', 'Manager', 'DEPOT_MANAGER'],
      [5, 'shop', 'shop@rimss.mil', 'Shop', 'User', 'SHOP'],
    ];
    for (const [id, username, email, first, last, role] of users) {
      await pgClient.query(
        `INSERT INTO users (user_id, username, password_hash, email, first_name, last_name, role) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, username, pwHash, email, first, last, role]
      );
    }
    console.log('  ✓ 5 users created\n');
    
    // SUMMARY
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ IMPORT COMPLETE!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Programs:  4`);
    console.log(`  Locations: ${locsImported}`);
    console.log(`  Loc Sets:  ${locSetCount}`);
    console.log(`  Parts:     ${partsImported}`);
    console.log(`  Assets:    ${assetsImported}`);
    console.log(`  Events:    ${eventsImported}`);
    console.log(`  Repairs:   ${repairsImported}`);
    console.log(`  Labors:    ${laborsImported}`);
    console.log(`  Users:     5`);
    console.log(`  Time:      ${elapsed} minutes`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('🌐 URL: https://rimss-production.up.railway.app');
    console.log('👤 Login: admin / admin123');
    
  } catch (err) {
    console.error('\n❌ ERROR:', err);
  } finally {
    if (oraConn) { await oraConn.close(); console.log('\nOracle connection closed.'); }
    if (pgClient) { await pgClient.end(); console.log('PostgreSQL connection closed.'); }
  }
}

main();
