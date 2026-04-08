const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const mysql = require("mysql2/promise");

const dbPath = path.join(__dirname, "..", "survey-data.json");
const dbProvider = String(process.env.DB_PROVIDER || "json").toLowerCase();
const databaseUrl = process.env.DATABASE_URL;
const mysqlHost = process.env.MYSQL_HOST || "localhost";
const mysqlPort = parseInt(process.env.MYSQL_PORT || "3306");
const mysqlUser = process.env.MYSQL_USER || "survey";
const mysqlPassword = process.env.MYSQL_PASSWORD || "survey123";
const mysqlDatabase = process.env.MYSQL_DATABASE || "survey";

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
let mysqlPool = null;
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

async function save(data) {
  state = clone(data);

  if (dbProvider === "mysql") {
    if (!mysqlPool) {
      throw new Error("MySQL pool is not initialized");
    }

    const conn = await mysqlPool.getConnection();
    try {
      await conn.beginTransaction();

      // Save templates
      for (const template of state.templates) {
        await conn.query(
          `INSERT INTO templates (id, name, description, createdAt) VALUES (?, ?, ?, ?) 
           ON DUPLICATE KEY UPDATE name=?, description=?, createdAt=?`,
          [template.id, template.name, template.description, template.createdAt,
           template.name, template.description, template.createdAt]
        );
      }

      // Save templateQuestions
      for (const tq of state.templateQuestions) {
        await conn.query(
          `INSERT INTO templateQuestions (id, templateId, type, title, required, options, section, sortOrder) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE templateId=?, type=?, title=?, required=?, options=?, section=?, sortOrder=?`,
          [tq.id, tq.templateId, tq.type, tq.title, tq.required, JSON.stringify(tq.options), tq.section, tq.sortOrder,
           tq.templateId, tq.type, tq.title, tq.required, JSON.stringify(tq.options), tq.section, tq.sortOrder]
        );
      }

      // Save companies
      for (const company of state.companies) {
        await conn.query(
          `INSERT INTO companies (id, name, createdAt) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE name=?, createdAt=?`,
          [company.id, company.name, company.createdAt, company.name, company.createdAt]
        );
      }

      // Save surveys
      for (const survey of state.surveys) {
        await conn.query(
          `INSERT INTO surveys (id, companyId, templateId, title, status, sections, setup, createdAt) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE companyId=?, templateId=?, title=?, status=?, sections=?, setup=?, createdAt=?`,
          [survey.id, survey.companyId, survey.templateId, survey.title, survey.status, 
           JSON.stringify(survey.sections), JSON.stringify(survey.setup), survey.createdAt,
           survey.companyId, survey.templateId, survey.title, survey.status,
           JSON.stringify(survey.sections), JSON.stringify(survey.setup), survey.createdAt]
        );
      }

      // Save surveyQuestions
      for (const sq of state.surveyQuestions) {
        await conn.query(
          `INSERT INTO surveyQuestions (id, surveyId, templateQuestionId, type, title, required, options, section, sortOrder)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE surveyId=?, templateQuestionId=?, type=?, title=?, required=?, options=?, section=?, sortOrder=?`,
          [sq.id, sq.surveyId, sq.templateQuestionId, sq.type, sq.title, sq.required, JSON.stringify(sq.options), sq.section, sq.sortOrder,
           sq.surveyId, sq.templateQuestionId, sq.type, sq.title, sq.required, JSON.stringify(sq.options), sq.section, sq.sortOrder]
        );
      }

      // Save recipients
      for (const recipient of state.recipients) {
        await conn.query(
          `INSERT INTO recipients (id, surveyId, email, sent, sentAt, completedAt, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE surveyId=?, email=?, sent=?, sentAt=?, completedAt=?, createdAt=?`,
          [recipient.id, recipient.surveyId, recipient.email, recipient.sent, recipient.sentAt, recipient.completedAt, recipient.createdAt,
           recipient.surveyId, recipient.email, recipient.sent, recipient.sentAt, recipient.completedAt, recipient.createdAt]
        );
      }

      // Save drafts
      for (const draft of state.drafts) {
        await conn.query(
          `INSERT INTO drafts (id, surveyId, email, progress, progressPercentage, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE surveyId=?, email=?, progress=?, progressPercentage=?, createdAt=?, updatedAt=?`,
          [draft.id, draft.surveyId, draft.email, JSON.stringify(draft.progress), draft.progressPercentage, draft.createdAt, draft.updatedAt,
           draft.surveyId, draft.email, JSON.stringify(draft.progress), draft.progressPercentage, draft.createdAt, draft.updatedAt]
        );
      }

      // Save submissions
      for (const submission of state.submissions) {
        await conn.query(
          `INSERT INTO submissions (id, surveyId, email, anonymous, createdAt)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE surveyId=?, email=?, anonymous=?, createdAt=?`,
          [submission.id, submission.surveyId, submission.email, submission.anonymous, submission.createdAt,
           submission.surveyId, submission.email, submission.anonymous, submission.createdAt]
        );
      }

      // Save submissionAnswers
      for (const sa of state.submissionAnswers) {
        await conn.query(
          `INSERT INTO submissionAnswers (id, submissionId, surveyQuestionId, answer, createdAt)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE submissionId=?, surveyQuestionId=?, answer=?, createdAt=?`,
          [sa.id, sa.submissionId, sa.surveyQuestionId, sa.answer, sa.createdAt,
           sa.submissionId, sa.surveyQuestionId, sa.answer, sa.createdAt]
        );
      }

      // Save counters
      for (const [key, value] of Object.entries(state.counters)) {
        await conn.query(
          `INSERT INTO counters (keyName, value) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE value=?`,
          [key, value, value]
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    return;
  }

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

async function loadFromMySQL(conn) {
  const data = clone(emptyDb);

  const [templates] = await conn.query("SELECT * FROM templates");
  data.templates = templates;

  const [templateQuestions] = await conn.query("SELECT * FROM templateQuestions");
  data.templateQuestions = templateQuestions.map(tq => ({
    ...tq,
    options: typeof tq.options === 'string' ? JSON.parse(tq.options) : tq.options
  }));

  const [companies] = await conn.query("SELECT * FROM companies");
  data.companies = companies;

  const [surveys] = await conn.query("SELECT * FROM surveys");
  data.surveys = surveys.map(s => ({
    ...s,
    sections: typeof s.sections === 'string' ? JSON.parse(s.sections) : s.sections,
    setup: typeof s.setup === 'string' ? JSON.parse(s.setup) : s.setup
  }));

  const [surveyQuestions] = await conn.query("SELECT * FROM surveyQuestions");
  data.surveyQuestions = surveyQuestions.map(sq => ({
    ...sq,
    options: typeof sq.options === 'string' ? JSON.parse(sq.options) : sq.options
  }));

  const [recipients] = await conn.query("SELECT * FROM recipients");
  data.recipients = recipients;

  const [drafts] = await conn.query("SELECT * FROM drafts");
  data.drafts = drafts.map(d => ({
    ...d,
    progress: typeof d.progress === 'string' ? JSON.parse(d.progress) : d.progress
  }));

  const [submissions] = await conn.query("SELECT * FROM submissions");
  data.submissions = submissions;

  const [submissionAnswers] = await conn.query("SELECT * FROM submissionAnswers");
  data.submissionAnswers = submissionAnswers;

  const [counterRows] = await conn.query("SELECT keyName, value FROM counters");
  data.counters = {};
  counterRows.forEach(row => {
    data.counters[row.keyName] = row.value;
  });

  return data;
}

async function init() {
  if (dbProvider === "mysql") {
    try {
      mysqlPool = await mysql.createPool({
        host: mysqlHost,
        port: mysqlPort,
        user: mysqlUser,
        password: mysqlPassword,
        database: mysqlDatabase,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
      });

      console.log("MySQL pool created, initializing schema...");

      const conn = await mysqlPool.getConnection();
      try {
        // Read and execute schema.sql
        const schemaPath = path.join(__dirname, "..", "schema.sql");
        const schemaSQL = fs.readFileSync(schemaPath, "utf8");
        
        // Execute schema statements
        const statements = schemaSQL.split(";").filter(stmt => stmt.trim());
        for (const stmt of statements) {
          if (stmt.trim()) {
            await conn.query(stmt);
          }
        }

        console.log("Schema initialized");

        // Load data from MySQL
        state = await loadFromMySQL(conn);
      } finally {
        conn.release();
      }
      return;
    } catch (err) {
      console.error("MySQL initialization error:", err.message);
      throw err;
    }
  }

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
