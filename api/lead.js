// api/lead.js
// Receives a captured lead from the audit tool. It does three things, each
// best-effort so a hiccup never stops the visitor seeing their report:
//   1. Saves the lead to your Google Sheet.
//   2. Emails the full report to the person who ran the audit.
//   3. Emails your team a heads-up that a new lead came in.
//
// Emails are sent through Resend. The secret API key is NOT stored here, it
// lives safely in Vercel's Environment Variables as RESEND_API_KEY.

// --- Settings you can change ---------------------------------------------
// Google Sheet connection (set up earlier).
const GOOGLE_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycby4CQxiFD_LtxQlZrAjoLSPFAJKI_LsiP3SA9D--IU33BAdEIVAzJ7o5_W6A6XOh-Jp/exec";

// The report emails are sent FROM this address. It must be on the domain that
// is verified in Resend (mail.verdan.tech), or Resend will refuse to send.
const FROM = "VerdanTech Audit <reports@mail.verdan.tech>";

// New-lead alerts for your team are sent TO this address. Change if needed.
const TEAM_EMAIL = "leads@verdan.tech";
// -------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Send one email via the Resend API.
async function sendEmail(apiKey, payload) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// Build the branded report email sent to the person who ran the audit.
function buildReportEmail(report) {
  const band =
    report.score >= 70 ? "#1f9d57" : report.score >= 45 ? "#d69a2d" : "#cf5a4b";

  const categories = (report.categories || [])
    .map(function (cat) {
      const rows = (cat.checks || [])
        .map(function (ch) {
          const colour =
            ch.status === "pass"
              ? "#1f9d57"
              : ch.status === "partial"
              ? "#d69a2d"
              : "#cf5a4b";
          const icon =
            ch.status === "pass" ? "&#10003;" : ch.status === "partial" ? "&ndash;" : "&#10007;";
          const fix =
            ch.status !== "pass" && ch.fix
              ? '<div style="font-size:13px;color:#0e4a35;background:#eef5f0;padding:8px 10px;border-radius:6px;margin-top:6px;"><strong>How to fix:</strong> ' +
                esc(ch.fix) +
                "</div>"
              : "";
          return (
            '<tr><td style="padding:8px 0;vertical-align:top;width:20px;"><span style="color:' +
            colour +
            ';font-weight:bold;font-size:15px;">' +
            icon +
            '</span></td><td style="padding:8px 0 8px 8px;font-size:14px;color:#10261c;font-family:Arial,sans-serif;"><strong>' +
            esc(ch.label) +
            '</strong><div style="color:#5c6f65;font-size:13px;margin-top:2px;">' +
            esc(ch.detail) +
            "</div>" +
            fix +
            "</td></tr>"
          );
        })
        .join("");

      const catBand =
        cat.score / cat.max >= 0.7
          ? "#1f9d57"
          : cat.score / cat.max >= 0.45
          ? "#d69a2d"
          : "#cf5a4b";

      return (
        '<div style="border:1px solid #d9e2db;border-radius:12px;padding:18px 20px;margin:14px 0;">' +
        '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td style="font-family:Arial,sans-serif;font-size:16px;font-weight:bold;color:#10261c;">' +
        esc(cat.name) +
        "</td>" +
        '<td align="right" style="font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:' +
        catBand +
        ';">' +
        cat.score +
        "/" +
        cat.max +
        "</td></tr></table>" +
        '<div style="color:#5c6f65;font-size:13px;font-family:Arial,sans-serif;margin:4px 0 6px;">' +
        esc(cat.tagline || "") +
        "</div>" +
        '<table width="100%" cellpadding="0" cellspacing="0">' +
        rows +
        "</table></div>"
      );
    })
    .join("");

  return (
    '<div style="background:#eef2ee;padding:24px 0;font-family:Arial,sans-serif;">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;">' +
    '<div style="background:#0e4a35;padding:22px 28px;color:#ffffff;font-size:18px;font-weight:bold;">VerdanTech &middot; AEO Audit</div>' +
    '<div style="padding:28px;">' +
    '<p style="font-size:15px;color:#10261c;margin:0 0 4px;">Here is your Answer Engine Optimisation report for</p>' +
    '<p style="font-size:15px;color:#0e4a35;font-weight:bold;margin:0 0 20px;word-break:break-all;">' +
    esc(report.url || report.domain) +
    "</p>" +
    '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;"><tr>' +
    '<td style="font-size:56px;font-weight:bold;color:' +
    band +
    ';font-family:Arial,sans-serif;">' +
    report.score +
    '<span style="font-size:20px;color:#5c6f65;">/100</span></td>' +
    '<td align="right" style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:' +
    band +
    ';font-weight:bold;">' +
    esc(report.grade) +
    "</td></tr></table>" +
    '<p style="font-size:16px;color:#10261c;margin:0 0 18px;">' +
    esc(report.headline) +
    "</p>" +
    categories +
    '<div style="text-align:center;margin:26px 0 6px;">' +
    '<a href="https://verdan.tech/contact" style="background:#17694c;color:#ffffff;text-decoration:none;padding:14px 26px;border-radius:10px;font-weight:bold;font-size:15px;display:inline-block;">Want us to handle the fixes? Talk to VerdanTech</a>' +
    "</div>" +
    "</div>" +
    '<div style="padding:18px 28px;background:#f4f6f2;color:#5c6f65;font-size:12px;font-family:Arial,sans-serif;">You are receiving this because you requested a free AEO audit at VerdanTech. Reply to this email to reach our team.</div>' +
    "</div></div>"
  );
}

// Build the short internal alert sent to your team.
function buildTeamEmail(lead) {
  return (
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#10261c;max-width:560px;">' +
    "<h2 style=\"color:#0e4a35;\">New AEO lead \uD83C\uDF31</h2>" +
    "<p><strong>Email:</strong> " +
    esc(lead.email) +
    "</p><p><strong>Website:</strong> " +
    esc(lead.domain) +
    "</p><p><strong>Score:</strong> " +
    esc(lead.score) +
    "/100</p><p><strong>Time:</strong> " +
    new Date().toLocaleString("en-GB") +
    "</p></div>"
  );
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    const { email, domain, score, report } = body || {};

    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
    if (!valid) {
      res.status(400).json({ error: "Please enter a valid email address." });
      return;
    }

    // 1. Save to the Google Sheet (best-effort).
    if (GOOGLE_SCRIPT_URL) {
      try {
        await fetch(GOOGLE_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: String(email).trim(),
            domain: String(domain || "").trim(),
            score: String(score == null ? "" : score),
            timestamp: new Date().toISOString(),
          }),
        });
      } catch (e) {
        // ignore storage errors
      }
    }

    // 2 + 3. Send the emails, only if the Resend key is present in Vercel.
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) {
      const tasks = [];
      if (report && report.categories) {
        tasks.push(
          sendEmail(apiKey, {
            from: FROM,
            to: String(email).trim(),
            reply_to: TEAM_EMAIL,
            subject: "Your AEO score: " + report.score + "/100",
            html: buildReportEmail(report),
          })
        );
      }
      tasks.push(
        sendEmail(apiKey, {
          from: FROM,
          to: TEAM_EMAIL,
          subject:
            "New AEO lead: " + (domain || "") + " (" + (score == null ? "" : score) + "/100)",
          html: buildTeamEmail({ email: email, domain: domain, score: score }),
        })
      );
      try {
        await Promise.all(tasks);
      } catch (e) {
        // never block the user on an email failure
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: true });
  }
};
