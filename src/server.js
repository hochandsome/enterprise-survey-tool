// Xóa template (chỉ admin)
app.delete("/api/templates/:id", (req, res) => {
  if (req.adminRole !== "admin") {
    return res.status(403).json({ error: "Chỉ admin mới được xóa template" });
  }
  const templateId = Number(req.params.id);
  const data = readDb();
  const exists = data.templates.some((t) => t.id === templateId);
  if (!exists) {
    return res.status(404).json({ error: "Không tìm thấy template" });
  }
  data.templates = data.templates.filter((t) => t.id !== templateId);
  data.templateQuestions = data.templateQuestions.filter((q) => q.templateId !== templateId);
  writeDb(data);
  res.json({ ok: true });
});
require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const XLSX = require("xlsx");

const db = require("./db");
const { sendSurveyEmail, isSmtpEnabled, verifySmtp } = require("./mailer");

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
const reminderAfterHours = Number(process.env.REMINDER_AFTER_HOURS || 48);
const surveyExpireDays = Number(process.env.SURVEY_EXPIRE_DAYS || 7);
const deployMarker = "auth-v1-force-redeploy";
const adminUsername = process.env.ADMIN_USERNAME || "admin";
const adminPassword = process.env.ADMIN_PASSWORD || "xzxz";
const managerUsername = process.env.MANAGER_USERNAME || "manager";
const managerPassword = process.env.MANAGER_PASSWORD || "123";
const sessionSecret = process.env.SESSION_SECRET || "dev-session-secret-change-me";
const sessionTtlMs = 1000 * 60 * 60 * 24;
const sessions = new Map();
const questionsPerPage = 4;

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

function parseEmailsFromExcelBase64(base64) {
  try {
    const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
    const first = workbook.Sheets[workbook.SheetNames[0]];
    if (!first) return [];

    const rows = XLSX.utils.sheet_to_json(first, { header: 1, defval: "" });
    const raw = [];
    for (const row of rows) {
      for (const cell of row) {
        raw.push(String(cell || "").trim());
      }
    }
    return parseEmails(raw);
  } catch (_error) {
    return [];
  }
}

function getSurveyComputedStatus(survey) {
  if (!survey) return "unknown";
  if (survey.status === "completed") return "completed";
  if (survey.expiresAt && new Date(survey.expiresAt).getTime() < Date.now()) return "expired";
  if (survey.status === "active") return "active";
  return "draft";
}

function normalizeCondition(raw) {
  if (!raw || typeof raw !== "object") return null;
  const dependsOnTitle = String(raw.dependsOnTitle || "").trim();
  const equalsValue = String(raw.equalsValue || "").trim();
  if (!dependsOnTitle || !equalsValue) return null;
  return {
    dependsOnTitle,
    equalsValue,
  };
}

function isQuestionVisible(question, questions, answers) {
  const condition = normalizeCondition(question?.condition);
  if (!condition) return true;

  const source = questions.find((q) => String(q.title || "").trim() === condition.dependsOnTitle);
  if (!source) return true;

  const sourceAnswer = answers[String(source.id)];
  if (Array.isArray(sourceAnswer)) {
    return sourceAnswer.map((v) => String(v)).includes(condition.equalsValue);
  }
  return String(sourceAnswer || "") === condition.equalsValue;
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
  return {
    username: session.username,
    role: session.role,
  };
}

function requireAdminApi(req, res, next) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.adminUser = sessionUser.username;
  req.adminRole = sessionUser.role;
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  const sessionUser = getSessionUser(req);
  if (sessionUser) {
    return res.redirect("/admin");
  }
  return res.redirect("/login");
});

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();

  let role = null;
  if (username === adminUsername && password === adminPassword) {
    role = "admin";
  }
  if (username === managerUsername && password === managerPassword) {
    role = "manager";
  }

  if (!role) {
    return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu" });
  }

  const token = randomToken();
  sessions.set(token, {
    username,
    role,
    expiresAt: Date.now() + sessionTtlMs,
  });
  setSessionCookie(res, token);

  res.json({ ok: true, username, role });
});

app.post("/api/auth/logout", (req, res) => {
  const cookies = parseCookies(req);
  const token = verifySessionCookie(cookies.admin_session);
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ ok: true, username: sessionUser.username, role: sessionUser.role });
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
    reminderAfterHours,
    surveyExpireDays,
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
      section: String(q.section || "Phần mặc định").trim() || "Phần mặc định",
      group: String(q.group || "Nhóm mặc định").trim() || "Nhóm mặc định",
      condition: normalizeCondition(q.condition),
      sortOrder: index,
    });
  });

  writeDb(data);
  res.status(201).json({ id: templateId });
});

app.put("/api/templates/:id", (req, res) => {
  const templateId = Number(req.params.id);
  const { name, description, questions } = req.body || {};

  if (!name || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: "Thiếu tên template hoặc câu hỏi" });
  }

  const data = readDb();
  const template = data.templates.find((t) => t.id === templateId);
  if (!template) {
    return res.status(404).json({ error: "Không tìm thấy template" });
  }

  template.name = String(name).trim();
  template.description = description ? String(description).trim() : "";

  data.templateQuestions = data.templateQuestions.filter((q) => q.templateId !== templateId);
  questions.forEach((q, index) => {
    data.templateQuestions.push({
      id: db.nextId(data, "templateQuestions"),
      templateId,
      type: q.type,
      title: String(q.title || "").trim(),
      required: Boolean(q.required),
      options: Array.isArray(q.options) ? q.options : [],
      section: String(q.section || "Phần mặc định").trim() || "Phần mặc định",
      group: String(q.group || "Nhóm mặc định").trim() || "Nhóm mặc định",
      condition: normalizeCondition(q.condition),
      sortOrder: index,
    });
  });

  writeDb(data);
  res.json({ ok: true, id: templateId });
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
        status: getSurveyComputedStatus(s),
        company_name: company?.name || "",
        start_at: s.firstSentAt || null,
        expires_at: s.expiresAt || null,
        total_recipients: recipients.length,
        completed_recipients: recipients.filter((r) => r.status === "completed").length,
      };
    });

  res.json(rows);
});

app.post("/api/surveys", (req, res) => {
  const { companyName, templateId, surveyName, deadlineAt, emailSubject, emailContent } = req.body || {};
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
    firstSentAt: null,
    expiresAt: null,
    createdAt: now(),
    emailSubject: emailSubject || "Khảo sát nhân sự",
    emailContent: emailContent || "Xin chào {{name}},\nBạn được mời tham gia khảo sát. Link: {{link}}",
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
      section: String(q.section || "Phần mặc định").trim() || "Phần mặc định",
      group: String(q.group || "Nhóm mặc định").trim() || "Nhóm mặc định",
      groupGuide: q.groupGuide || "",
      condition: normalizeCondition(q.condition),
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
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .map((q) => ({
        ...q,
        groupGuide: q.groupGuide || ""
      }));
    const recipients = data.recipients
      .filter((r) => r.surveyId === surveyId)
      .sort((a, b) => b.id - a.id)
      .map((r) => ({
        id: r.id,
        email: r.email,
        status: r.status,
        last_sent_at: r.lastSentAt || null,
        reminder_count: r.reminderCount || 0,
        is_new: !r.lastSentAt,
      }));

    res.json({
      survey: { ...survey, company_name: company?.name || "" },
      questions,
      recipients,
    });
});

app.put("/api/surveys/:id/setup", (req, res) => {
  const surveyId = Number(req.params.id);
  const { questions, emails, excelBase64 } = req.body || {};

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
        section: String(q.section || "Phần mặc định").trim() || "Phần mặc định",
        group: String(q.group || "Nhóm mặc định").trim() || "Nhóm mặc định",
        groupGuide: q.groupGuide || "",
        condition: normalizeCondition(q.condition),
        sortOrder: index,
      });
    });
  }
  const textEmails = parseEmails(Array.isArray(emails) ? emails : []);
  const excelEmails = excelBase64 ? parseEmailsFromExcelBase64(String(excelBase64)) : [];
  const parsedEmails = [...new Set([...textEmails, ...excelEmails])];
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

app.put("/api/surveys/:id/meta", (req, res) => {
  const surveyId = Number(req.params.id);
  const { name, companyName, status, emailSubject, emailContent } = req.body || {};
  const data = readDb();
  const survey = data.surveys.find((s) => s.id === surveyId);
  if (!survey) return res.status(404).json({ error: "Không tìm thấy survey" });

  if (name) {
    survey.name = String(name).trim();
  }
  if (companyName) {
    let company = data.companies.find(
      (c) => c.name.toLowerCase() === String(companyName).trim().toLowerCase()
    );
    if (!company) {
      company = {
        id: db.nextId(data, "companies"),
        name: String(companyName).trim(),
        createdAt: now(),
      };
      data.companies.push(company);
    }
    survey.companyId = company.id;
  }
  if (status === "draft" || status === "active" || status === "completed") {
    survey.status = status;
  }
  if (typeof emailSubject === "string") {
    survey.emailSubject = emailSubject;
  }
  if (typeof emailContent === "string") {
    survey.emailContent = emailContent;
  }

  writeDb(data);
  res.json({ ok: true });
});

app.delete("/api/surveys/:id", (req, res) => {
  if (req.adminRole !== "admin") {
    return res.status(403).json({ error: "Manager không có quyền xóa khảo sát" });
  }

  const surveyId = Number(req.params.id);
  const data = readDb();
  const exists = data.surveys.some((s) => s.id === surveyId);
  if (!exists) {
    return res.status(404).json({ error: "Không tìm thấy survey" });
  }

  data.surveys = data.surveys.filter((s) => s.id !== surveyId);
  data.surveyQuestions = data.surveyQuestions.filter((q) => q.surveyId !== surveyId);
  const recipientIds = data.recipients.filter((r) => r.surveyId === surveyId).map((r) => r.id);
  data.recipients = data.recipients.filter((r) => r.surveyId !== surveyId);
  data.drafts = data.drafts.filter((d) => d.surveyId !== surveyId && !recipientIds.includes(d.recipientId));
  const submissionIds = data.submissions.filter((s) => s.surveyId === surveyId).map((s) => s.id);
  data.submissions = data.submissions.filter((s) => s.surveyId !== surveyId);
  data.submissionAnswers = data.submissionAnswers.filter((a) => !submissionIds.includes(a.submissionId));

  writeDb(data);
  res.json({ ok: true });
});

app.get("/api/surveys/:id/preview", (req, res) => {
  const surveyId = Number(req.params.id);
  const data = readDb();
  const survey = data.surveys.find((s) => s.id === surveyId);
  if (!survey) return res.status(404).json({ error: "Không tìm thấy survey" });

  const company = data.companies.find((c) => c.id === survey.companyId);
  const questions = data.surveyQuestions
    .filter((q) => q.surveyId === surveyId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  res.json({
    survey: {
      id: survey.id,
      name: survey.name,
      company_name: company?.name || "",
    },
    questions,
    questionsPerPage,
  });
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
  const newRecipients = recipients.filter((r) => !r.lastSentAt);

  if (!recipients.length) {
    return res.status(400).json({ error: "Survey chưa có người nhận" });
  }

  if (!newRecipients.length) {
    return res.status(400).json({ error: "Không có email mới để gửi bổ sung" });
  }

  const delivery = {
    sent: 0,
    failed: 0,
    mode: "smtp",
    previewLinks: [],
    failures: [],
  };

  for (const r of newRecipients) {
    const link = `${baseUrl}/s/${r.token}`;
    try {
      const mailResult = await sendSurveyEmail({
        to: r.email,
        subject: `[${company?.name || "Company"}] Mời bạn tham gia khảo sát hài lòng`,
        html: `
          <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:680px;margin:auto;">
            <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:10px 14px;display:inline-block;margin-bottom:14px;">
              <img src="${baseUrl}/assets/joywork-logo.svg" alt="JOYWORK" style="width:200px;display:block;" />
            </div>
            <h2 style="margin:0 0 10px;color:#0f172a;">Mời bạn tham gia khảo sát hài lòng nhân sự</h2>
            <p>Đây là cuộc khảo sát nhằm đánh giá độ hài lòng của nhân sự về môi trường làm việc của Công Ty <b>${company?.name || "-"}</b>. Các kết quả khảo sát sẽ được bảo mật 100%, không ai có thể biết được đánh giá của bạn về công ty.</p>
            <p style="margin:16px 0;">
              <a href="${link}" style="display:inline-block;padding:10px 16px;border-radius:10px;background:#0f7bff;color:#ffffff;text-decoration:none;font-weight:700;">Bắt đầu cuộc khảo sát</a>
            </p>
            <p style="color:#6b7280;font-size:13px;">Nếu nút không hoạt động, bạn có thể mở link này: <a href="${link}">${link}</a></p>
            <p style="margin-top:18px;color:#6b7280;font-size:13px;">Cảm ơn bạn đã dành thời gian tham gia khảo sát.</p>
          </div>
        `,
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

  if (!survey.firstSentAt) {
    survey.firstSentAt = now();
    survey.expiresAt = new Date(Date.now() + surveyExpireDays * 24 * 60 * 60 * 1000).toISOString();
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
  if (!survey) {
    return res.status(404).json({ error: "Khảo sát không tồn tại" });
  }
  const status = getSurveyComputedStatus(survey);
  if (status === "expired") {
    return res.status(410).json({ error: "Link khảo sát đã hết hạn" });
  }
  const company = data.companies.find((c) => c.id === survey.companyId);
  const questions = data.surveyQuestions
    .filter((q) => q.surveyId === survey.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map((q) => ({
      id: q.id,
      type: q.type,
      title: q.title,
      required: Boolean(q.required),
      section: q.section || "Phần mặc định",
      group: q.group || "Nhóm mặc định",
      condition: normalizeCondition(q.condition),
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
      computed_status: status,
      deadline_at: survey.deadlineAt,
      expires_at: survey.expiresAt || null,
      company_name: company?.name || "",
      questions_per_page: questionsPerPage,
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

  const visibleQuestions = questions.filter((q) => isQuestionVisible(q, questions, answers));

  for (const q of visibleQuestions) {
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
    const survey = data.surveys.find((s) => s.id === r.surveyId);
    if (!survey) continue;
    if (getSurveyComputedStatus(survey) === "expired") continue;
    const company = data.companies.find((c) => c.id === survey.companyId);
    const link = `${baseUrl}/s/${r.token}`;

    const diffHours = (nowTs - lastTs) / (1000 * 60 * 60);
    if (diffHours < reminderAfterHours) continue;

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
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
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
    console.log(`Survey app running at ${baseUrl} (db=${db.provider}, ${deployMarker})`);
  });
}

start().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
