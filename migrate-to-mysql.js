#!/usr/bin/env node

/**
 * Migration script: JSON -> MySQL
 * 
 * Usage:
 * 1. Make sure MySQL is running with the correct credentials in .env
 * 2. Run: node migrate-to-mysql.js
 */

const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const dbPath = path.join(__dirname, "survey-data.json");
const mysqlHost = process.env.MYSQL_HOST || "localhost";
const mysqlPort = parseInt(process.env.MYSQL_PORT || "3306");
const mysqlUser = process.env.MYSQL_USER || "survey";
const mysqlPassword = process.env.MYSQL_PASSWORD || "survey123";
const mysqlDatabase = process.env.MYSQL_DATABASE || "survey";

async function migrate() {
  console.log("🚀 Starting MySQL migration...");
  console.log(`Connection: ${mysqlUser}@${mysqlHost}:${mysqlPort}/${mysqlDatabase}`);

  // Load JSON data
  if (!fs.existsSync(dbPath)) {
    console.error("❌ survey-data.json not found!");
    process.exit(1);
  }

  let jsonData;
  try {
    const text = fs.readFileSync(dbPath, "utf8");
    jsonData = JSON.parse(text);
    console.log("✅ Loaded JSON data");
  } catch (err) {
    console.error("❌ Failed to parse JSON:", err.message);
    process.exit(1);
  }

  // Create MySQL connection
  let pool;
  try {
    pool = await mysql.createPool({
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlUser,
      password: mysqlPassword,
      database: mysqlDatabase,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
    console.log("✅ Connected to MySQL");
  } catch (err) {
    console.error("❌ MySQL connection failed:", err.message);
    console.error("\nMake sure MySQL is running and credentials are correct:");
    console.error(`  Host: ${mysqlHost}`);
    console.error(`  Port: ${mysqlPort}`);
    console.error(`  User: ${mysqlUser}`);
    console.error(`  Database: ${mysqlDatabase}`);
    process.exit(1);
  }

  const conn = await pool.getConnection();
  try {
    console.log("\n📋 Creating schema...");

    // Read and execute schema.sql
    const schemaPath = path.join(__dirname, "schema.sql");
    const schemaSQL = fs.readFileSync(schemaPath, "utf8");

    const statements = schemaSQL.split(";").filter(stmt => stmt.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        try {
          await conn.query(stmt);
        } catch (err) {
          // Ignore errors for CREATE TABLE IF NOT EXISTS
          if (!err.message.includes("already exists")) {
            console.error("SQL Error:", err.message);
          }
        }
      }
    }
    console.log("✅ Schema created/verified");

    console.log("\n📝 Migrating data...");

    // Insert templates
    console.log("  Inserting templates...");
    for (const template of jsonData.templates || []) {
      await conn.query(
        `INSERT INTO templates (id, name, description, createdAt) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=?, description=?, createdAt=?`,
        [template.id, template.name, template.description, template.createdAt,
         template.name, template.description, template.createdAt]
      );
    }

    // Insert templateQuestions
    console.log("  Inserting templateQuestions...");
    for (const tq of jsonData.templateQuestions || []) {
      await conn.query(
        `INSERT INTO templateQuestions (id, templateId, type, title, required, options, section, sortOrder)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE templateId=?, type=?, title=?, required=?, options=?, section=?, sortOrder=?`,
        [tq.id, tq.templateId, tq.type, tq.title, tq.required, JSON.stringify(tq.options || []), tq.section, tq.sortOrder,
         tq.templateId, tq.type, tq.title, tq.required, JSON.stringify(tq.options || []), tq.section, tq.sortOrder]
      );
    }

    // Insert companies
    console.log("  Inserting companies...");
    for (const company of jsonData.companies || []) {
      await conn.query(
        `INSERT INTO companies (id, name, createdAt) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE name=?, createdAt=?`,
        [company.id, company.name, company.createdAt, company.name, company.createdAt]
      );
    }

    // Insert surveys
    console.log("  Inserting surveys...");
    for (const survey of jsonData.surveys || []) {
      await conn.query(
        `INSERT INTO surveys (id, companyId, templateId, title, status, sections, setup, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE companyId=?, templateId=?, title=?, status=?, sections=?, setup=?, createdAt=?`,
        [survey.id, survey.companyId, survey.templateId, survey.title, survey.status,
         JSON.stringify(survey.sections || []), JSON.stringify(survey.setup || {}), survey.createdAt,
         survey.companyId, survey.templateId, survey.title, survey.status,
         JSON.stringify(survey.sections || []), JSON.stringify(survey.setup || {}), survey.createdAt]
      );
    }

    // Insert surveyQuestions
    console.log("  Inserting surveyQuestions...");
    for (const sq of jsonData.surveyQuestions || []) {
      await conn.query(
        `INSERT INTO surveyQuestions (id, surveyId, templateQuestionId, type, title, required, options, section, sortOrder)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE surveyId=?, templateQuestionId=?, type=?, title=?, required=?, options=?, section=?, sortOrder=?`,
        [sq.id, sq.surveyId, sq.templateQuestionId, sq.type, sq.title, sq.required,
         JSON.stringify(sq.options || []), sq.section, sq.sortOrder,
         sq.surveyId, sq.templateQuestionId, sq.type, sq.title, sq.required,
         JSON.stringify(sq.options || []), sq.section, sq.sortOrder]
      );
    }

    // Insert recipients
    console.log("  Inserting recipients...");
    for (const recipient of jsonData.recipients || []) {
      await conn.query(
        `INSERT INTO recipients (id, surveyId, email, sent, sentAt, completedAt, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE surveyId=?, email=?, sent=?, sentAt=?, completedAt=?, createdAt=?`,
        [recipient.id, recipient.surveyId, recipient.email, recipient.sent, recipient.sentAt, recipient.completedAt, recipient.createdAt,
         recipient.surveyId, recipient.email, recipient.sent, recipient.sentAt, recipient.completedAt, recipient.createdAt]
      );
    }

    // Insert drafts
    console.log("  Inserting drafts...");
    for (const draft of jsonData.drafts || []) {
      await conn.query(
        `INSERT INTO drafts (id, surveyId, email, progress, progressPercentage, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE surveyId=?, email=?, progress=?, progressPercentage=?, createdAt=?, updatedAt=?`,
        [draft.id, draft.surveyId, draft.email, JSON.stringify(draft.progress || {}), draft.progressPercentage||0, draft.createdAt, draft.updatedAt,
         draft.surveyId, draft.email, JSON.stringify(draft.progress || {}), draft.progressPercentage||0, draft.createdAt, draft.updatedAt]
      );
    }

    // Insert submissions
    console.log("  Inserting submissions...");
    for (const submission of jsonData.submissions || []) {
      await conn.query(
        `INSERT INTO submissions (id, surveyId, email, anonymous, createdAt)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE surveyId=?, email=?, anonymous=?, createdAt=?`,
        [submission.id, submission.surveyId, submission.email, submission.anonymous, submission.createdAt,
         submission.surveyId, submission.email, submission.anonymous, submission.createdAt]
      );
    }

    // Insert submissionAnswers
    console.log("  Inserting submissionAnswers...");
    for (const sa of jsonData.submissionAnswers || []) {
      await conn.query(
        `INSERT INTO submissionAnswers (id, submissionId, surveyQuestionId, answer, createdAt)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE submissionId=?, surveyQuestionId=?, answer=?, createdAt=?`,
        [sa.id, sa.submissionId, sa.surveyQuestionId, sa.answer, sa.createdAt,
         sa.submissionId, sa.surveyQuestionId, sa.answer, sa.createdAt]
      );
    }

    // Insert counters
    console.log("  Inserting counters...");
    for (const [key, value] of Object.entries(jsonData.counters || {})) {
      await conn.query(
        `INSERT INTO counters (keyName, value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE value=?`,
        [key, value, value]
      );
    }

    console.log("\n✅ Migration completed successfully!");
    console.log("\nNext steps:");
    console.log("1. Update .env: DB_PROVIDER=mysql");
    console.log("2. Restart the app: npm start");

  } catch (err) {
    console.error("❌ Migration error:", err.message);
    process.exit(1);
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
