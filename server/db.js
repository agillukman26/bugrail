// server/.env first, then repo-root .env (first file wins per key).
require('dotenv').config({ path: [require('path').join(__dirname, '.env'), require('path').join(__dirname, '..', '.env')] });
const { MongoClient } = require('mongodb');
const dns = require('dns');

// Some Windows setups hand Node only 127.0.0.1 as DNS server (nothing listens
// there), so the mongodb+srv:// lookup dies with "querySrv ECONNREFUSED".
// Fall back to public resolvers in that case only.
if (process.platform === 'win32' && dns.getServers().every(s => s.startsWith('127.') || s === '::1')){
  dns.setServers(['1.1.1.1', '8.8.8.8']);
}

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'bugrail';

const client = new MongoClient(uri, { connectTimeoutMS: 5000 });
let dbPromise = null;

function getDb(){
  if (!dbPromise){
    dbPromise = client.connect().then(() => client.db(dbName));
    dbPromise.catch(() => { dbPromise = null; }); // let the next call retry instead of staying stuck on a dead connection
  }
  return dbPromise;
}

module.exports = { getDb };
