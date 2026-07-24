/**
 * Showcase video recorder — drives the 5 core features and records each as a video clip.
 *
 * Prerequisites: server running on localhost:5050 with the local SQLite DB
 *   DATABASE_URL=sqlite:///$(pwd)/hr_platform.db python run.py
 *
 * Usage:
 *   node scripts/record_showcase.js            # record all clips
 *   node scripts/record_showcase.js chat leave # record specific clips
 *
 * Output: docs/showcase/media/raw/<feature>.webm
 * Convert to GIF/MP4 afterwards with ffmpeg (see docs/showcase/README).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:5050';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'showcase', 'media', 'raw');
const VIEWPORT = { width: 1280, height: 800 };

const ACCOUNTS = {
  employee: { email: 'john.smith@company.com', password: 'demo123', name: 'John Smith', title: 'Employee', badge: 'EMP' },
  manager: { email: 'sarah.chen@company.com', password: 'demo123', name: 'Sarah Chen', title: 'Manager', badge: 'MGR' },
  hr_admin: { email: 'emily.rodriguez@company.com', password: 'demo123', name: 'Emily Rodriguez', title: 'HR Administrator', badge: 'HR' },
};

// Fake cursor overlay so viewers can follow the mouse in recordings
const CURSOR_SCRIPT = `
  (() => {
    if (window.__showcaseCursor) return;
    window.__showcaseCursor = true;
    document.addEventListener('DOMContentLoaded', () => {
      const dot = document.createElement('div');
      dot.style.cssText = [
        'position:fixed', 'z-index:999999', 'width:18px', 'height:18px',
        'border-radius:50%', 'background:rgba(59,130,246,0.45)',
        'border:2px solid rgba(37,99,235,0.9)', 'pointer-events:none',
        'transform:translate(-50%,-50%)', 'transition:width .12s,height .12s',
        'left:-50px', 'top:-50px',
      ].join(';');
      document.body.appendChild(dot);
      document.addEventListener('mousemove', (e) => {
        dot.style.left = e.clientX + 'px';
        dot.style.top = e.clientY + 'px';
      }, true);
      document.addEventListener('mousedown', () => { dot.style.width = '26px'; dot.style.height = '26px'; }, true);
      document.addEventListener('mouseup', () => { dot.style.width = '18px'; dot.style.height = '18px'; }, true);
    });
  })();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiLogin(request, role) {
  const acc = ACCOUNTS[role];
  const resp = await request.post(`${BASE_URL}/api/v2/auth/login`, {
    data: { email: acc.email, password: acc.password },
  });
  const body = await resp.json();
  if (!body.success) throw new Error(`API login failed for ${role}: ${JSON.stringify(body.error)}`);
  return body.data;
}

/** Smoothly move the cursor to an element, hover briefly, then click. */
async function moveAndClick(page, selector, { hoverMs = 350 } = {}) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: 'visible', timeout: 10000 });
  const box = await el.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 25 });
  await sleep(hoverMs);
  await el.click();
}

/** Type into a field with a human-ish cadence. */
async function typeSlow(page, selector, text, delay = 45) {
  await moveAndClick(page, selector, { hoverMs: 200 });
  await page.locator(selector).first().pressSequentially(text, { delay });
}

async function recordClip(browser, name, role, tokens, flow) {
  console.log(`▶ recording: ${name} (as ${role})`);
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT_DIR, size: VIEWPORT },
  });
  await context.addInitScript(CURSOR_SCRIPT);
  // role === null → the flow performs a real UI login itself (e.g. the hero overview)
  if (role) {
    const acc = ACCOUNTS[role];
    await context.addInitScript(
      ([t, a]) => {
        localStorage.setItem('auth_token', t.access_token);
        if (t.refresh_token) localStorage.setItem('refresh_token', t.refresh_token);
        localStorage.setItem('hr_current_role', a.role);
        localStorage.setItem('hr_user_name', a.name);
        localStorage.setItem('hr_user_role', a.title);
        localStorage.setItem('hr_role_badge', a.badge);
        localStorage.setItem('hr_user_email', a.email);
      },
      [tokens, { ...acc, role }]
    );
  }

  const page = await context.newPage();
  try {
    await flow(page);
    await sleep(1500); // hold the final frame
  } catch (err) {
    console.error(`✗ ${name} failed: ${err.message}`);
    throw err;
  } finally {
    const video = page.video();
    await context.close();
    if (video) {
      const tmpPath = await video.path();
      const finalPath = path.join(OUT_DIR, `${name}.webm`);
      fs.renameSync(tmpPath, finalPath);
      console.log(`✓ saved ${finalPath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Feature flows
// ---------------------------------------------------------------------------

const FLOWS = {
  // 1. Conversational HR chat — ask a question, watch the agent answer
  chat: {
    role: 'employee',
    run: async (page) => {
      await page.goto(`${BASE_URL}/chat`);
      await page.waitForLoadState('domcontentloaded');
      await sleep(2000);
      // Count real agent replies (the typing indicator reuses the same class)
      const countReplies = `[...document.querySelectorAll('.agent-message-wrapper')]
        .filter((el) => !el.id.startsWith('typing-indicator')).length`;
      const before = await page.evaluate(`(${countReplies})`);
      await typeSlow(page, '#chat-input', 'How many vacation days do I have left this year?');
      await sleep(400);
      await moveAndClick(page, '#send-btn');
      await page.waitForFunction(`(${countReplies}) > ${before}`, { timeout: 45000 });
      await sleep(4000); // let the response render/stream fully
    },
  },

  // 2. Leave management — balances, calendar range pick, submit request
  leave: {
    role: 'employee',
    run: async (page) => {
      await page.goto(`${BASE_URL}/leave`);
      await page.waitForLoadState('domcontentloaded');
      await sleep(2500); // balance cards
      // Jump to next month so a full range of selectable days is guaranteed
      await moveAndClick(page, '#calendar-picker .calendar-nav-btn:last-of-type');
      await sleep(800);
      const days = page.locator('#calendar-picker .calendar-day:not(.empty):not(.disabled)');
      const count = await days.count();
      const startEl = days.nth(Math.min(8, count - 4));
      const endEl = days.nth(Math.min(11, count - 1));
      const b1 = await startEl.boundingBox();
      await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2, { steps: 20 });
      await sleep(350);
      await startEl.click();
      await sleep(700);
      const b2 = await endEl.boundingBox();
      await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2, { steps: 15 });
      await sleep(350);
      await endEl.click();
      await sleep(800);
      await moveAndClick(page, '#leave-type');
      await page.selectOption('#leave-type', { index: 1 });
      await sleep(500);
      await typeSlow(page, '#reason', 'Family trip to Vancouver');
      await sleep(500);
      // Guard: if the calendar didn't sync the hidden date inputs, submission
      // would be silently blocked by HTML5 validation
      const datesOk = await page.evaluate(
        () => !!(document.getElementById('start-date').value && document.getElementById('end-date').value)
      );
      if (!datesOk) throw new Error('calendar selection did not populate start/end dates');
      await moveAndClick(page, '#leave-form button[type="submit"], #leave-form .btn-primary');
      // A confirmation modal summarises the request — confirm it
      await sleep(1500);
      await moveAndClick(page, '#leave-modal-confirm');
      // Wait for the request history to refresh with the new entry
      await page
        .waitForFunction(() => document.querySelectorAll('#leave-history-tbody tr').length > 0, { timeout: 15000 })
        .catch(() => {});
      await sleep(1200);
      await page.locator('#leave-history-tbody').scrollIntoViewIfNeeded().catch(() => {});
      await sleep(2000);
    },
  },

  // 3. Employee directory — grid, live search, list view, org chart
  directory: {
    role: 'hr_admin',
    run: async (page) => {
      await page.goto(`${BASE_URL}/directory`);
      await page.waitForLoadState('domcontentloaded');
      await sleep(2500); // grid of employee cards
      await typeSlow(page, '#directory-search', 'engineering', 70);
      await sleep(1800);
      const search = page.locator('#directory-search');
      await search.fill('');
      await sleep(800);
      await moveAndClick(page, '#list-view-btn');
      await sleep(2000);
      await moveAndClick(page, '#org-chart-btn');
      await sleep(2500);
      await moveAndClick(page, '#grid-view-btn');
      await sleep(1500);
    },
  },

  // 4. Document center — templates + drag-drop upload with progress
  documents: {
    role: 'hr_admin',
    run: async (page) => {
      await page.goto(`${BASE_URL}/documents`);
      await page.waitForLoadState('domcontentloaded');
      await sleep(2500); // template cards
      const uploadZone = page.locator('#upload-zone');
      if (await uploadZone.isVisible().catch(() => false)) {
        const box = await uploadZone.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
        await sleep(600);
      }
      const samplePath = path.join(OUT_DIR, '..', 'sample_policy.pdf');
      await page.setInputFiles('#file-input', samplePath);
      await sleep(3500); // progress bar + uploaded file appears
      await page.mouse.wheel(0, 300);
      await sleep(2000);
    },
  },

  // 5. Analytics dashboard — stats, charts, filters
  analytics: {
    role: 'hr_admin',
    run: async (page) => {
      await page.goto(`${BASE_URL}/analytics`);
      await page.waitForLoadState('domcontentloaded');
      await sleep(3500); // stat tiles + chart animations
      const filter = page.locator('#department-filter');
      if (await filter.isVisible().catch(() => false)) {
        await moveAndClick(page, '#department-filter');
        await page.selectOption('#department-filter', { index: 1 }).catch(() => {});
        await sleep(2000);
        await page.selectOption('#department-filter', { index: 0 }).catch(() => {});
        await sleep(1000);
      }
      await page.mouse.wheel(0, 350);
      await sleep(2000);
      await page.mouse.wheel(0, 350);
      await sleep(2000);
      await page.mouse.wheel(0, -700);
      await sleep(1500);
    },
  },
};

// Ask a question in the chat and wait for the agent's reply to render
async function askAndWait(page, question, { settle = 2500 } = {}) {
  const countReplies = `[...document.querySelectorAll('.agent-message-wrapper')]
    .filter((el) => !el.id.startsWith('typing-indicator')).length`;
  const before = await page.evaluate(`(${countReplies})`);
  await typeSlow(page, '#chat-input', question);
  await sleep(400);
  await moveAndClick(page, '#send-btn');
  await page.waitForFunction(`(${countReplies}) > ${before}`, { timeout: 60000 });
  await sleep(settle);
}

Object.assign(FLOWS, {
  // 6. Approval workflow — manager approves John's pending leave request
  workflows: {
    role: 'manager',
    run: async (page) => {
      await page.goto(`${BASE_URL}/workflows`);
      await page.waitForLoadState('domcontentloaded');
      await sleep(3000); // pending card renders
      await moveAndClick(page, '.approval-card .btn-approve');
      await sleep(1500); // confirm modal
      await moveAndClick(page, '#approve-modal-confirm');
      await sleep(3500); // card resolves, notification fires
    },
  },

  // 7. Multi-agent routing — three domains, three different agent badges
  routing: {
    role: 'employee',
    run: async (page) => {
      await page.goto(`${BASE_URL}/chat`);
      await page.waitForLoadState('domcontentloaded');
      await sleep(2000);
      await askAndWait(page, 'How many vacation days do I have left?');
      await askAndWait(page, 'What dental plans can I enroll in?');
      await askAndWait(page, "What is the company's remote work policy?");
      // Expand the reasoning trace of the last answer and grab a still
      const reasonBtn = page.locator('.reasoning-btn').last();
      if (await reasonBtn.isVisible().catch(() => false)) {
        await moveAndClick(page, '.reasoning-btn >> nth=-1');
        await sleep(1500);
        await page.screenshot({
          path: path.join(OUT_DIR, '..', 'reasoning.png'),
          fullPage: false,
        });
        await sleep(1500);
      }
    },
  },

  // 8. PII protection — compliance scan masks sensitive data on screen
  pii: {
    role: 'hr_admin',
    run: async (page) => {
      await page.goto(`${BASE_URL}/chat`);
      await page.waitForLoadState('domcontentloaded');
      await sleep(2000);
      await askAndWait(
        page,
        'Scan this text for PII and mask it: Employee John called from 416-555-0199, his SSN is 123-45-6789 and personal email is john.home@gmail.com',
        { settle: 5000 }
      );
    },
  },

  // 8b. RAG grounding — question misses the static KB, answer arrives with
  // retrieved policy sources rendered as citation chips
  rag: {
    role: 'employee',
    run: async (page) => {
      await page.goto(`${BASE_URL}/chat`);
      await page.waitForLoadState('domcontentloaded');
      await sleep(2000);
      await askAndWait(
        page,
        'After I resign, how long does the company keep my personnel file before deleting it?',
        { settle: 4500 }
      );
      await page.screenshot({
        path: path.join(OUT_DIR, '..', 'rag_citations.png'),
        fullPage: false,
      });
      await sleep(1000);
    },
  },

  // 9. Hero overview — real login → dashboard → ask the AI → leave → benefits
  overview: {
    role: null,
    run: async (page) => {
      await page.goto(`${BASE_URL}/login`);
      await page.waitForLoadState('domcontentloaded');
      await page.evaluate(() => localStorage.clear());
      await page.goto(`${BASE_URL}/login`);
      await page.waitForLoadState('domcontentloaded');
      await sleep(1200);
      await typeSlow(page, '#signinEmail', ACCOUNTS.employee.email, 35);
      await typeSlow(page, '#signinPassword', ACCOUNTS.employee.password, 60);
      await moveAndClick(page, '#signinBtn');
      await page.waitForURL('**/dashboard', { timeout: 15000 });
      await sleep(3000); // dashboard
      await moveAndClick(page, '.sidebar-nav a[href="/chat"]');
      await page.waitForLoadState('domcontentloaded');
      await sleep(1500);
      await askAndWait(page, 'How many vacation days do I have left this year?', { settle: 3500 });
      await moveAndClick(page, '.sidebar-nav a[href="/leave"]');
      await page.waitForLoadState('domcontentloaded');
      await sleep(3000); // balance cards + calendar
      await moveAndClick(page, '.sidebar-nav a[href="/benefits"]');
      await page.waitForLoadState('domcontentloaded');
      await sleep(3000);
    },
  },
});

// ---------------------------------------------------------------------------

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const requested = process.argv.slice(2);
  const names = requested.length ? requested : Object.keys(FLOWS);

  const browser = await chromium.launch({ headless: true });
  const request = (await browser.newContext()).request;

  // Fetch a real JWT per role once
  const tokens = {};
  for (const role of new Set(names.map((n) => FLOWS[n] && FLOWS[n].role).filter(Boolean))) {
    tokens[role] = await apiLogin(request, role);
  }

  let failed = 0;
  for (const name of names) {
    const flow = FLOWS[name];
    if (!flow) { console.error(`unknown clip: ${name}`); failed++; continue; }
    try {
      await recordClip(browser, name, flow.role, tokens[flow.role], flow.run);
    } catch (e) {
      failed++;
    }
  }

  await browser.close();
  console.log(failed ? `\n${failed} clip(s) failed` : '\nAll clips recorded ✓');
  process.exit(failed ? 1 : 0);
})();
