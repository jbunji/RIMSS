/**
 * Map Oracle pgm_id to our 4 programs by looking at which parts are used at which locations
 */
import oracledb from 'oracledb';

const ORACLE_CONFIG = {
  user: 'sys',
  password: 'Rampod99',
  connectString: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=uhhy-db-300vdev.rampod.net)(PORT=1521))(CONNECT_DATA=(SID=rampdb)))',
  privilege: oracledb.SYSDBA
};

async function main() {
  let conn;
  try {
    console.log('Connecting to Oracle...');
    conn = await oracledb.getConnection(ORACLE_CONFIG);
    console.log('Connected!\n');
    
    const programs = ['ACTS_LOC', 'ARDS_LOC', 'CRIIS_LOC', '236_LOC'];
    
    for (const pgmName of programs) {
      console.log(`\n=== ${pgmName} ===`);
      
      // Get locations for this program
      const locsResult = await conn.execute(
        `SELECT loc_id FROM GLOBALEYE.LOC_SET WHERE set_name = :pgm AND active = 'Y'`,
        { pgm: pgmName }
      );
      const locIds = locsResult.rows.map(r => r[0]);
      
      if (locIds.length === 0) {
        console.log('  No locations found');
        continue;
      }
      
      console.log(`  ${locIds.length} locations`);
      
      // Get distinct pgm_id values for parts used by assets at these locations
      const result = await conn.execute(
        `SELECT p.pgm_id, COUNT(DISTINCT a.asset_id) as asset_count, COUNT(DISTINCT p.partno_id) as part_count
         FROM GLOBALEYE.ASSET a
         JOIN GLOBALEYE.PART_LIST p ON a.partno_id = p.partno_id
         WHERE a.loc_ida IN (${locIds.join(',')})
         GROUP BY p.pgm_id
         ORDER BY asset_count DESC`,
        []
      );
      
      console.log('  Oracle pgm_id | assets | parts');
      for (const row of result.rows) {
        console.log(`    ${row[0]} | ${row[1]} | ${row[2]}`);
      }
    }
    
  } catch (err) {
    console.error('Error:', err);
  } finally {
    if (conn) await conn.close();
  }
}

main();
