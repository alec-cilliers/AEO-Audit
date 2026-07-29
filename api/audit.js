// api/audit.js
// Serverless function that fetches a website and scores its Answer Engine
// Optimisation (AEO) readiness out of 100. Runs on Vercel automatically.

const cheerio = require("cheerio");

// Present as a normal web browser. Some sites and their security layers block
// unknown "bot" user agents outright, which makes a legitimate audit fail even
// though the page is perfectly reachable by a real visitor. A browser-like
// identity avoids those false blocks. The tool still only reads public pages,
// never logs in and never submits anything.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Major AI answer-engine crawlers. If a site blocks these in robots.txt,
// it is effectively invisible to the tools that power AI answers.
const AI_BOTS = [
  "GPTBot",
  "ClaudeBot",
  "anthropic-ai",
  "PerplexityBot",
  "Google-Extended",
  "CCBot",
  "Applebot-Extended",
];

// Fetch a URL with a timeout so a slow site can never hang the function.
async function safeFetch(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, finalUrl: res.url };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Try to reach the homepage, falling back to the other host form (with or
// without "www.") since many sites only answer on one of the two.
async function fetchHomepage(url) {
  let res = await safeFetch(url);
  if (res.ok && res.text) return { res, url };
  const alt = url.includes("://www.")
    ? url.replace("://www.", "://")
    : url.replace("://", "://www.");
  res = await safeFetch(alt);
  if (res.ok && res.text) return { res, url: alt };
  return { res: null, url };
}

// Turn whatever the user typed into a clean https URL and a bare domain.
function normaliseDomain(input) {
  let raw = String(input || "").trim();
  raw = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  raw = raw.replace(/^www\./i, "");
  const domain = raw.split("/")[0];
  return { domain, url: `https://${domain}` };
}

// ---- Scoring helpers -------------------------------------------------------

function check(label, status, detail, fix) {
  // status is one of: "pass", "partial", "fail"
  return { label, status, detail, fix: fix || "" };
}

// Weight a category's checks. Each check carries its own point value.
function scoreChecks(checks) {
  let earned = 0;
  let max = 0;
  for (const c of checks) {
    max += c.points;
    if (c.status === "pass") earned += c.points;
    else if (c.status === "partial") earned += c.points / 2;
  }
  return { earned: Math.round(earned), max };
}

// ---- The analysis ----------------------------------------------------------

async function analyse(url, domain) {
  const attempt = await fetchHomepage(url);
  if (!attempt.res || !attempt.res.text) {
    return {
      error:
        "We could not reach that website. Check the spelling, or the site may be blocking automated visits.",
    };
  }

  const home = attempt.res;
  const html = home.text;
  const $ = cheerio.load(html);
  const finalUrl = home.finalUrl || attempt.url;

  // Work out the correct base host to request the supporting files from,
  // following any redirect (for example a non-www address to a www one).
  let originBase = attempt.url.replace(/\/+$/, "");
  try {
    originBase = new URL(finalUrl).origin;
  } catch (e) {
    // keep the fallback base if the final URL cannot be parsed
  }

  // Pull the supporting files in parallel.
  const [robots, llms, sitemap] = await Promise.all([
    safeFetch(`${originBase}/robots.txt`, 5000),
    safeFetch(`${originBase}/llms.txt`, 5000),
    safeFetch(`${originBase}/sitemap.xml`, 5000),
  ]);

  // Gather raw signals from the homepage.
  const title = ($("title").first().text() || "").trim();
  const metaDesc = ($('meta[name="description"]').attr("content") || "").trim();
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const h1s = $("h1");
  const h2s = $("h2");
  const headingText = []
    .concat(
      $("h1, h2, h3")
        .map((i, el) => $(el).text().trim())
        .get()
    )
    .join(" ")
    .toLowerCase();

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").length : 0;

  const semanticTags = ["main", "article", "section", "header", "footer", "nav"];
  const semanticFound = semanticTags.filter((t) => $(t).length > 0);

  const og = {
    title: $('meta[property="og:title"]').attr("content"),
    desc: $('meta[property="og:description"]').attr("content"),
    image: $('meta[property="og:image"]').attr("content"),
  };
  const ogCount = Object.values(og).filter(Boolean).length;

  // Parse JSON-LD structured data blocks.
  const jsonLdTypes = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const graph = item["@graph"] ? item["@graph"] : [item];
        for (const node of graph) {
          if (node && node["@type"]) {
            const t = Array.isArray(node["@type"])
              ? node["@type"]
              : [node["@type"]];
            t.forEach((x) => jsonLdTypes.push(String(x)));
          }
        }
      }
    } catch (e) {
      // Malformed JSON-LD is ignored rather than crashing the audit.
    }
  });
  const hasType = (name) =>
    jsonLdTypes.some((t) => t.toLowerCase() === name.toLowerCase());
  const hasAnyType = (names) => names.some((n) => hasType(n));

  // robots.txt: does it block the AI crawlers?
  const robotsText = (robots.text || "").toLowerCase();
  const robotsExists = robots.ok && robotsText.length > 0;
  const blockedBots = AI_BOTS.filter((bot) => {
    const re = new RegExp(
      `user-agent:\\s*${bot.toLowerCase()}[\\s\\S]*?disallow:\\s*/`,
      "i"
    );
    return re.test(robotsText);
  });
  const blocksAllRe = /user-agent:\s*\*[\s\S]*?disallow:\s*\/\s*(\n|$)/i;
  const blocksEveryone = blocksAllRe.test(robots.text || "");

  const llmsExists = llms.ok && (llms.text || "").trim().length > 0;
  const sitemapExists =
    sitemap.ok && (sitemap.text || "").toLowerCase().includes("<urlset") ||
    (sitemap.text || "").toLowerCase().includes("<sitemapindex");

  // Question-style headings signal answer-ready content.
  const questionWords = ["what", "how", "why", "when", "where", "who", "can", "is", "do"];
  const hasQuestionHeadings =
    /\?/.test(headingText) ||
    questionWords.some((w) => new RegExp(`(^|\\s)${w}\\s`).test(headingText));

  const listCount = $("ul, ol").length;

  const linkText = $("a")
    .map((i, el) => ($(el).attr("href") || "") + " " + $(el).text())
    .get()
    .join(" ")
    .toLowerCase();
  const hasAbout = /about/.test(linkText);
  const hasContact = /contact/.test(linkText) || /mailto:/.test(html);

  const images = $("img");
  const imagesWithAlt = images.filter((i, el) => ($(el).attr("alt") || "").trim().length > 0);
  const altRatio = images.length ? imagesWithAlt.length / images.length : 1;

  // ---- Category 1: Structured data (20) ----
  const c1 = [
    {
      ...check(
        "Structured data present",
        jsonLdTypes.length > 0 ? "pass" : "fail",
        jsonLdTypes.length > 0
          ? `Found ${jsonLdTypes.length} structured-data marker(s) on the homepage.`
          : "No JSON-LD structured data was found on the homepage.",
        "Add JSON-LD structured data so answer engines can read your content as facts, not guesses."
      ),
      points: 8,
    },
    {
      ...check(
        "Organisation or website identity",
        hasAnyType(["Organization", "WebSite", "LocalBusiness"]) ? "pass" : "fail",
        hasAnyType(["Organization", "WebSite", "LocalBusiness"])
          ? "Your site tells engines who you are."
          : "No Organisation or WebSite identity markup was found.",
        "Add Organisation schema with your name, logo and social profiles so engines can identify your brand."
      ),
      points: 4,
    },
    {
      ...check(
        "FAQ or question-and-answer markup",
        hasAnyType(["FAQPage", "QAPage"]) ? "pass" : "fail",
        hasAnyType(["FAQPage", "QAPage"])
          ? "You have FAQ markup, which feeds AI answers directly."
          : "No FAQ markup was found.",
        "Add FAQ schema to your key pages. It is one of the most direct ways to appear in AI answers."
      ),
      points: 4,
    },
    {
      ...check(
        "Content-type markup",
        hasAnyType([
          "Article",
          "BlogPosting",
          "Product",
          "Service",
          "BreadcrumbList",
        ])
          ? "pass"
          : "fail",
        hasAnyType(["Article", "BlogPosting", "Product", "Service", "BreadcrumbList"])
          ? "Your content is labelled by type."
          : "No content-type markup (Article, Product, etc.) was found.",
        "Label pages with the right schema type so engines understand what each page is."
      ),
      points: 4,
    },
  ];

  // ---- Category 2: AI crawler access (15) ----
  const crawlerStatus =
    blockedBots.length > 0 || blocksEveryone ? "fail" : robotsExists ? "pass" : "partial";
  const c2 = [
    {
      ...check(
        "robots.txt found",
        robotsExists ? "pass" : "fail",
        robotsExists
          ? "A robots.txt file is in place."
          : "No robots.txt file was found.",
        "Add a robots.txt file so you can control which crawlers reach your site."
      ),
      points: 3,
    },
    {
      ...check(
        "AI crawlers are allowed",
        crawlerStatus,
        blockedBots.length > 0
          ? `Your robots.txt blocks: ${blockedBots.join(", ")}. These power AI answers.`
          : blocksEveryone
          ? "Your robots.txt blocks all crawlers from the whole site."
          : "No AI crawlers appear to be blocked.",
        "Remove any rules that disallow GPTBot, ClaudeBot, PerplexityBot or Google-Extended if you want to appear in AI answers."
      ),
      points: 7,
    },
    {
      ...check(
        "llms.txt file",
        llmsExists ? "pass" : "fail",
        llmsExists
          ? "You have an llms.txt file guiding AI models to your best content."
          : "No llms.txt file was found.",
        "Add an llms.txt file. It is an emerging standard that points AI models to the pages you most want cited."
      ),
      points: 5,
    },
  ];

  // ---- Category 3: Content structure (20) ----
  const c3 = [
    {
      ...check(
        "Single clear main heading",
        h1s.length === 1 ? "pass" : h1s.length === 0 ? "fail" : "partial",
        h1s.length === 1
          ? "The page has exactly one H1, as it should."
          : h1s.length === 0
          ? "No H1 heading was found."
          : `The page has ${h1s.length} H1 headings. There should be one.`,
        "Use a single H1 that states the page topic in plain language."
      ),
      points: 5,
    },
    {
      ...check(
        "Sub-heading structure",
        h2s.length >= 2 ? "pass" : h2s.length === 1 ? "partial" : "fail",
        h2s.length >= 2
          ? `Found ${h2s.length} sub-headings, giving the page clear sections.`
          : "The page lacks a clear sub-heading structure.",
        "Break content into sections with H2 headings so engines can lift the part that answers a question."
      ),
      points: 5,
    },
    {
      ...check(
        "Semantic page structure",
        semanticFound.length >= 3 ? "pass" : semanticFound.length >= 1 ? "partial" : "fail",
        `Uses ${semanticFound.length} of the main semantic tags (${semanticFound.join(", ") || "none"}).`,
        "Wrap content in semantic tags like main, article and section so machines can tell content from clutter."
      ),
      points: 5,
    },
    {
      ...check(
        "Enough readable content",
        wordCount >= 300 ? "pass" : wordCount >= 100 ? "partial" : "fail",
        `The homepage has roughly ${wordCount} words of text.`,
        "Give each key page enough substantive text for an engine to understand and quote it."
      ),
      points: 5,
    },
  ];

  // ---- Category 4: Answer readiness (15) ----
  const c4 = [
    {
      ...check(
        "Question-style headings",
        hasQuestionHeadings ? "pass" : "fail",
        hasQuestionHeadings
          ? "Some headings are phrased as questions, matching how people ask AI."
          : "No question-style headings were found.",
        "Phrase some headings as the questions your customers ask, then answer them directly beneath."
      ),
      points: 5,
    },
    {
      ...check(
        "FAQ content",
        hasAnyType(["FAQPage", "QAPage"]) || /faq|frequently asked/.test(bodyText.toLowerCase())
          ? "pass"
          : "fail",
        hasAnyType(["FAQPage", "QAPage"]) || /faq|frequently asked/.test(bodyText.toLowerCase())
          ? "An FAQ section is present."
          : "No FAQ content was detected.",
        "Add a short FAQ answering the real questions people ask about what you offer."
      ),
      points: 5,
    },
    {
      ...check(
        "Scannable, extractable content",
        listCount >= 2 ? "pass" : listCount === 1 ? "partial" : "fail",
        listCount > 0
          ? `Found ${listCount} list(s), which engines find easy to lift.`
          : "No bulleted or numbered lists were found.",
        "Use short paragraphs and lists. Concise, self-contained answers are the easiest for engines to quote."
      ),
      points: 5,
    },
  ];

  // ---- Category 5: Meta and discoverability (15) ----
  const c5 = [
    {
      ...check(
        "Page title",
        title.length >= 10 && title.length <= 65 ? "pass" : title ? "partial" : "fail",
        title ? `Title: "${title.slice(0, 80)}"` : "No page title was found.",
        "Write a clear title of roughly 50 to 60 characters that states who you are and what you do."
      ),
      points: 4,
    },
    {
      ...check(
        "Meta description",
        metaDesc.length >= 50 && metaDesc.length <= 165
          ? "pass"
          : metaDesc
          ? "partial"
          : "fail",
        metaDesc ? `Description found (${metaDesc.length} characters).` : "No meta description was found.",
        "Add a meta description of roughly 140 to 160 characters summarising the page."
      ),
      points: 4,
    },
    {
      ...check(
        "Social sharing tags",
        ogCount >= 3 ? "pass" : ogCount >= 1 ? "partial" : "fail",
        `Found ${ogCount} of 3 key Open Graph tags.`,
        "Add og:title, og:description and og:image so your links preview well when shared or cited."
      ),
      points: 3,
    },
    {
      ...check(
        "Canonical link",
        canonical ? "pass" : "fail",
        canonical ? "A canonical link is set." : "No canonical link was found.",
        "Add a canonical link so engines know the definitive version of each page."
      ),
      points: 2,
    },
    {
      ...check(
        "Sitemap",
        sitemapExists ? "pass" : "fail",
        sitemapExists ? "A sitemap.xml was found." : "No sitemap.xml was found.",
        "Publish a sitemap.xml so crawlers can find every page you want indexed."
      ),
      points: 2,
    },
  ];

  // ---- Category 6: Trust and entity signals (15) ----
  const hasAuthor =
    $('meta[name="author"]').attr("content") ||
    hasAnyType(["Person"]) ||
    /author/.test(html.toLowerCase());
  const orgHasDetail =
    hasAnyType(["Organization", "LocalBusiness"]) &&
    /"logo"|"sameas"/.test(html.toLowerCase());
  const c6 = [
    {
      ...check(
        "Author or authority signals",
        hasAuthor ? "pass" : "fail",
        hasAuthor ? "Author or authorship signals are present." : "No author signals were found.",
        "Name the people behind your content. Engines favour content with clear authorship and expertise."
      ),
      points: 4,
    },
    {
      ...check(
        "About page",
        hasAbout ? "pass" : "fail",
        hasAbout ? "An About page is linked." : "No About page link was found.",
        "Link to a clear About page. It helps engines understand and trust your organisation."
      ),
      points: 3,
    },
    {
      ...check(
        "Contact details",
        hasContact ? "pass" : "fail",
        hasContact ? "Contact details or a contact link are present." : "No contact details were found.",
        "Make contact details easy to find. Reachability is a trust signal."
      ),
      points: 3,
    },
    {
      ...check(
        "Complete organisation identity",
        orgHasDetail ? "pass" : hasAnyType(["Organization", "LocalBusiness"]) ? "partial" : "fail",
        orgHasDetail
          ? "Your organisation markup includes a logo and linked profiles."
          : "Organisation markup is missing a logo or linked social profiles.",
        "Enrich your Organisation schema with a logo and sameAs links to your verified profiles."
      ),
      points: 5,
    },
  ];

  // Also fold image alt text into the content category as a note.
  c3.push({
    ...check(
      "Image alt text",
      altRatio >= 0.8 ? "pass" : altRatio >= 0.4 ? "partial" : "fail",
      images.length
        ? `${imagesWithAlt.length} of ${images.length} images have descriptive alt text.`
        : "No images to check.",
      "Describe images with alt text so their meaning is not lost to machines."
    ),
    points: 0, // informational, does not change the score weighting
  });

  const categories = [
    { id: "structured-data", name: "Structured data", tagline: "Can engines read your content as facts?", checks: c1 },
    { id: "crawler-access", name: "AI crawler access", tagline: "Are the AI engines allowed in?", checks: c2 },
    { id: "content-structure", name: "Content structure", tagline: "Is the page organised for machines?", checks: c3 },
    { id: "answer-readiness", name: "Answer readiness", tagline: "Is your content ready to be quoted?", checks: c4 },
    { id: "discoverability", name: "Meta and discoverability", tagline: "Can you be found and previewed?", checks: c5 },
    { id: "trust-signals", name: "Trust and entity signals", tagline: "Do engines trust who you are?", checks: c6 },
  ].map((cat) => {
    const { earned, max } = scoreChecks(cat.checks);
    return {
      ...cat,
      score: earned,
      max,
      checks: cat.checks.map(({ points, ...rest }) => rest),
    };
  });

  const total = categories.reduce((s, c) => s + c.score, 0);
  const maxTotal = categories.reduce((s, c) => s + c.max, 0);
  const score = Math.round((total / maxTotal) * 100);

  let grade, headline;
  if (score >= 85) {
    grade = "Excellent";
    headline = "Your site is well positioned to appear in AI answers.";
  } else if (score >= 70) {
    grade = "Strong";
    headline = "A solid foundation, with a few clear wins still on the table.";
  } else if (score >= 50) {
    grade = "Developing";
    headline = "The basics are forming, but AI engines are missing a lot.";
  } else if (score >= 30) {
    grade = "Needs work";
    headline = "Significant gaps are keeping you out of AI answers.";
  } else {
    grade = "At risk";
    headline = "AI answer engines can barely see your site right now.";
  }

  return { domain, url: finalUrl, score, grade, headline, categories };
}

// ---- Vercel entry point ----------------------------------------------------

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    const { domain } = body || {};
    if (!domain) {
      res.status(400).json({ error: "Please enter a website address." });
      return;
    }

    const { domain: clean, url } = normaliseDomain(domain);
    if (!clean || !clean.includes(".")) {
      res.status(400).json({ error: "That does not look like a website address." });
      return;
    }

    const result = await analyse(url, clean);
    if (result.error) {
      res.status(200).json(result);
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: "Something went wrong while auditing. Please try again." });
  }
};
