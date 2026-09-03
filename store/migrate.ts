import { migrate, getDb } from './db.js';

const d = migrate(getDb());
const tables = d
  .prepare("select name from sqlite_master where type='table' order by name")
  .all() as { name: string }[];
console.log('migrated:', tables.map((t) => t.name).join(', '));
