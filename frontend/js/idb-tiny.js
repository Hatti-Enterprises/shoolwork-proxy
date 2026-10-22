/* Tiny promise wrapper around IndexedDB — under 50 lines, no deps.
 * Mimics the idb library's API surface so extensions.js can stay clean.
 */

export function openDB(name, version, { upgrade } = {}) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (upgrade) upgrade(db, e.oldVersion, e.newVersion, e.target.transaction);
    };
    req.onsuccess = () => resolve(wrapDB(req.result));
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function wrapDB(db) {
  return {
    name: db.name,
    version: db.version,
    objectStoreNames: db.objectStoreNames,
    transaction: (stores, mode = 'readonly') => {
      const tx = db.transaction(stores, mode);
      return wrapTx(tx);
    },
    get: (store, key) => tx(db, store, 'readonly', s => s.get(key)),
    put: (store, value, key) => tx(db, store, 'readwrite', s => key !== undefined ? s.put(value, key) : s.put(value)),
    delete: (store, key) => tx(db, store, 'readwrite', s => s.delete(key)),
    getAll: (store, query) => tx(db, store, 'readonly', s => s.getAll(query)),
    clear: (store) => tx(db, store, 'readwrite', s => s.clear()),
    close: () => db.close(),
  };
}

function wrapTx(tx) {
  return {
    store: tx.objectStoreNames.length ? wrapStore(tx.objectStore(tx.objectStoreNames[0])) : null,
    objectStore: (name) => wrapStore(tx.objectStore(name)),
    done: new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    }),
    abort: () => tx.abort(),
  };
}

function wrapStore(store) {
  return {
    get: (key) => req(store.get(key)),
    getAll: (query) => req(store.getAll(query)),
    getAllKeys: (query) => req(store.getAllKeys(query)),
    put: (value, key) => req(key !== undefined ? store.put(value, key) : store.put(value)),
    add: (value, key) => req(key !== undefined ? store.add(value, key) : store.add(value)),
    delete: (key) => req(store.delete(key)),
    clear: () => req(store.clear()),
    count: () => req(store.count()),
    index: (name) => wrapIndex(store.index(name)),
    openCursor: (query, direction) => cursorReq(store.openCursor(query, direction)),
  };
}

function wrapIndex(index) {
  return {
    get: (key) => req(index.get(key)),
    getAll: (query) => req(index.getAll(query)),
    openCursor: (query, direction) => cursorReq(index.openCursor(query, direction)),
  };
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function cursorReq(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => {
      const cursor = r.result;
      if (!cursor) return resolve(null);
      resolve({
        key: cursor.key,
        value: cursor.value,
        continue: () => cursor.continue(),
        delete: () => req(cursor.delete()),
        update: (val) => req(cursor.update(val)),
      });
    };
    r.onerror = () => reject(r.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(reqResult(req));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Aborted'));
    function reqResult(r) {
      if (!r || typeof r.onsuccess === 'undefined') return r;
      return r.result;
    }
  });
}
