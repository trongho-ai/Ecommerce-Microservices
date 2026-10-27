try {
  rs.status();
} catch (error) {
  if (error.codeName !== 'NotYetInitialized') throw error;
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'product-db:27017' }] });
}
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  if (db.hello().isWritablePrimary) { ready = true; break; }
  sleep(1000);
}
if (!ready) throw new Error('Product replica set did not elect a primary');
print('Product replica set is ready');
