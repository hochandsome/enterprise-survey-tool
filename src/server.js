require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const db = require("./db");
const { sendSurveyEmail, isSmtpEnabled, verifySmtp } = require("./mailer");

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
const reminderAfterDays = Number(process.env.REMINDER_AFTER_DAYS || 3);
const adminUsername = process.env.ADMIN_USERNAME || "phungthaihoc";
const adminPassword = process.env.ADMIN_PASSWORD || "123";
const sessionSecret = process.env.SESSION_SECRET || "dev-session-secret-change-me";
const sessionTtlMs = 1000 * 60 * 60 * 24;
const sessions = new Map();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function now() {
  return new Date().toISOString();
}

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

function randomAnonCode() {
  return crypto.randomBytes(12).toString("hex");
}

function parseEmails(raw) {
  const unique = new Set();
  for (const row of raw || []) {
    const parts = String(row || "")
      .split(/[\s,;]+/g)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);

    for (const email of parts) {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (ok) unique.add(email);
    }
  }
  return [...unique];
}

function readDb() {
  return db.load();
}

function writeDb(data) {
  const maybePromise = db.save(data);
  if (maybePromise && typeof maybePromise.then === "function") {
    maybePromise.catch((error) => {
      console.error("DB save failed", error);
    });
  }
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const cookies = {};
  raw.split(";").forEach((entry) => {
    const [k, ...v] = entry.trim().split("=");
    if (!k) return;
    cookies[k] = decodeURIComponent(v.join("="));
  });
  return cookies;
}

function createSignature(token) {
  return crypto.createHmac("sha256", sessionSecret).update(token).digest("hex");
}

function buildSessionCookie(token) {
  const signature = createSignature(token);
  return `${token}.${signature}`;
}

function verifySessionCookie(value) {
  if (!value || !value.includes(".")) return null;
  const lastDot = value.lastIndexOf(".");
  const token = value.slice(0, lastDot);
  const signature = value.slice(lastDot + 1);
  if (signature !== createSignature(token)) return null;
  return token;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production";
  const maxAge = Math.floor(sessionTtlMs / 1000);
  const cookieValue = buildSessionCookie(token);
  const flags = [
    `admin_session=${encodeURIComponent(cookieValue)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production";
  const flags = ["admin_session=", "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (secure) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = verifySessionCookie(cookies.admin_session);
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session.username;
}

function requireAdminApi(req, res, next) {
  const username = getSessionUser(req);
  if (!username) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.adminUser = username;
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();

  if (username !== adminUsername || password !== adminPassword) {
    return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu" });
  }

  const token = randomToken();
  sessions.set(token, {
    username,
    expiresAt: Date.now() + sessionTtlMs,
  });
  setSessionCookie(res, token);

  res.json({ ok: true, username });
});

app.post("/api/auth/logout", (req, res) => {
  const cookies = parseCookies(req);
  const token = verifySessionCookie(cookies.admin_session);
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const username = getSessionUser(req);
  if (!username) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ ok: true, username });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/auth/login") return next();
  if (req.path.startsWith("/respond/")) return next();
  return requireAdminApi(req, res, next);
});

app.get("/api/system/status", async (_req, res) => {
  const smtp = await verifySmtp();
  res.json({
    dbProvider: db.provider,
    smtpEnabled: isSmtpEnabled(),
    smtp,
    reminderAfterDays,
  });
});

app.post("/api/system/test-email", async (req, res) => {
  const to = String(req.body?.to || process.env.SMTP_TEST_TO || "").trim();
  if (!to) {
    return res.status(400).json({ error: "Thiếu email test" });
  }

  try {
    await sendSurveyEmail({
      to,
      subject: "[Survey Tool] Test SMTP",
      html: `<p>SMTP đã cấu hình thành công.</p><p>Thời điểm: ${now()}</p>`,
    });

    res.json({ ok: true, to });
  } catch (error) {
    res.status(500).json({ error: error.message || "Không gửi được email test" });
  }
});

app.get("/api/templates", (_req, res) => {
  const data = readDb();
  const templates = data.templates
    .slice()
    .sort((a, b) => b.id - a.id)
    .map((t) => ({
      ...t,
      questions: data.templateQuestions
        .filter((q) => q.templateId === t.id)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    }));

  res.json(templates);
});

app.post("/api/templates", (req, res) => {
  const { name, description, questions } = req.body || {};
  if (!name || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: "Thiếu tên template hoặc câu hỏi" });
  }

  const data = readDb();
  const templateId = db.nextId(data, "templates");
  data.templates.push({
    id: templateId,
    name: String(name).trim(),
    description: description ? String(description).trim() : "",
    createdAt: now(),
  });

  questions.forEach((q, index) => {
    data.templateQuestions.push({
      id: db.nextId(data, "templateQuestions"),
      templateId,
      type: q.type,
      title: String(q.title || "").trim(),
      required: Boolean(q.required),
      options: Array.isArray(q.options) ? q.options : [],
      sortOrder: index,
    });
  });

  writeDb(data);
  res.status(201).json({ id: templateId });
});

app.get("/api/surveys", (_req, res) => {
  const data = readDb();
  const rows = data.surveys
    .slice()
    .sort((a, b) => b.id - a.id)
    .map((s) => {
      const company = data.companies.find((c) => c.id === s.companyId);
      const recipients = data.recipients.filter((r) => r.surveyId === s.id);
      return {
        ...s,
        company_name: company?.name || "",
        total_recipients: recipients.length,
        completed_recipients: recipients.filter((r) => r.status === "completed").length,
      };
    });

  res.json(rows);
});

app.post("/api/surveys", (req, res) => {
  const { companyName, templateId, surveyName, deadlineAt } = req.body || {};
  if (!companyName || !templateId || !surveyName) {
    return res.status(400).json({ error: "Thiếu companyName/templateId/surveyName" });
  }

  const data = readDb();
  const template = data.templates.find((t) => t.id === Number(templateId));
  if (!template) {
    return res.status(404).json({ error: "Không tìm thấy template" });
  }

  let company = data.companies.find((c) => c.name.toLowerCase() === String(companyName).trim().toLowerCase());
  if (!company) {
    company = {
      id: db.nextId(data, "companies"),
      name: String(companyName).trim(),
      createdAt: now(),
    };
    data.companies.push(company);
  }

  const surveyId = db.nextId(data, "surveys");
  data.surveys.push({
    id: surveyId,
    companyId: company.id,
    templateId: template.id,
    name: String(surveyName).trim(),
    status: "draft",
    anonymous: true,
    deadlineAt: deadlineAt || null,
    createdAt: now(),
  });

  const templateQuestions = data.templateQuestions
    .filter((q) => q.templateId === template.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  templateQuestions.forEach((q, index) => {
    data.surveyQuestions.push({
      id: db.nextId(data, "surveyQuestions"),
      surveyId,
      type: q.type,
      title: q.title,
      required: Boolean(q.required),
      options: Array.isArray(q.options) ? q.options : [],
      sortOrder: index,
    });
  });

  writeDb(data);
  res.status(201).json({ id: surveyId });
});

app.get("/api/surveys/:id/setup", (req, res) => {
  const surveyId = Number(req.params.id);
  const data = readDb();

  const survey = data.surveys.find((s) => s.id === surveyId);
  if (!survey) {
    return res.status(404).json({ error: "Không tìm thấy survey" });
  }

  const company = data.companies.find((c) => c.id === survey.companyId);
  const questions = data.surveyQuestions
    .filter((q) => q.surveyId === surveyId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const recipients = data.recipients
    .filter((r) => r.surveyId === surveyId)
    .sort((a, b) => b.id - a.id)
    .map((r) => ({
      id: r.id,
      email: r.email,
      status: r.status,
      last_sent_at: r.lastSentAt || null,
      reminder_count: r.reminderCount || 0,
    }));

  res.json({
    survey: { ...survey, company_name: company?.name || "" },
    questions,
    recipients,
  });
});

app.put("/api/surveys/:id/setup", (req, res) => {
  const surveyId = Number(req.params.id);
  const { questions, emails } = req.body || {};

  const data = readDb();
  const survey = data.surveys.find((s) => s.id === surveyId);
  if (!survey) {
    return res.status(404).json({ error: "Không tìm thấy survey" });
  }

  if (Array.isArray(questions) && questions.length > 0) {
    data.surveyQuestions = data.surveyQuestions.filter((q) => q.surveyId !== surveyId);
    questions.forEach((q, index) => {
      data.surveyQuestions.push({
        id: db.nextId(data, "surveyQuestions"),
        surveyId,
        type: q.type,
        title: String(q.title || "").trim(),
        required: Boolean(q.required),
        options: Array.isArray(q.options) ? q.options : [],
        sortOrder: index,
      });
    });
  }

  const parsedEmails = parseEmails(Array.isArray(emails) ? emails : []);
  for (const email of parsedEmails) {
    const exists = data.recipients.some((r) => r.surveyId === surveyId && r.email === email);
    if (exists) continue;

    data.recipients.push({
      id: db.nextId(data, "recipients"),
      surveyId,
      email,
      token: randomToken(),
      status: "pending",
      lastSentAt: null,
      reminderCount: 0,
      createdAt: now(),
    });
  }

  writeDb(data);
  res.json({ ok: true, imported: parsedEmails.length });
});

app.post("/api/surveys/:id/send", async (req, res) => {
  const surveyId = Number(req.params.id);
  const data = readDb();

  const survey = data.surveys.find((s) => s.id === surveyId);
  if (!survey) {
    return res.status(404).json({ error: "Không tìm thấy survey" });
  }

  const company = data.companies.find((c) => c.id === survey.companyId);
  const recipients = data.recipients.filter((r) => r.surveyId === surveyId);

  if (!recipients.length) {
    return res.status(400).json({ error: "Survey chưa có người nhận" });
  }

  const delivery = {
    sent: 0,
    failed: 0,
    mode: "smtp",
    previewLinks: [],
    failures: [],
  };

  for (const r of recipients) {
    const link = `${baseUrl}/s/${r.token}`;
    try {
      const mailResult = await sendSurveyEmail({
        to: r.email,
        subject: `[${company?.name || "Company"}] Mời bạn tham gia khảo sát hài lòng`,
        html: `<p>Xin chào,</p><p>Vui lòng hoàn thành khảo sát tại: <a href="${link}">${link}</a></p>`,
      });

      if (mailResult?.mode === "dev") {
        delivery.mode = "dev";
        delivery.previewLinks.push({ email: r.email, link });
      }

      if (r.status === "pending") {
        r.status = "sent";
      }
      r.lastSentAt = now();
      delivery.sent += 1;
    } catch (error) {
      delivery.failed += 1;
      delivery.failures.push({ email: r.email, reason: error.message || "send failed" });
    }
  }

  survey.status = "active";
  writeDb(data);

  res.json({ ok: true, ...delivery });
});

app.get("/api/dashboard/:surveyId", (req, res) => {
  const surveyId = Number(req.params.surveyId);
  const data = readDb();

  const recipients = data.recipients.filter((r) => r.surveyId === surveyId);
  const total = recipients.length;
  const completed = recipients.filter((r) => r.status === "completed").length;
  const inProgress = recipients.filter((r) => r.status === "in_progress").length;
  const sent = recipients.filter((r) => r.status === "sent").length;
  const pending = recipients.filter((r) => r.status === "pending").length;

  const questions = data.surveyQuestions
    .filter((q) => q.surveyId === surveyId && q.type === "scale")
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const scaleAverages = questions.map((q) => {
    const relevant = data.submissionAnswers.filter((a) => a.questionId === q.id);
    const scores = relevant
      .map((a) => Number(a.answer))
      .filter((v) => Number.isFinite(v));
    const avg = scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null;

    return {
      id: q.id,
      title: q.title,
      avg_score: avg,
      samples: scores.length,
    };
  });

  const recipientStatuses = recipients
    .slice()
    .sort((a, b) => b.id - a.id)
    .map((r) => ({
      email: r.email,
      status: r.status,
      reminder_count: r.reminderCount || 0,
      last_sent_at: r.lastSentAt || null,
    }));

  res.json({
    metrics: {
      total,
      completed,
      inProgress,
      sent,
      pending,
      completionRate: total ? Math.round((completed / total) * 100) : 0,
    },
    scaleAverages,
    recipients: recipientStatuses,
  });
});

app.get("/api/respond/:token", (req, res) => {
  const token = req.params.token;
  const data = readDb();

  const recipient = data.recipients.find((r) => r.token === token);
  if (!recipient) {
    return res.status(404).json({ error: "Link khảo sát không hợp lệ" });
  }

  const survey = data.surveys.find((s) => s.id === recipient.surveyId);
  const company = data.companies.find((c) => c.id === survey.companyId);
  const questions = data.surveyQuestions
    .filter((q) => q.surveyId === survey.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map((q) => ({
      id: q.id,
      type: q.type,
      title: q.title,
      required: Boolean(q.required),
      options: Array.isArray(q.options) ? q.options : [],
    }));

  const draft = data.drafts.find((d) => d.recipientId === recipient.id);

  res.json({
    recipient: {
      status: recipient.status,
    },
    survey: {
      id: survey.id,
      name: survey.name,
      status: survey.status,
      deadline_at: survey.deadlineAt,
      company_name: company?.name || "",
    },
    questions,
    draft: draft
      ? {
          currentIndex: draft.currentIndex,
          answers: draft.answers,
        }
      : {
          currentIndex: 0,
          answers: {},
        },
    alreadyDone: recipient.status === "completed",
  });
});

app.post("/api/respond/:token/draft", (req, res) => {
  const token = req.params.token;
  const { currentIndex, answers } = req.body || {};

  const data = readDb();
  const recipient = data.recipients.find((r) => r.token === token);
  if (!recipient) {
    return res.status(404).json({ error: "Link khảo sát không hợp lệ" });
  }

  if (recipient.status === "completed") {
    return res.status(400).json({ error: "Khảo sát đã hoàn thành" });
  }

  let draft = data.drafts.find((d) => d.recipientId === recipient.id);
  if (!draft) {
    draft = {
      id: db.nextId(data, "drafts"),
      surveyId: recipient.surveyId,
      recipientId: recipient.id,
      currentIndex: 0,
      answers: {},
      updatedAt: now(),
    };
    data.drafts.push(draft);
  }

  draft.currentIndex = Number(currentIndex || 0);
  draft.answers = answers || {};
  draft.updatedAt = now();

  if (recipient.status === "pending" || recipient.status === "sent") {
    recipient.status = "in_progress";
  }

  writeDb(data);
  res.json({ ok: true });
});

app.post("/api/respond/:token/submit", (req, res) => {
  const token = req.params.token;
  const data = readDb();

  const recipient = data.recipients.find((r) => r.token === token);
  if (!recipient) {
    return res.status(404).json({ error: "Link khảo sát không hợp lệ" });
  }

  if (recipient.status === "completed") {
    return res.status(400).json({ error: "Khảo sát đã gửi trước đó" });
  }

  const draft = data.drafts.find((d) => d.recipientId === recipient.id);
  const answers = draft?.answers || {};

  const questions = data.surveyQuestions
    .filter((q) => q.surveyId === recipient.surveyId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  for (const q of questions) {
    if (!q.required) continue;
    const ans = answers[String(q.id)];
    const missing = ans === undefined || ans === null || ans === "" || (Array.isArray(ans) && ans.length === 0);
    if (missing) {
      return res.status(400).json({ error: `Bạn chưa trả lời câu bắt buộc: ${q.title}` });
    }
  }

  const submissionId = db.nextId(data, "submissions");
  data.submissions.push({
    id: submissionId,
    surveyId: recipient.surveyId,
    anonCode: randomAnonCode(),
    submittedAt: now(),
  });

  questions.forEach((q) => {
    const ans = answers[String(q.id)];
    if (ans === undefined) return;
    data.submissionAnswers.push({
      id: db.nextId(data, "submissionAnswers"),
      submissionId,
      questionId: q.id,
      answer: ans,
    });
  });

  recipient.status = "completed";
  data.drafts = data.drafts.filter((d) => d.recipientId !== recipient.id);

  writeDb(data);
  res.json({ ok: true });
});

async function processAutomaticReminders() {
  const data = readDb();
  const nowTs = Date.now();

  for (const r of data.recipients) {
    if (r.status === "completed") continue;
    if (!r.lastSentAt) continue;
    if ((r.reminderCount || 0) > 0) continue;

    const lastTs = new Date(r.lastSentAt).getTime();
    const diffDays = (nowTs - lastTs) / (1000 * 60 * 60 * 24);
    if (diffDays < reminderAfterDays) continue;

    const survey = data.surveys.find((s) => s.id === r.surveyId);
    const company = data.companies.find((c) => c.id === survey.companyId);
    const link = `${baseUrl}/s/${r.token}`;

    await sendSurveyEmail({
      to: r.email,
      subject: `[Nhắc lần 1] ${company?.name || "Công ty"} - ${survey?.name || "Khảo sát"}`,
      html: `<p>Bạn chưa hoàn thành khảo sát.</p><p>Vui lòng tiếp tục tại: <a href="${link}">${link}</a></p>`,
    });

    r.reminderCount = (r.reminderCount || 0) + 1;
    r.lastSentAt = now();
  }

  writeDb(data);
}

setInterval(() => {
  processAutomaticReminders().catch((err) => {
    console.error("Reminder job error", err);
  });
}, 60 * 60 * 1000);

setInterval(() => {
  const nowTs = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt < nowTs) {
      sessions.delete(token);
    }
  }
}, 5 * 60 * 1000);

app.get("/admin", (req, res) => {
  const username = getSessionUser(req);
  if (!username) {
    return res.redirect("/login");
  }
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

app.get("/s/:token", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "survey.html"));
});

async function start() {
  await db.init();

  app.listen(port, () => {
    console.log(`Survey app running at ${baseUrl} (db=${db.provider})`);
  });
}

start().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
