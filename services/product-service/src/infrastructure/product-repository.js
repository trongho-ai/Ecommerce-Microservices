import { MongoClient } from 'mongodb';
import { AppError, fail } from '../../../../shared/errors.js';

function productView(document) {
  if (!document) return null;
  return { pid: document.pid, pname: document.pname, price: document.price, quantity: document.quantity };
}

function operationView(document) {
  return { operationId: document._id, state: document.state, items: document.items || [] };
}

export class ProductRepository {
  constructor(client, database) {
    this.client = client;
    this.db = database;
    this.products = database.collection('products');
    this.operations = database.collection('inventory_operations');
    this.counters = database.collection('counters');
  }

  async initialize() {
    await this.products.createIndex({ pid: 1 }, { unique: true });
    await this.products.createIndex({ deleted: 1, pid: 1 });
    await this.operations.createIndex({ createdAt: 1 });
  }

  async health() {
    const hello = await this.db.admin().command({ hello: 1 });
    if (!hello.setName || !hello.isWritablePrimary) fail(503, 'Product database must be a writable replica-set primary');
    await this.db.command({ ping: 1 });
  }

  async list() {
    return (await this.products.find({ deleted: { $ne: true } }).sort({ pid: 1 }).toArray()).map(productView);
  }

  async get(pid) {
    const document = await this.products.findOne({ pid, deleted: { $ne: true } });
    if (!document) fail(404, 'Product not found');
    return productView(document);
  }

  async create(input) {
    const counter = await this.counters.findOneAndUpdate(
      { _id: 'product' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' },
    );
    if (counter.value > 2147483647) fail(409, 'Product identifiers exhausted');
    const document = { pid: counter.value, ...input, deleted: false, createdAt: new Date(), updatedAt: new Date() };
    await this.products.insertOne(document);
    return productView(document);
  }

  async update(pid, changes) {
    const document = await this.products.findOneAndUpdate(
      { pid, deleted: { $ne: true } }, { $set: { ...changes, updatedAt: new Date() } }, { returnDocument: 'after' },
    );
    if (!document) fail(404, 'Product not found');
    return productView(document);
  }

  async remove(pid) {
    // Retain the stock document for compensation of a previously applied operation.
    const document = await this.products.findOneAndUpdate(
      { pid, deleted: { $ne: true } }, { $set: { deleted: true, updatedAt: new Date() } }, { returnDocument: 'after' },
    );
    if (!document) fail(404, 'Product not found');
    return productView(document);
  }

  async transaction(work) {
    // The driver retries transaction conflicts/unknown commit results. Duplicate-key
    // races on a new operationId need a fresh transaction to read the winner.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const session = this.client.startSession();
      try {
        return await session.withTransaction(() => work(session), {
          readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
          readPreference: 'primary', maxCommitTimeMS: 5000,
        });
      } catch (error) {
        if (error.code === 11000 && attempt < 4) continue;
        if (error instanceof AppError) throw error;
        if (error.code === 11000) fail(409, 'Inventory operation is being processed; retry with the same operationId');
        throw error;
      } finally {
        await session.endSession();
      }
    }
  }

  async apply(operationId, items, fingerprint) {
    return this.transaction(async session => {
      const existing = await this.operations.findOne({ _id: operationId }, { session });
      if (existing) {
        if (existing.state === 'CANCELLED') fail(409, 'Inventory operation was cancelled', 'INVENTORY_CANCELLED');
        if (existing.fingerprint !== fingerprint) fail(409, 'operationId already used with different items', 'OPERATION_MISMATCH');
        return operationView(existing);
      }
      // Insert the receipt first: competing Apply/Cancel transactions conflict here.
      await this.operations.insertOne({ _id: operationId, state: 'APPLYING', fingerprint, items: [], createdAt: new Date() }, { session });
      const snapshots = [];
      for (const item of items) {
        const product = await this.products.findOneAndUpdate(
          { pid: item.pid, quantity: { $gte: item.qty }, deleted: { $ne: true } },
          { $inc: { quantity: -item.qty }, $set: { updatedAt: new Date() } },
          { session, returnDocument: 'before' },
        );
        if (!product) {
          const exists = await this.products.findOne({ pid: item.pid, deleted: { $ne: true } }, { session });
          if (!exists) fail(404, `Product ${item.pid} not found`);
          fail(409, `Insufficient stock for product ${item.pid}`, 'INSUFFICIENT_STOCK');
        }
        snapshots.push({ pid: item.pid, qty: item.qty, unit_price: product.price });
      }
      await this.operations.updateOne({ _id: operationId }, { $set: { state: 'APPLIED', items: snapshots, updatedAt: new Date() } }, { session });
      return { operationId, state: 'APPLIED', items: snapshots };
    });
  }

  async getOperation(operationId) {
    const operation = await this.operations.findOne({ _id: operationId });
    if (!operation) fail(404, 'Inventory operation not found');
    return operationView(operation);
  }

  async cancel(operationId) {
    return this.transaction(async session => {
      const operation = await this.operations.findOne({ _id: operationId }, { session });
      if (!operation) {
        // Tombstone prevents an Apply RPC delayed in transit from subtracting later.
        const tombstone = { _id: operationId, state: 'CANCELLED', items: [], createdAt: new Date(), updatedAt: new Date() };
        await this.operations.insertOne(tombstone, { session });
        return operationView(tombstone);
      }
      if (operation.state === 'CANCELLED') return operationView(operation);
      if (operation.state !== 'APPLIED') fail(409, 'Inventory operation is not ready for cancellation');
      for (const item of operation.items) {
        const updated = await this.products.updateOne(
          { pid: item.pid, quantity: { $lte: 2147483647 - item.qty } },
          { $inc: { quantity: item.qty }, $set: { updatedAt: new Date() } }, { session },
        );
        if (updated.matchedCount !== 1) fail(503, `Cannot compensate product ${item.pid}; operation remains pending`);
      }
      await this.operations.updateOne({ _id: operationId }, { $set: { state: 'CANCELLED', updatedAt: new Date() } }, { session });
      return { operationId, state: 'CANCELLED', items: operation.items };
    });
  }
}

export async function connectProductRepository() {
  const client = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  const repository = new ProductRepository(client, client.db(process.env.MONGO_DATABASE || 'product'));
  await repository.initialize();
  await repository.health();
  return repository;
}
