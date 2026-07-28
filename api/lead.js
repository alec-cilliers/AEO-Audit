// api/lead.js
// Receives a captured email from the audit tool and forwards it to your
// Google Sheet. The sheet is connected in Step 4 by pasting your Google
// Apps Script web-app URL into the line marked below.

// STEP 4: paste your Google Apps Script URL between the quotes.
// It will look like: https://script.google.com/macros/s/AKfy..../exec
const GOOGLE_SCRIPT_URL = "";

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    const { email, domain, score } = body || {};

    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
    if (!valid) {
      res.status(400).json({ error: "Please enter a valid email address." });
      return;
    }

    // If the sheet is not connected yet, still let the user through so the
    // tool works during setup. Emails simply are not stored until Step 4.
    if (!GOOGLE_SCRIPT_URL) {
      res.status(200).json({ ok: true, stored: false });
      return;
    }

    const payload = {
      email: String(email).trim(),
      domain: String(domain || "").trim(),
      score: String(score ?? ""),
      timestamp: new Date().toISOString(),
    };

    await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    res.status(200).json({ ok: true, stored: true });
  } catch (err) {
    // Never block the user from seeing their report because of a storage hiccup.
    res.status(200).json({ ok: true, stored: false });
  }
};
