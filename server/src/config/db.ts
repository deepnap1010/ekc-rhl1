// server/src/config/db.ts
import mongoose from 'mongoose';
import { env } from './env.js';
import { errMessage } from '../utils/http.js';

export async function connectDB(): Promise<void> {
  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(env.mongoUri, {
      dbName: env.dbName,       // force the real DB (`test`) regardless of URI path
      maxPoolSize: 20,          // connection pool for concurrent reads
      minPoolSize: 2,
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 45000,
    });
    console.log(`[db] MongoDB connected → db "${mongoose.connection.name}"`);
  } catch (err) {
    console.error('[db] connection failed:', errMessage(err));
    process.exit(1);
  }

  mongoose.connection.on('disconnected', () => console.warn('[db] disconnected'));
  mongoose.connection.on('reconnected', () => console.log('[db] reconnected'));
}

export async function disconnectDB(): Promise<void> {
  await mongoose.connection.close();
  console.log('[db] connection closed');
}
