const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const dbPath = path.join(__dirname, "..", "survey-data.json");
const dbProvider = String(process.env.DB_PROVIDER || "json").toLowerCase();
const databaseUrl = process.env.DATABASE_URL;

const emptyDb = {
  templates: [],
  templateQuestions: [],
  companies: [],
  surveys: [],
  surveyQuestions: [],
  recipients: [],
  drafts: [],
  submissions: [],
  submissionAnswers: [],
  counters: {
    templates: 0,
    templateQuestions: 0,
    companies: 0,
    surveys: 0,
    surveyQuestions: 0,
    recipients: 0,
    drafts: 0,
    submissions: 0,
    submissionAnswers: 0,
  },
};

let pgPool = null;
let state = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDbFile() {
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(emptyDb, null, 2), "utf8");
  }
}

function load() {
  return clone(state);
}

function save(data) {
  state = clone(data);

  if (dbProvider === "postgres") {
    if (!pgPool) {
      throw new Error("Postgres pool is not initialized");
    }

    return pgPool.query(
      `INSERT INTO app_state (id, payload, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [JSON.stringify(state)]
    );
  }

  fs.writeFileSync(dbPath, JSON.stringify(state, null, 2), "utf8");
  return Promise.resolve();
}

function nextId(data, key) {
  data.counters[key] += 1;
  return data.counters[key];
}

async function init() {
  if (dbProvider === "postgres") {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when DB_PROVIDER=postgres");
    }

    pgPool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
    });

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const existing = await pgPool.query("SELECT payload FROM app_state WHERE id = 1");
    if (!existing.rows.length) {
      state = clone(emptyDb);
      await save(state);
    } else {
      state = existing.rows[0].payload;
    }
    return;
  }

  ensureDbFile();
  const text = fs.readFileSync(dbPath, "utf8");
  state = JSON.parse(text);
}

module.exports = {
  init,
  load,
  save,
  nextId,
  provider: dbProvider,
};
