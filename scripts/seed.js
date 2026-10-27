import pg from 'pg';
import { MongoClient } from 'mongodb';
import { pathToFileURL } from 'node:url';
import { seedAuth } from '../services/auth-service/src/infrastructure/seed.js';
import { DEMO_ACCOUNTS } from './fixtures.js';
import { createClient, request } from '../shared/grpc.js';

export async function seed({ quiet = false } = {}) {
  const auth = new pg.Pool({ connectionString: process.env.AUTH_DATABASE_URL });
  const customer = createClient('customer', 'CustomerService', process.env.CUSTOMER_GRPC || 'customer-service:50051');
  const productClient = new MongoClient(process.env.PRODUCT_MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  try {
    const accounts = await seedAuth(auth, [
      { ...DEMO_ACCOUNTS.admin, fullname: 'Demo Admin', role: 'ADMIN' },
      { ...DEMO_ACCOUNTS.customer, fullname: 'Demo Customer', role: 'CUSTOMER' },
      { ...DEMO_ACCOUNTS.staff, fullname: 'Demo Shipment Staff', role: 'SHIPMENT_STAFF' },
    ]);
    for (const account of accounts) {
      await request(customer, 'EnsureCustomer', { uid: account.uid, fullname: account.username }, { uid: account.uid, role: 'SYSTEM' });
      if (account.created && account.role === 'CUSTOMER') await request(customer, 'UpdateCustomer', { uid: account.uid, mid: 3 }, { uid: accounts[0].uid, role: 'ADMIN' });
    }
    await productClient.connect();
    const db = productClient.db('product');
    await db.collection('products').createIndex({ demoKey: 1 }, { unique: true, sparse: true });
    for (const sample of [{ demoKey: 'demo-laptop', pname: 'Laptop', price: '1500.00', quantity: 50 }, { demoKey: 'demo-book', pname: 'Book', price: '25.00', quantity: 100 }]) {
      if (await db.collection('products').findOne({ demoKey: sample.demoKey })) continue;
      const counter = await db.collection('counters').findOneAndUpdate({ _id: 'product' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' });
      await db.collection('products').updateOne({ demoKey: sample.demoKey }, { $setOnInsert: { pid: counter.value, ...sample, deleted: false, createdAt: new Date() } }, { upsert: true });
    }
    if (!quiet) console.log(JSON.stringify({ status: 'SEEDED', accounts: accounts.map(({ uid, username, role }) => ({ uid, username, role })), memberships: 'Basic=0, Silver=100, Gold=500 (demo data)', products: await db.collection('products').countDocuments({ demoKey: { $exists: true } }), message: 'Existing accounts and product values preserved; no passwords printed' }));
    return accounts;
  } finally { customer.close(); await auth.end(); await productClient.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await seed();
