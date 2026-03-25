'use client';

import { openDB, type IDBPDatabase } from 'idb';
import type { Session } from '@/types/session';

const DB_NAME = 'qa-tool-db';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

type QAToolDB = {
  sessions: {
    key: string;
    value: Session;
    indexes: { updatedAt: number };
  };
};

let dbPromise: Promise<IDBPDatabase<QAToolDB>> | null = null;

function getDB(): Promise<IDBPDatabase<QAToolDB>> {
  if (!dbPromise) {
    dbPromise = openDB<QAToolDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      },
    });
  }
  return dbPromise;
}

export async function getAllSessions(): Promise<Session[]> {
  const db = await getDB();
  const sessions = await db.getAll(STORE_NAME);
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getSession(id: string): Promise<Session | undefined> {
  const db = await getDB();
  return db.get(STORE_NAME, id);
}

export async function saveSession(session: Session): Promise<void> {
  const db = await getDB();
  await db.put(STORE_NAME, session);
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_NAME, id);
}

export async function clearAllSessions(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE_NAME);
}
