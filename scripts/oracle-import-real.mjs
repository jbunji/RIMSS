/**
 * Oracle → Railway Import Script (OPTIMIZED v2)
 * Imports ~5000 real assets spread across programs/locations
 * Only imports parts actually used by the imported assets
 */
import oracledb from 'oracledb';
import pg from 'pg';

const ORACLE_CONFIG = {
  user: 'sys',
  password: 'Rampod99',
  connectString: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=uhhy-db-300vdev.rampod.net)(PORT=1521))(CONNECT_DATA=(SID=rampdb)))',
  privilege: oracledb.SYSDBA
};

const PG_URL = 'postgresql://postgres:FeCspMIEYGRplFVZCbyylDXymoqeBgxe@nozomi.proxy.rlwy.net:46042/railway';

const ASSETS_PER_PROGRAM = 1250;
const PROGRAMS = ['ACTS_LOC', 'ARDS_LOC', 'CRIIS_LOC', '236_LOC'];

async function main() {
  let oraConn, pgClient;
  
  try {
    console.log('Connecting to Oracle...');
    oraConn = await oracledb.getConnection(ORACLE_CONFIG);
    console.log('Connecting to Railway PostgreSQL...');
    pgClient = new pg.Client(PG_URL);
    await pgClient.connect();
    console.log('Connected!\n');
    
    // Step 1: Get locations by program
    console.log('=== Step 1: Fetching location mappings ===');
    const locsByProgram = {};
    for (const pgmSet of PROGRAMS) {
      const result = await oraConn.execute(
        `SELECT loc_id FROM GLOBALEYE.LOC_SET WHERE set_name = :pgm AND active = 'Y'`,
        { pgm: pgmSet }
      );
      locsByProgram[pgmSet] = result.rows.map(r => r[0]);
      console.log(`  ${pgmSet}: ${locsByProgram[pgmSet].length} locations`);
    }
    
    // Step 2: Clear tables
    console.log('\n=== Step 2: Clearing tables ===');
    for (const t of ['labor', 'repair', 'event', 'asset', 'loc_set', 'part_list', 'location', 'code', 'program', 'users']) {
      try { await pgClient.query(`TRUNCATE TABLE "${t}" CASCADE`); } catch { }
    }
    console.log('  Done.');
    
    // Step 3: Programs
    console.log('\n=== Step 3: Creating programs ===');
    const programMap = {
      'ACTS_LOC': { id: 1, name: 'ACTS Program', cd: 'ACTS' },
      'ARDS_LOC': { id: 2, name: 'ARDS Program', cd: 'ARDS' },
      'CRIIS_LOC': { id: 3, name: 'CRIIS Program', cd: 'CRIIS' },
      '236_LOC': { id: 4, name: '236 Program', cd: '236' }
    };
    for (const pgm of Object.values(programMap)) {
      await pgClient.query(`INSERT INTO program (pgm_id, pgm_cd, pgm_name, active) VALUES ($1, $2, $3, true)`, [pgm.id, pgm.cd, pgm.name]);
    }
    console.log('  4 programs.');
    
    // Step 4: Locations
    console.log('\n=== Step 4: Importing locations ===');
    const allLocIds = [...new Set(Object.values(locsByProgram).flat())];
    const locResult = await oraConn.execute(
      `SELECT loc_id, description, display_name, active, geoloc FROM GLOBALEYE.LOCATION WHERE loc_id IN (${allLocIds.join(',')})`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    for (const l of locResult.rows) {
      await pgClient.query(
        `INSERT INTO location (loc_id, description, display_name, active, geoloc) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [l.LOC_ID, l.DESCRIPTION, l.DISPLAY_NAME || l.DESCRIPTION || `Loc ${l.LOC_ID}`, l.ACTIVE === 'Y', l.GEOLOC]
      );
    }
    console.log(`  ${locResult.rows.length} locations.`);
    
    // Step 5: Loc_set
    console.log('\n=== Step 5: Importing loc_set ===');
    let setId = 1;
    for (const [setName, locs] of Object.entries(locsByProgram)) {
      const pgmId = programMap[setName].id;
      for (const locId of locs) {
        try {
          await pgClient.query(`INSERT INTO loc_set (set_id, set_name, pgm_id, loc_id, active) VALUES ($1, $2, $3, $4, true)`, [setId++, setName, pgmId, locId]);
        } catch { }
      }
    }
    console.log(`  ${setId - 1} mappings.`);
    
    // Step 6: Get assets FIRST (we need to know which parts to import)
    console.log('\n=== Step 6: Fetching assets ===');
    const allAssets = [];
    const partnoIdsNeeded = new Set();
    
    for (const [setName, locs] of Object.entries(locsByProgram)) {
      if (locs.length === 0) continue;
      const assetsResult = await oraConn.execute(
        `SELECT * FROM (
           SELECT asset_id, partno_id, serno, loc_ida, loc_idc, active, bad_actor, uii, mfg_date, accept_date, next_ndi_date, eti
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
      console.log(`  ${setName}: ${assetsResult.rows.length} assets`);
    }
    console.log(`  Total: ${allAssets.length} assets, ${partnoIdsNeeded.size} unique parts needed`);
    
    // Step 7: Import ONLY needed parts
    console.log('\n=== Step 7: Importing parts ===');
    const partnoIdArray = [...partnoIdsNeeded];
    let partsImported = 0;
    for (let i = 0; i < partnoIdArray.length; i += 500) {
      const chunk = partnoIdArray.slice(i, i + 500);
      const partsResult = await oraConn.execute(
        `SELECT partno_id, partno, nsn, noun, pgm_id, sys_type, active FROM GLOBALEYE.PART_LIST WHERE partno_id IN (${chunk.join(',')})`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      for (const p of partsResult.rows) {
        try {
          await pgClient.query(
            `INSERT INTO part_list (partno_id, partno, nsn, noun, pgm_id, sys_type, active) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
            [p.PARTNO_ID, p.PARTNO || 'UNKNOWN', p.NSN, p.NOUN, p.PGM_ID || 1, String(p.SYS_TYPE || ''), p.ACTIVE === 'Y']
          );
          partsImported++;
        } catch (e) { console.log('Part error:', e.message); }
      }
      process.stdout.write(`\r  Parts: ${partsImported}/${partnoIdsNeeded.size}`);
    }
    console.log(`\n  ${partsImported} parts imported.`);
    
    // Step 8: Import assets
    console.log('\n=== Step 8: Importing assets ===');
    const assetIds = [];
    for (const a of allAssets) {
      try {
        await pgClient.query(
          `INSERT INTO asset (asset_id, partno_id, serno, status_cd, loc_ida, loc_idc, active, bad_actor, uii, mfg_date, accept_date, next_ndi_date, eti)
           VALUES ($1, $2, $3, 'FMC', $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
          [a.ASSET_ID, a.PARTNO_ID, a.SERNO, a.LOC_IDA, a.LOC_IDC, a.ACTIVE === 'Y', a.BAD_ACTOR === 'Y', a.UII, a.MFG_DATE, a.ACCEPT_DATE, a.NEXT_NDI_DATE, a.ETI]
        );
        assetIds.push(a.ASSET_ID);
      } catch { }
    }
    console.log(`  ${assetIds.length} assets imported.`);
    
    // Step 9: Codes
    console.log('\n=== Step 9: Importing codes ===');
    const codesResult = await oraConn.execute(
      `SELECT code_id, code_type, code_value, description, active FROM GLOBALEYE.CODE WHERE active = 'Y' AND ROWNUM <= 500`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    for (const c of codesResult.rows) {
      try {
        await pgClient.query(
          `INSERT INTO code (code_id, code_type, code_value, description, active) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [c.CODE_ID, c.CODE_TYPE, c.CODE_VALUE, c.DESCRIPTION, c.ACTIVE === 'Y']
        );
      } catch { }
    }
    console.log(`  ${codesResult.rows.length} codes.`);
    
    // Step 10: Events (limited)
    console.log('\n=== Step 10: Importing events ===');
    let eventCount = 0;
    for (let i = 0; i < assetIds.length && eventCount < 15000; i += 500) {
      const chunk = assetIds.slice(i, i + 500);
      if (chunk.length === 0) break;
      const eventsResult = await oraConn.execute(
        `SELECT event_id, asset_id, event_type, discrepancy, how_mal, when_disc, loc_id, ins_by, ins_date, start_job, stop_job
         FROM GLOBALEYE.EVENT WHERE asset_id IN (${chunk.join(',')}) AND ROWNUM <= 3000`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      for (const e of eventsResult.rows) {
        try {
          await pgClient.query(
            `INSERT INTO event (event_id, asset_id, event_type, discrepancy, how_mal, when_disc, loc_id, ins_by, ins_date, start_job, stop_job)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
            [e.EVENT_ID, e.ASSET_ID, e.EVENT_TYPE, e.DISCREPANCY, e.HOW_MAL, e.WHEN_DISC, e.LOC_ID, e.INS_BY, e.INS_DATE, e.START_JOB, e.STOP_JOB]
          );
          eventCount++;
        } catch { }
      }
      process.stdout.write(`\r  Events: ${eventCount}`);
    }
    console.log(`\n  ${eventCount} events.`);
    
    // Step 11: Repairs (limited)
    console.log('\n=== Step 11: Importing repairs ===');
    let repairCount = 0;
    for (let i = 0; i < assetIds.length && repairCount < 10000; i += 500) {
      const chunk = assetIds.slice(i, i + 500);
      if (chunk.length === 0) break;
      const result = await oraConn.execute(
        `SELECT repair_id, event_id, asset_id, start_date, stop_date, type_maint, how_mal, when_disc, ins_by
         FROM GLOBALEYE.REPAIR WHERE asset_id IN (${chunk.join(',')}) AND ROWNUM <= 2000`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      for (const r of result.rows) {
        try {
          await pgClient.query(
            `INSERT INTO repair (repair_id, event_id, asset_id, start_date, stop_date, type_maint, how_mal, when_disc, ins_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
            [r.REPAIR_ID, r.EVENT_ID, r.ASSET_ID, r.START_DATE, r.STOP_DATE, r.TYPE_MAINT, r.HOW_MAL, r.WHEN_DISC, r.INS_BY]
          );
          repairCount++;
        } catch { }
      }
      process.stdout.write(`\r  Repairs: ${repairCount}`);
    }
    console.log(`\n  ${repairCount} repairs.`);
    
    // Step 12: Users
    console.log('\n=== Step 12: Creating users ===');
    const bcrypt = await import('bcryptjs');
    const pwHash = await bcrypt.hash('admin123', 10);
    for (const [id, username, email, first, last, role] of [
      [1, 'admin', 'admin@rimss.mil', 'Admin', 'User', 'ADMIN'],
      [2, 'viewer', 'viewer@rimss.mil', 'Viewer', 'User', 'VIEWER'],
      [3, 'field_tech', 'field@rimss.mil', 'Field', 'Tech', 'FIELD_TECHNICIAN'],
      [4, 'depot_mgr', 'depot@rimss.mil', 'Depot', 'Manager', 'DEPOT_MANAGER'],
      [5, 'shop', 'shop@rimss.mil', 'Shop', 'User', 'SHOP'],
    ]) {
      await pgClient.query(
        `INSERT INTO users (user_id, username, password_hash, email, first_name, last_name, role) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [id, username, pwHash, email, first, last, role]
      );
    }
    console.log('  5 users.');
    
    console.log('\n✅ IMPORT COMPLETE!');
    console.log(`   Assets: ${assetIds.length}`);
    console.log(`   Parts: ${partsImported}`);
    console.log(`   Events: ${eventCount}`);
    console.log(`   Repairs: ${repairCount}`);
    
  } catch (err) {
    console.error('Error:', err);
  } finally {
    if (oraConn) await oraConn.close();
    if (pgClient) await pgClient.end();
  }
}

main();
