// Shared test helpers: a tiny reporter, unique-fixture naming, an authenticated
// Playwright context, and DOM readers that pull EXACT displayed data out of the
// grids/logs so specs can compare the UI against what was seeded over the wire.

export function makeReporter(name) {
  let pass = 0, fail = 0
  return {
    name,
    ok(msg) { pass++; console.log(`  ok   [${name}] ${msg}`) },
    fail(msg) { fail++; console.error(`  FAIL [${name}] ${msg}`) },
    assert(cond, msg) { cond ? this.ok(msg) : this.fail(msg) },
    eq(a, b, msg) {
      const A = JSON.stringify(a), B = JSON.stringify(b)
      A === B ? this.ok(msg) : this.fail(`${msg} :: expected ${B} got ${A}`)
    },
    counts() { return { pass, fail } },
  }
}

let counter = 0
export function uniq(prefix) { return `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}` }

// Authenticated browser context: log in via the API (cookie stored in the
// context's jar, so the SPA loads already-authenticated).
export async function authedContext(browser, base, password) {
  const context = await browser.newContext()
  const r = await context.request.post(`${base}/studio/api/login`, { data: { password } })
  if (!r.ok()) throw new Error(`test login failed: ${r.status()}`)
  return context
}

// Read the data grid into an array of { col -> { text, isNull, isEmpty, isJson, bool } }.
export async function readGrid(page, testid = 'tb-grid') {
  return page.$$eval(`[data-testid="${testid}"] tbody tr`, (trs) =>
    trs.map((tr) => {
      const cells = {}
      tr.querySelectorAll('td').forEach((td) => {
        const col = td.getAttribute('data-col')
        const span = td.querySelector('.cell')
        cells[col] = {
          text: span ? span.textContent : null,
          isNull: span ? span.getAttribute('data-null') === '1' : false,
          isEmpty: span ? span.getAttribute('data-empty') === '1' : false,
          isJson: span ? span.getAttribute('data-json') === '1' : false,
          bool: span ? span.getAttribute('data-bool') : null,
        }
      })
      return cells
    }),
  )
}

export async function readHeaders(page, testid = 'tb-grid') {
  return page.$$eval(`[data-testid="${testid}"] thead th`, (ths) => ths.map((th) => th.getAttribute('data-col')))
}

export async function readLogs(page) {
  return page.$$eval('[data-testid="log-row"]', (rows) =>
    rows.map((r) => ({
      source: r.querySelector('[data-testid="log-source"]').textContent,
      level: r.querySelector('[data-testid="log-level"]').textContent,
      message: r.querySelector('[data-testid="log-message"]').textContent,
      levelClass: r.querySelector('[data-testid="log-level"]').className,
    })),
  )
}
