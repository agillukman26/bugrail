// server/.env first, then repo-root .env (first file wins per key).
require('dotenv').config({ path: [require('path').join(__dirname, '.env'), require('path').join(__dirname, '..', '.env')] });
const { app } = require('./app');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`BugRail storage API listening on http://localhost:${PORT}`));
