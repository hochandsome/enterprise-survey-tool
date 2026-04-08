const nodemailer = require("nodemailer");

function buildTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_SECURE) === "true",
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

const transporter = buildTransporter();

function isSmtpEnabled() {
  return Boolean(transporter);
}

async function verifySmtp() {
  if (!transporter) {
    return { ok: false, reason: "SMTP chưa được cấu hình" };
  }

  try {
    await transporter.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message || "SMTP verify failed" };
  }
}

async function sendSurveyEmail({ to, subject, html }) {
  const from = process.env.SMTP_FROM || "Survey Bot <no-reply@example.com>";

  if (!transporter) {
    console.log("[MAIL-DEV]", { to, subject, html });
    return { mode: "dev" };
  }

  await transporter.sendMail({ from, to, subject, html });
  return { mode: "smtp" };
}

module.exports = { sendSurveyEmail, isSmtpEnabled, verifySmtp };
