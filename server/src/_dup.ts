import { connectDB, disconnectDB } from './config/db.js';
import { Telemetry } from './models/Telemetry.js';
await connectDB();
const since = new Date(Date.now() - 24 * 3600_000);
const codes = ['SPG02', 'SPG03', 'SPG04', 'ISB01', 'ISB02', 'BOTTOMMILLING03', 'BOTTOMMILLING04', 'CUTTINGMACHINE07'];
console.log('machine                 readings  identical-to-previous   what that means');
for (const code of codes) {
  const rows = await Telemetry.find({ machineId: code, timestamp: { $gte: since } })
    .select({ timestamp: 1, data: 1 }).sort({ timestamp: 1 }).lean();
  let dup = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if (JSON.stringify(rows[i].data) === JSON.stringify(rows[i - 1].data)) dup += 1;
  }
  const pct = rows.length > 1 ? Math.round((dup / (rows.length - 1)) * 100) : 0;
  console.log(code.padEnd(22), String(rows.length).padStart(7), String(dup).padStart(9) + ` (${String(pct).padStart(3)}%)`,
    '  ', pct > 50 ? 'sends on a TIMER (repeats itself)' : 'mostly changing values');
}
await disconnectDB();
