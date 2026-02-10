import oracledb from 'oracledb';

const config = {
  user: 'sys',
  password: 'Rampod99',
  connectString: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=uhhy-db-300vdev.rampod.net)(PORT=1521))(CONNECT_DATA=(SID=rampdb)))',
  privilege: oracledb.SYSDBA
};

async function main() {
  let connection;
  try {
    console.log('Connecting...');
    connection = await oracledb.getConnection(config);
    
    // Check LOC_SET table (program to location mapping)
    console.log('--- GLOBALEYE.LOC_SET columns ---');
    let result = await connection.execute(
      `SELECT column_name, data_type FROM all_tab_columns 
       WHERE owner = 'GLOBALEYE' AND table_name = 'LOC_SET' 
       ORDER BY column_id`
    );
    for (const row of result.rows) {
      console.log(`  ${row[0]}: ${row[1]}`);
    }
    
    // Sample loc_set data
    console.log('\n--- Sample LOC_SET data ---');
    result = await connection.execute(
      `SELECT * FROM GLOBALEYE.LOC_SET WHERE ROWNUM <= 10`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    for (const row of result.rows) {
      console.log(JSON.stringify(row));
    }
    
    // Check distinct set names (probably programs)
    console.log('\n--- Distinct SET_NAMEs in LOC_SET ---');
    result = await connection.execute(
      `SELECT DISTINCT set_name, COUNT(*) as loc_count FROM GLOBALEYE.LOC_SET GROUP BY set_name ORDER BY set_name`
    );
    for (const row of result.rows) {
      console.log(`  ${row[0]}: ${row[1]} locations`);
    }
    
    // Check PART_LIST columns
    console.log('\n--- GLOBALEYE.PART_LIST columns ---');
    result = await connection.execute(
      `SELECT column_name, data_type FROM all_tab_columns 
       WHERE owner = 'GLOBALEYE' AND table_name = 'PART_LIST' 
       ORDER BY column_id`
    );
    for (const row of result.rows) {
      console.log(`  ${row[0]}: ${row[1]}`);
    }
    
    // Sample part_list
    console.log('\n--- Sample PART_LIST data ---');
    result = await connection.execute(
      `SELECT partno_id, partno, nsn, noun FROM GLOBALEYE.PART_LIST WHERE ROWNUM <= 5`
    );
    for (const row of result.rows) {
      console.log(`  ${row.join(' | ')}`);
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    if (connection) await connection.close();
  }
}

main();
