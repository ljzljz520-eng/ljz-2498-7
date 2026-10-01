import path from 'node:path';
import { RelationalDatabase } from './relational.js';
import { schema } from './schema.js';

let singleton;

export function databaseLocation() {
  return process.env.CAMPAIGN_DB || path.resolve('data/campaigns.json');
}

export function getDatabase(file = databaseLocation()) {
  singleton ??= new RelationalDatabase(file, schema);
  return singleton;
}

export function resetDatabaseForTests(file) {
  singleton = new RelationalDatabase(file, schema);
  return singleton;
}
