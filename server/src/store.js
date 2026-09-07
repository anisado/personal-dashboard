import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY_DB = {
  tasks: [],
  notes: [],
  snippets: [],
  bookmarks: [],
  environments: []
};

let db = null;
let writeQueue = Promise.resolve();

async function load() {
  if (db) return db;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    db = { ...structuredClone(EMPTY_DB), ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    db = structuredClone(EMPTY_DB);
    await persist();
  }
  return db;
}

function persist() {
  writeQueue = writeQueue.then(() =>
    fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), 'utf8')
  );
  return writeQueue;
}

export async function list(collection) {
  const data = await load();
  return data[collection];
}

export async function create(collection, payload) {
  const data = await load();
  const now = new Date().toISOString();
  const item = { id: randomUUID(), createdAt: now, updatedAt: now, ...payload };
  data[collection].unshift(item);
  await persist();
  return item;
}

export async function update(collection, id, payload) {
  const data = await load();
  const item = data[collection].find((entry) => entry.id === id);
  if (!item) return null;
  Object.assign(item, payload, { id: item.id, updatedAt: new Date().toISOString() });
  await persist();
  return item;
}

export async function remove(collection, id) {
  const data = await load();
  const index = data[collection].findIndex((entry) => entry.id === id);
  if (index === -1) return false;
  data[collection].splice(index, 1);
  await persist();
  return true;
}

export async function stats() {
  const data = await load();
  return {
    tasks: {
      total: data.tasks.length,
      done: data.tasks.filter((task) => task.done).length,
      overdue: data.tasks.filter(
        (task) => !task.done && task.dueDate && new Date(task.dueDate) < new Date()
      ).length
    },
    notes: data.notes.length,
    snippets: data.snippets.length,
    bookmarks: data.bookmarks.length,
    environments: data.environments.length
  };
}
