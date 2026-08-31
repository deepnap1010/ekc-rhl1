import 'dotenv/config';
import mongoose from 'mongoose';
async function main() {
  await mongoose.connect(process.env.MONGO_URI!);
  const t = mongoose.connection.db!.collection('telemetries');
  const rows = await t.aggregate([
    { $group: {
      _id: { $dateToString: { date: '$timestamp', format: '%Y-%m-%d', timezone: 'Asia/Kolkata' } },
      n: { $sum: 1 },
      lo: { $min: '$timestamp' }, hi: { $max: '$timestamp' },
    } },
  ]).toArray();
  rows.sort((a, b) => String(a._id).localeCompare(String(b._id)));
  console.log('IST day      docs      first(IST)          last(IST)');
  const ist = (d: Date) => new Date(+d + 5.5 * 3600e3).toISOString().slice(11, 19);
  for (const r of rows) {
    console.log(`${r._id}  ${String(r.n).padStart(7)}   ${ist(r.lo)}            ${ist(r.hi)}`);
  }
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
