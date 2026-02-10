import oracledb from 'oracledb';

// Try with SID syntax instead of service name
const config = {
  user: 'sys',
  password: 'Rampod99',
  connectString: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=uhhy-db-300vdev.rampod.net)(PORT=1521))(CONNECT_DATA=(SID=rampdb)))',
  privilege: oracledb.SYSDBA
};

async function main() {
  let connection;
  try {
    console.log('Connecting to Oracle (SID mode)...');
    connection = await oracledb.getConnection(config);
    console.log('Connected!');
    
    // List schemas/tables
    const result = await connection.execute(
      `SELECT owner, table_name FROM all_tables 
       WHERE UPPER(owner) IN ('CORE_TABLES', 'GLOBALEYE') 
       ORDER BY owner, table_name`
    );
    console.log('\nTables found:');
    for (const row of result.rows) {
      console.log(`  ${row[0]}.${row[1]}`);
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

main();
