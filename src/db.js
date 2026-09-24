// IndexedDB によるエディタ永続化ストレージ
const DB_NAME = "SpectrogramAppDB";
const DB_VERSION = 1;
const STORE_EDITORS = "editors";
const STORE_META = "metadata";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_EDITORS)) {
        db.createObjectStore(STORE_EDITORS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveEditorToStorage(editorData) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_EDITORS], "readwrite");
    const store = tx.objectStore(STORE_EDITORS);
    store.put(editorData);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteEditorFromStorage(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_EDITORS], "readwrite");
    const store = tx.objectStore(STORE_EDITORS);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAllEditorsFromStorage() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_EDITORS], "readonly");
    const store = tx.objectStore(STORE_EDITORS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function saveActiveEditorId(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META], "readwrite");
    const store = tx.objectStore(STORE_META);
    store.put({ key: "activeEditorId", value: id });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getActiveEditorId() {
  const db = await openDatabase();
  return new Promise((resolve) => {
    const tx = db.transaction([STORE_META], "readonly");
    const store = tx.objectStore(STORE_META);
    const req = store.get("activeEditorId");
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => resolve(null);
  });
}