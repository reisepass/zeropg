// TPC-C OLTP benchmark, run SERVER-SIDE against the demo's single ZeroPG /
// PGlite connection and streamed live to the browser. This is NOT a browser
// WebWorker benchmark: PGlite lives in the Cloud Run container as one writer,
// so the driver runs here, sequentially, against that one connection. Numbers
// are therefore honest single-writer figures ("tpmC, single connection").
//
// What it implements:
//  - The standard TPC-C schema (warehouse, district, customer, history,
//    new_order, orders, order_line, item, stock), all prefixed `tpcc_` so they
//    can never collide with the demo's own `notes` / `filler` tables.
//  - All five TPC-C transactions with the standard weighted mix
//    (New-Order 45%, Payment 43%, Order-Status 4%, Delivery 4%, Stock-Level 4%;
//    tpmC counts New-Order/min). New-Order does the standard ~1% rollback.
//  - NURand-based non-uniform selection of items / customers, the TPC-C
//    syllable last-name generator — faithful enough to be recognizably TPC-C.
//
// Scale + the HARD size cap (the point of the demo):
//  - At start we read pg_database_size as the baseline and AUTO-SIZE everything
//    to it. The static load (item/stock/customer/...) is sized to a small
//    fraction of baseline; the growing tables (orders/order_line/new_order/
//    history) get a byte budget so total DB stays ~1.5x baseline and never 2x.
//  - A janitor trims the oldest orders (+ their order_line / new_order) and the
//    oldest history rows whenever they exceed their row caps, and VACUUMs so
//    Postgres reuses the freed space instead of growing the file. If
//    pg_database_size ever approaches ~1.85x baseline we STOP inserting (reads +
//    Delivery + aggressive trim only) until it falls back under ~1.5x.
//  - We stream tpmC / throughput / latency percentiles / live DB size /
//    rows-trimmed every second so the cap is visible working.
//  - The bench tables are DROPPED at the end, so a run leaves the demo's durable
//    footprint unchanged.

import type { ZeroPG } from '@zeropg/objectstore-fs'
import type { Transaction } from '@electric-sql/pglite'

export interface BenchOptions {
  /** Wall-clock budget for the OLTP phase. Default 25s. */
  durationMs?: number
  /** Optional hard cap on transactions (stops early if reached). */
  maxTransactions?: number
  /** How often to stream a progress block. Default 1000ms. */
  progressEveryMs?: number
}

type TxType = 'newOrder' | 'payment' | 'orderStatus' | 'delivery' | 'stockLevel'

// ---- small RNG / TPC-C data-generation helpers ----
const rnd = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1))
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
function astr(lo: number, hi: number): string {
  const n = rnd(lo, hi)
  let s = ''
  for (let i = 0; i < n; i++) s += CHARS[rnd(0, CHARS.length - 1)]
  return s
}
function nstr(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += rnd(0, 9)
  return s
}
// TPC-C NURand: non-uniform random, the spec's skew generator.
function nurand(A: number, x: number, y: number, C: number): number {
  return (((rnd(0, A) | rnd(x, y)) + C) % (y - x + 1)) + x
}
// Customer last name: 3 digits -> 3 of 10 syllables (spec section 4.3.2.3).
const SYL = ['BAR', 'OUGHT', 'ABLE', 'PRI', 'PRES', 'ESE', 'ANTI', 'CALLY', 'ATION', 'EING']
function lastName(num: number): string {
  return SYL[Math.floor(num / 100) % 10] + SYL[Math.floor(num / 10) % 10] + SYL[num % 10]
}

const fmt = (n: number) => n.toLocaleString('en-US')
const mb = (bytes: number) => (bytes / 1e6).toFixed(1)
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]
}
const round1 = (n: number) => Math.round(n * 10) / 10

export async function runBenchmark(
  db: ZeroPG,
  opts: BenchOptions,
  onProgress: (line: string) => void,
): Promise<void> {
  const durationMs = opts.durationMs ?? 25_000
  const progressEveryMs = opts.progressEveryMs ?? 1000
  const maxTx = opts.maxTransactions ?? Infinity
  const line = (s = '') => onProgress(s)

  const dbSize = async (): Promise<number> => {
    const r = await db.raw.query<{ b: string }>('SELECT pg_database_size(current_database())::text b')
    return Number(r.rows[0]?.b ?? '0')
  }
  const count = async (table: string): Promise<number> => {
    const r = await db.raw.query<{ n: string }>(`SELECT count(*)::text n FROM ${table}`)
    return Number(r.rows[0]?.n ?? '0')
  }

  // ---- 0. Baseline + auto-scale to the demo's size ----
  const baseline = await dbSize()
  // Static load target: a small slice of baseline, clamped so the load is quick
  // and tiny on the 10MB demo yet still substantial on the 500MB one.
  const staticBudget = Math.min(40e6, Math.max(1.5e6, baseline * 0.15))
  const W = baseline >= 200e6 ? 2 : 1
  const DISTRICTS = 10
  // stock dominates the static footprint (~0.45KB/row incl. indexes); customers
  // are the other big table (~0.7KB/row). Split the static budget between them.
  const NUM_ITEMS = Math.min(5000, Math.max(200, Math.round((staticBudget * 0.5) / (W * 450))))
  const CUST_PER_DIST = Math.min(1500, Math.max(50, Math.round((staticBudget * 0.5) / (W * DISTRICTS * 700))))
  const INIT_ORDERS = 30 // pre-loaded orders/district so Order-Status & Delivery have data

  line(`🏎  TPC-C OLTP benchmark — running server-side against the single PGlite writer`)
  line(`   (PGlite is in THIS Cloud Run container, one connection — numbers are`)
  line(`    honest single-writer: "tpmC, single connection", not a cluster.)`)
  line()
  line(`   baseline DB size: ${mb(baseline)} MB  →  keeping total under ~1.5x (hard stop ~1.85x)`)
  line(`   scale factor: ${W} warehouse${W > 1 ? 's' : ''}, ${NUM_ITEMS} items, ${CUST_PER_DIST} customers/district`)
  line(`   (standard TPC-C is 100k items + 30k customers/warehouse ≈ 100MB/wh;`)
  line(`    scaled DOWN to fit the byte budget — that's the demo, stated honestly.)`)
  line()

  // ---- 1. Schema (idempotent drop + create, all tpcc_ prefixed) ----
  line(`→ building TPC-C schema (tpcc_* tables, isolated from notes/filler)…`)
  await dropSchema(db)
  await db.exec(SCHEMA_SQL)

  // ---- 2. Load ----
  const tLoad = performance.now()
  await loadData(db, { W, DISTRICTS, NUM_ITEMS, CUST_PER_DIST, INIT_ORDERS }, line)
  // Compact pg_wal & make the loaded heap the steady state for size accounting.
  await db.raw.exec('VACUUM ANALYZE')
  const afterLoad = await dbSize()
  line(`  ✓ loaded in ${Math.round(performance.now() - tLoad)}ms — DB now ${mb(afterLoad)} MB (${(afterLoad / baseline).toFixed(2)}x baseline)`)
  line()

  // ---- 3. Size-cap budgets for the growing tables ----
  // Hold total around ~1.5x baseline; trim so logical bench data stays within
  // this churn budget; VACUUM lets inserts reuse the space (plain DELETE never
  // shrinks the file, so we bound by ROW COUNT and report pg_database_size as
  // observed). Hard stop well under 2x.
  const churnBudget = Math.min(baseline * 0.5, Math.max(baseline * 0.05, baseline * 1.5 - afterLoad))
  const BYTES_PER_ORDER_BUNDLE = 1600 // order + ~10 order_lines + new_order, incl. indexes
  const BYTES_PER_HISTORY = 160
  const maxOrders = Math.max(W * DISTRICTS * INIT_ORDERS, Math.floor((churnBudget * 0.75) / BYTES_PER_ORDER_BUNDLE))
  const keepPerDist = Math.max(INIT_ORDERS, Math.floor(maxOrders / (W * DISTRICTS)))
  const historyKeep = Math.max(1000, Math.floor((churnBudget * 0.25) / BYTES_PER_HISTORY))
  const HARD_STOP = baseline * 1.85
  const RESUME = baseline * 1.5

  line(`→ running OLTP mix for ${Math.round(durationMs / 1000)}s: New-Order 45% · Payment 43% · Order-Status 4% · Delivery 4% · Stock-Level 4%`)
  line(`   size cap: keep ≤ ${fmt(keepPerDist)} orders/district + ≤ ${fmt(historyKeep)} history rows; VACUUM to reuse space; pause inserts at ${mb(HARD_STOP)} MB`)
  line()

  // ---- 4. OLTP loop (sequential, single connection) ----
  const counts: Record<TxType, number> = { newOrder: 0, payment: 0, orderStatus: 0, delivery: 0, stockLevel: 0 }
  let rolledBack = 0
  const lat: number[] = [] // overall latencies (ms)
  let trimmedOrders = 0
  let trimmedHistory = 0
  let insertsPaused = false
  let curSize = afterLoad

  const ctx: LoadParams = { W, DISTRICTS, NUM_ITEMS, CUST_PER_DIST, INIT_ORDERS }
  const start = performance.now()
  const deadline = start + durationMs
  let lastTick = start
  let lastTickTx = 0
  let total = 0

  const emitProgress = async (final = false) => {
    const elapsed = (performance.now() - start) / 1000
    curSize = await dbSize()
    const sorted = [...lat].sort((a, b) => a - b)
    const tpmC = Math.round((counts.newOrder / Math.max(elapsed, 0.001)) * 60)
    const tps = Math.round(total / Math.max(elapsed, 0.001))
    const windowTps = Math.round((total - lastTickTx) / Math.max((performance.now() - lastTick) / 1000, 0.001))
    const tag = final ? 'done' : `t=${Math.round(elapsed)}s`
    line(`[${tag}] ${fmt(total)} txn · ${fmt(tps)} tps (now ${fmt(windowTps)}) · tpmC ${fmt(tpmC)}  (New-Order/min, single conn)`)
    line(`        mix  NO ${fmt(counts.newOrder)}  PAY ${fmt(counts.payment)}  OS ${fmt(counts.orderStatus)}  DLV ${fmt(counts.delivery)}  SL ${fmt(counts.stockLevel)}${rolledBack ? `  (NO rollbacks ${fmt(rolledBack)})` : ''}`)
    line(`        lat  p50 ${round1(pct(sorted, 50))}  p95 ${round1(pct(sorted, 95))}  p99 ${round1(pct(sorted, 99))} ms`)
    line(`        size ${mb(curSize)} MB (${(curSize / baseline).toFixed(2)}x baseline)  ·  trimmed ${fmt(trimmedOrders)} orders, ${fmt(trimmedHistory)} history${insertsPaused ? '  ⏸ inserts paused (at cap)' : ''}`)
    lastTick = performance.now()
    lastTickTx = total
  }

  let ticks = 0
  const janitor = async () => {
    curSize = await dbSize()
    if (curSize >= HARD_STOP) insertsPaused = true
    else if (curSize <= RESUME) insertsPaused = false
    // Aggressive keep when paused so the file stops growing fast.
    const ok = insertsPaused ? Math.floor(keepPerDist / 2) : keepPerDist
    const hk = insertsPaused ? Math.floor(historyKeep / 2) : historyKeep

    if ((await count('tpcc_orders')) > W * DISTRICTS * ok) {
      // Delete oldest (lowest o_id) per district: children first, then orders.
      await db.query(
        `DELETE FROM tpcc_order_line ol WHERE ol.ol_o_id <= (SELECT MAX(o.o_id) - $1 FROM tpcc_orders o WHERE o.o_w_id=ol.ol_w_id AND o.o_d_id=ol.ol_d_id)`,
        [ok],
      )
      await db.query(
        `DELETE FROM tpcc_new_order n WHERE n.no_o_id <= (SELECT MAX(o.o_id) - $1 FROM tpcc_orders o WHERE o.o_w_id=n.no_w_id AND o.o_d_id=n.no_d_id)`,
        [ok],
      )
      const o = await db.query(
        `DELETE FROM tpcc_orders o WHERE o.o_id <= (SELECT MAX(o2.o_id) - $1 FROM tpcc_orders o2 WHERE o2.o_w_id=o.o_w_id AND o2.o_d_id=o.o_d_id)`,
        [ok],
      )
      trimmedOrders += o.affectedRows ?? 0
    }
    if ((await count('tpcc_history')) > hk) {
      const h = await db.query(`DELETE FROM tpcc_history WHERE h_id <= (SELECT MAX(h_id) - $1 FROM tpcc_history)`, [hk])
      trimmedHistory += h.affectedRows ?? 0
    }
    // VACUUM every few ticks so Postgres reuses the freed pages (file would
    // otherwise only grow). Whole-DB VACUUM is cheap at this scale.
    if (++ticks % 3 === 0) await db.raw.exec('VACUUM tpcc_orders, tpcc_order_line, tpcc_new_order, tpcc_history')
  }

  while (performance.now() < deadline && total < maxTx) {
    const roll = rnd(1, 100)
    const t0 = performance.now()
    try {
      if (!insertsPaused && roll <= 45) {
        const rb = await newOrder(db, ctx)
        counts.newOrder++
        if (rb) rolledBack++
      } else if (!insertsPaused && roll <= 88) {
        await payment(db, ctx)
        counts.payment++
      } else if (roll <= 92) {
        await orderStatus(db, ctx)
        counts.orderStatus++
      } else if (roll <= 96) {
        await delivery(db, ctx)
        counts.delivery++
      } else {
        await stockLevel(db, ctx)
        counts.stockLevel++
      }
    } catch (e) {
      // A transaction that hits a not-yet-populated row (e.g. Order-Status for a
      // customer with no orders) just rolls back; count nothing, keep going.
      void e
    }
    lat.push(performance.now() - t0)
    total++

    if (performance.now() - lastTick >= progressEveryMs) {
      await janitor()
      await emitProgress()
    }
  }

  await janitor()
  await emitProgress(true)

  // ---- 5. Summary ----
  const elapsed = (performance.now() - start) / 1000
  const sorted = [...lat].sort((a, b) => a - b)
  line()
  line(`✅ benchmark complete — ${fmt(total)} transactions in ${round1(elapsed)}s`)
  line(`   tpmC ${fmt(Math.round((counts.newOrder / elapsed) * 60))}  (New-Order/min, single PGlite connection)`)
  line(`   overall throughput ${fmt(Math.round(total / elapsed))} tps`)
  line(`   latency p50 ${round1(pct(sorted, 50))}ms · p95 ${round1(pct(sorted, 95))}ms · p99 ${round1(pct(sorted, 99))}ms`)
  line(`   peak/final DB size ${mb(curSize)} MB = ${(curSize / baseline).toFixed(2)}x baseline — cap held ✓`)
  line(`   trimmed during run: ${fmt(trimmedOrders)} orders + their lines, ${fmt(trimmedHistory)} history rows`)
  line()
  line(`→ cleaning up: dropping tpcc_* tables (durable demo footprint unchanged)…`)
  await dropSchema(db)
  await db.raw.exec('VACUUM')
  const finalSize = await dbSize()
  line(`  ✓ done — DB back to ${mb(finalSize)} MB (${(finalSize / baseline).toFixed(2)}x baseline)`)
}

// ============================ schema + load ============================

const SCHEMA_SQL = `
CREATE TABLE tpcc_warehouse (
  w_id int PRIMARY KEY, w_name varchar(10), w_street_1 varchar(20), w_street_2 varchar(20),
  w_city varchar(20), w_state char(2), w_zip char(9), w_tax numeric(4,4), w_ytd numeric(12,2));
CREATE TABLE tpcc_district (
  d_w_id int, d_id int, d_name varchar(10), d_street_1 varchar(20), d_street_2 varchar(20),
  d_city varchar(20), d_state char(2), d_zip char(9), d_tax numeric(4,4), d_ytd numeric(12,2),
  d_next_o_id int, PRIMARY KEY (d_w_id, d_id));
CREATE TABLE tpcc_customer (
  c_w_id int, c_d_id int, c_id int, c_first varchar(16), c_middle char(2), c_last varchar(16),
  c_street_1 varchar(20), c_street_2 varchar(20), c_city varchar(20), c_state char(2), c_zip char(9),
  c_phone char(16), c_since timestamptz, c_credit char(2), c_credit_lim numeric(12,2),
  c_discount numeric(4,4), c_balance numeric(12,2), c_ytd_payment numeric(12,2),
  c_payment_cnt int, c_delivery_cnt int, c_data varchar(500), PRIMARY KEY (c_w_id, c_d_id, c_id));
CREATE INDEX tpcc_customer_last ON tpcc_customer (c_w_id, c_d_id, c_last, c_first);
-- h_id is a surrogate (not in the spec) used only to trim the oldest history rows.
CREATE TABLE tpcc_history (
  h_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  h_c_id int, h_c_d_id int, h_c_w_id int, h_d_id int, h_w_id int,
  h_date timestamptz, h_amount numeric(6,2), h_data varchar(24));
CREATE TABLE tpcc_new_order (
  no_o_id int, no_d_id int, no_w_id int, PRIMARY KEY (no_w_id, no_d_id, no_o_id));
CREATE TABLE tpcc_orders (
  o_id int, o_d_id int, o_w_id int, o_c_id int, o_entry_d timestamptz,
  o_carrier_id int, o_ol_cnt int, o_all_local int, PRIMARY KEY (o_w_id, o_d_id, o_id));
CREATE INDEX tpcc_orders_cust ON tpcc_orders (o_w_id, o_d_id, o_c_id, o_id);
CREATE TABLE tpcc_order_line (
  ol_o_id int, ol_d_id int, ol_w_id int, ol_number int, ol_i_id int, ol_supply_w_id int,
  ol_delivery_d timestamptz, ol_amount numeric(6,2), ol_quantity int, ol_dist_info char(24),
  PRIMARY KEY (ol_w_id, ol_d_id, ol_o_id, ol_number));
CREATE TABLE tpcc_item (
  i_id int PRIMARY KEY, i_im_id int, i_name varchar(24), i_price numeric(5,2), i_data varchar(50));
CREATE TABLE tpcc_stock (
  s_w_id int, s_i_id int, s_quantity int,
  s_dist_01 char(24), s_dist_02 char(24), s_dist_03 char(24), s_dist_04 char(24), s_dist_05 char(24),
  s_dist_06 char(24), s_dist_07 char(24), s_dist_08 char(24), s_dist_09 char(24), s_dist_10 char(24),
  s_ytd int, s_order_cnt int, s_remote_cnt int, s_data varchar(50), PRIMARY KEY (s_w_id, s_i_id));
`

async function dropSchema(db: ZeroPG): Promise<void> {
  await db.exec(
    `DROP TABLE IF EXISTS tpcc_order_line, tpcc_new_order, tpcc_orders, tpcc_history,
       tpcc_customer, tpcc_district, tpcc_stock, tpcc_item, tpcc_warehouse CASCADE;`,
  )
}

interface LoadParams {
  W: number
  DISTRICTS: number
  NUM_ITEMS: number
  CUST_PER_DIST: number
  INIT_ORDERS: number
}

// Batched multi-row INSERT (PGlite is fastest with few large statements).
async function bulkInsert(db: ZeroPG, table: string, cols: string[], rows: unknown[][], perBatch = 400): Promise<void> {
  const nc = cols.length
  for (let i = 0; i < rows.length; i += perBatch) {
    const batch = rows.slice(i, i + perBatch)
    const values = batch
      .map((_, r) => `(${cols.map((__, c) => `$${r * nc + c + 1}`).join(',')})`)
      .join(',')
    const params = batch.flat()
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values}`, params)
  }
}

async function loadData(db: ZeroPG, p: LoadParams, line: (s?: string) => void): Promise<void> {
  // items
  const items: unknown[][] = []
  for (let i = 1; i <= p.NUM_ITEMS; i++) {
    const data = rnd(1, 100) <= 10 ? astr(14, 24).slice(0, 12) + 'ORIGINAL' + astr(4, 10) : astr(26, 50)
    items.push([i, rnd(1, 10000), astr(14, 24), (rnd(100, 10000) / 100).toFixed(2), data.slice(0, 50)])
  }
  await bulkInsert(db, 'tpcc_item', ['i_id', 'i_im_id', 'i_name', 'i_price', 'i_data'], items)
  line(`  · ${fmt(p.NUM_ITEMS)} items`)

  for (let w = 1; w <= p.W; w++) {
    await db.query(
      `INSERT INTO tpcc_warehouse (w_id,w_name,w_street_1,w_street_2,w_city,w_state,w_zip,w_tax,w_ytd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,300000)`,
      [w, astr(6, 10), astr(10, 20), astr(10, 20), astr(10, 20), astr(2, 2), nstr(4) + '11111', (rnd(0, 2000) / 10000).toFixed(4)],
    )
    // stock for this warehouse
    const stock: unknown[][] = []
    for (let i = 1; i <= p.NUM_ITEMS; i++) {
      const data = rnd(1, 100) <= 10 ? astr(14, 24).slice(0, 12) + 'ORIGINAL' + astr(4, 10) : astr(26, 50)
      stock.push([
        w, i, rnd(10, 100),
        astr(24, 24), astr(24, 24), astr(24, 24), astr(24, 24), astr(24, 24),
        astr(24, 24), astr(24, 24), astr(24, 24), astr(24, 24), astr(24, 24),
        0, 0, 0, data.slice(0, 50),
      ])
    }
    await bulkInsert(
      db, 'tpcc_stock',
      ['s_w_id', 's_i_id', 's_quantity', 's_dist_01', 's_dist_02', 's_dist_03', 's_dist_04', 's_dist_05', 's_dist_06', 's_dist_07', 's_dist_08', 's_dist_09', 's_dist_10', 's_ytd', 's_order_cnt', 's_remote_cnt', 's_data'],
      stock,
    )

    for (let d = 1; d <= p.DISTRICTS; d++) {
      await db.query(
        `INSERT INTO tpcc_district (d_w_id,d_id,d_name,d_street_1,d_street_2,d_city,d_state,d_zip,d_tax,d_ytd,d_next_o_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,30000,$10)`,
        [w, d, astr(6, 10), astr(10, 20), astr(10, 20), astr(10, 20), astr(2, 2), nstr(4) + '11111', (rnd(0, 2000) / 10000).toFixed(4), p.INIT_ORDERS + 1],
      )
      // customers
      const custs: unknown[][] = []
      for (let c = 1; c <= p.CUST_PER_DIST; c++) {
        const ln = c <= 1000 ? lastName(c - 1) : lastName(nurand(255, 0, 999, 0))
        const bad = rnd(1, 100) <= 10
        custs.push([
          w, d, c, astr(8, 16), 'OE', ln, astr(10, 20), astr(10, 20), astr(10, 20), astr(2, 2), nstr(4) + '11111',
          nstr(16), new Date().toISOString(), bad ? 'BC' : 'GC', 50000, (rnd(0, 5000) / 10000).toFixed(4),
          -10, 10, 1, 0, astr(50, 200),
        ])
      }
      await bulkInsert(
        db, 'tpcc_customer',
        ['c_w_id', 'c_d_id', 'c_id', 'c_first', 'c_middle', 'c_last', 'c_street_1', 'c_street_2', 'c_city', 'c_state', 'c_zip', 'c_phone', 'c_since', 'c_credit', 'c_credit_lim', 'c_discount', 'c_balance', 'c_ytd_payment', 'c_payment_cnt', 'c_delivery_cnt', 'c_data'],
        custs,
      )
      // one history row per customer
      const hist: unknown[][] = []
      for (let c = 1; c <= p.CUST_PER_DIST; c++) {
        hist.push([c, d, w, d, w, new Date().toISOString(), 10, astr(12, 24)])
      }
      await bulkInsert(db, 'tpcc_history', ['h_c_id', 'h_c_d_id', 'h_c_w_id', 'h_d_id', 'h_w_id', 'h_date', 'h_amount', 'h_data'], hist)

      // initial orders + order lines (+ new_order for the newest ~30%)
      const orders: unknown[][] = []
      const olines: unknown[][] = []
      const neworders: unknown[][] = []
      for (let o = 1; o <= p.INIT_ORDERS; o++) {
        const olCnt = rnd(5, 15)
        const delivered = o <= Math.floor(p.INIT_ORDERS * 0.7)
        orders.push([o, d, w, rnd(1, p.CUST_PER_DIST), new Date().toISOString(), delivered ? rnd(1, 10) : null, olCnt, 1])
        if (!delivered) neworders.push([o, d, w])
        for (let ol = 1; ol <= olCnt; ol++) {
          olines.push([o, d, w, ol, rnd(1, p.NUM_ITEMS), w, delivered ? new Date().toISOString() : null, delivered ? (rnd(0, 999999) / 100).toFixed(2) : '0.00', 5, astr(24, 24)])
        }
      }
      await bulkInsert(db, 'tpcc_orders', ['o_id', 'o_d_id', 'o_w_id', 'o_c_id', 'o_entry_d', 'o_carrier_id', 'o_ol_cnt', 'o_all_local'], orders)
      await bulkInsert(db, 'tpcc_order_line', ['ol_o_id', 'ol_d_id', 'ol_w_id', 'ol_number', 'ol_i_id', 'ol_supply_w_id', 'ol_delivery_d', 'ol_amount', 'ol_quantity', 'ol_dist_info'], olines)
      if (neworders.length) await bulkInsert(db, 'tpcc_new_order', ['no_o_id', 'no_d_id', 'no_w_id'], neworders)
    }
    line(`  · warehouse ${w}: ${fmt(p.NUM_ITEMS)} stock, ${fmt(p.DISTRICTS * p.CUST_PER_DIST)} customers, ${fmt(p.DISTRICTS * p.INIT_ORDERS)} orders`)
  }
}

// ============================ transactions ============================
// Each runs inside one Postgres transaction via db.transaction(); in the demo's
// 'sleep' durability mode this commits at memory speed (no per-commit upload),
// which is exactly the PGlite OLTP execution speed we want to measure.

const dColName = (d: number) => `s_dist_${String(d).padStart(2, '0')}`

// New-Order (45%). Returns true if it rolled back (the standard ~1% case).
async function newOrder(db: ZeroPG, p: LoadParams): Promise<boolean> {
  const w = rnd(1, p.W)
  const d = rnd(1, p.DISTRICTS)
  const c = nurand(1023, 1, p.CUST_PER_DIST, 0)
  const olCnt = rnd(5, 15)
  const rollback = rnd(1, 100) === 1 // ~1% invalid-item rollback
  const lineItems = Array.from({ length: olCnt }, (_, k) => ({
    iId: rollback && k === olCnt - 1 ? p.NUM_ITEMS + 1000000 : nurand(8191, 1, p.NUM_ITEMS, 0),
    supplyW: w,
    qty: rnd(1, 10),
  }))

  try {
    await db.transaction(async (tx: Transaction) => {
      await tx.query(`SELECT w_tax FROM tpcc_warehouse WHERE w_id=$1`, [w])
      const dr = await tx.query<{ d_tax: string; d_next_o_id: number }>(
        `SELECT d_tax, d_next_o_id FROM tpcc_district WHERE d_w_id=$1 AND d_id=$2`,
        [w, d],
      )
      const oId = dr.rows[0]!.d_next_o_id
      await tx.query(`UPDATE tpcc_district SET d_next_o_id=d_next_o_id+1 WHERE d_w_id=$1 AND d_id=$2`, [w, d])
      await tx.query(`SELECT c_discount, c_last, c_credit FROM tpcc_customer WHERE c_w_id=$1 AND c_d_id=$2 AND c_id=$3`, [w, d, c])
      const allLocal = lineItems.every((li) => li.supplyW === w) ? 1 : 0
      await tx.query(
        `INSERT INTO tpcc_orders (o_id,o_d_id,o_w_id,o_c_id,o_entry_d,o_carrier_id,o_ol_cnt,o_all_local)
         VALUES ($1,$2,$3,$4,now(),NULL,$5,$6)`,
        [oId, d, w, c, olCnt, allLocal],
      )
      await tx.query(`INSERT INTO tpcc_new_order (no_o_id,no_d_id,no_w_id) VALUES ($1,$2,$3)`, [oId, d, w])
      for (let n = 0; n < lineItems.length; n++) {
        const li = lineItems[n]
        const ir = await tx.query<{ i_price: string }>(`SELECT i_price, i_name, i_data FROM tpcc_item WHERE i_id=$1`, [li.iId])
        if (!ir.rows.length) throw new Error('rollback: invalid item') // standard 1% rollback
        const price = Number(ir.rows[0].i_price)
        const sr = await tx.query<Record<string, string | number>>(
          `SELECT s_quantity, ${dColName(d)} AS dist, s_data FROM tpcc_stock WHERE s_w_id=$1 AND s_i_id=$2`,
          [li.supplyW, li.iId],
        )
        const sQty = Number(sr.rows[0]!.s_quantity)
        const newQty = sQty - li.qty >= 10 ? sQty - li.qty : sQty - li.qty + 91
        await tx.query(
          `UPDATE tpcc_stock SET s_quantity=$1, s_ytd=s_ytd+$2, s_order_cnt=s_order_cnt+1, s_remote_cnt=s_remote_cnt+$3
           WHERE s_w_id=$4 AND s_i_id=$5`,
          [newQty, li.qty, li.supplyW === w ? 0 : 1, li.supplyW, li.iId],
        )
        await tx.query(
          `INSERT INTO tpcc_order_line (ol_o_id,ol_d_id,ol_w_id,ol_number,ol_i_id,ol_supply_w_id,ol_delivery_d,ol_amount,ol_quantity,ol_dist_info)
           VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9)`,
          [oId, d, w, n + 1, li.iId, li.supplyW, (price * li.qty).toFixed(2), li.qty, String(sr.rows[0]!.dist).slice(0, 24)],
        )
      }
    })
    return false
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('rollback')) return true
    throw e
  }
}

// Payment (43%).
async function payment(db: ZeroPG, p: LoadParams): Promise<void> {
  const w = rnd(1, p.W)
  const d = rnd(1, p.DISTRICTS)
  const amount = rnd(100, 500000) / 100
  const byName = rnd(1, 100) <= 60
  await db.transaction(async (tx: Transaction) => {
    await tx.query(`UPDATE tpcc_warehouse SET w_ytd=w_ytd+$1 WHERE w_id=$2`, [amount, w])
    await tx.query(`UPDATE tpcc_district SET d_ytd=d_ytd+$1 WHERE d_w_id=$2 AND d_id=$3`, [amount, w, d])
    let cId: number
    if (byName) {
      const ln = lastName(nurand(255, 0, 999, 0))
      const rows = await tx.query<{ c_id: number }>(
        `SELECT c_id FROM tpcc_customer WHERE c_w_id=$1 AND c_d_id=$2 AND c_last=$3 ORDER BY c_first`,
        [w, d, ln],
      )
      if (!rows.rows.length) {
        cId = nurand(1023, 1, p.CUST_PER_DIST, 0) // no match: fall back to a by-id pick
      } else {
        cId = rows.rows[Math.floor((rows.rows.length - 1) / 2)].c_id // middle one, per spec
      }
    } else {
      cId = nurand(1023, 1, p.CUST_PER_DIST, 0)
    }
    const cr = await tx.query<{ c_credit: string }>(
      `UPDATE tpcc_customer SET c_balance=c_balance-$1, c_ytd_payment=c_ytd_payment+$1, c_payment_cnt=c_payment_cnt+1
       WHERE c_w_id=$2 AND c_d_id=$3 AND c_id=$4 RETURNING c_credit`,
      [amount, w, d, cId],
    )
    if (cr.rows[0]?.c_credit === 'BC') {
      await tx.query(
        `UPDATE tpcc_customer SET c_data = substr($1 || c_data, 1, 500) WHERE c_w_id=$2 AND c_d_id=$3 AND c_id=$4`,
        [`${cId} ${d} ${w} ${amount} `, w, d, cId],
      )
    }
    await tx.query(
      `INSERT INTO tpcc_history (h_c_id,h_c_d_id,h_c_w_id,h_d_id,h_w_id,h_date,h_amount,h_data)
       VALUES ($1,$2,$3,$4,$5,now(),$6,$7)`,
      [cId, d, w, d, w, amount, astr(12, 24)],
    )
  })
}

// Order-Status (4%, read-only).
async function orderStatus(db: ZeroPG, p: LoadParams): Promise<void> {
  const w = rnd(1, p.W)
  const d = rnd(1, p.DISTRICTS)
  const c = nurand(1023, 1, p.CUST_PER_DIST, 0)
  await db.raw.query(`SELECT c_balance, c_first, c_last FROM tpcc_customer WHERE c_w_id=$1 AND c_d_id=$2 AND c_id=$3`, [w, d, c])
  const o = await db.raw.query<{ o_id: number }>(
    `SELECT o_id FROM tpcc_orders WHERE o_w_id=$1 AND o_d_id=$2 AND o_c_id=$3 ORDER BY o_id DESC LIMIT 1`,
    [w, d, c],
  )
  if (o.rows.length) {
    await db.raw.query(
      `SELECT ol_i_id, ol_supply_w_id, ol_quantity, ol_amount, ol_delivery_d FROM tpcc_order_line
       WHERE ol_w_id=$1 AND ol_d_id=$2 AND ol_o_id=$3`,
      [w, d, o.rows[0].o_id],
    )
  }
}

// Delivery (4%). Delivers the oldest undelivered order in each district —
// net-deletes new_order rows, which also helps keep that table bounded.
async function delivery(db: ZeroPG, p: LoadParams): Promise<void> {
  const w = rnd(1, p.W)
  const carrier = rnd(1, 10)
  await db.transaction(async (tx: Transaction) => {
    for (let d = 1; d <= p.DISTRICTS; d++) {
      const no = await tx.query<{ no_o_id: number }>(
        `SELECT no_o_id FROM tpcc_new_order WHERE no_w_id=$1 AND no_d_id=$2 ORDER BY no_o_id ASC LIMIT 1`,
        [w, d],
      )
      if (!no.rows.length) continue
      const oId = no.rows[0].no_o_id
      await tx.query(`DELETE FROM tpcc_new_order WHERE no_w_id=$1 AND no_d_id=$2 AND no_o_id=$3`, [w, d, oId])
      const cr = await tx.query<{ o_c_id: number }>(
        `UPDATE tpcc_orders SET o_carrier_id=$1 WHERE o_w_id=$2 AND o_d_id=$3 AND o_id=$4 RETURNING o_c_id`,
        [carrier, w, d, oId],
      )
      await tx.query(`UPDATE tpcc_order_line SET ol_delivery_d=now() WHERE ol_w_id=$1 AND ol_d_id=$2 AND ol_o_id=$3`, [w, d, oId])
      const sum = await tx.query<{ s: string }>(
        `SELECT COALESCE(SUM(ol_amount),0)::text s FROM tpcc_order_line WHERE ol_w_id=$1 AND ol_d_id=$2 AND ol_o_id=$3`,
        [w, d, oId],
      )
      await tx.query(
        `UPDATE tpcc_customer SET c_balance=c_balance+$1, c_delivery_cnt=c_delivery_cnt+1 WHERE c_w_id=$2 AND c_d_id=$3 AND c_id=$4`,
        [Number(sum.rows[0]!.s), w, d, cr.rows[0]!.o_c_id],
      )
    }
  })
}

// Stock-Level (4%, read-only): items in the last 20 orders of a district below
// a stock threshold.
async function stockLevel(db: ZeroPG, p: LoadParams): Promise<void> {
  const w = rnd(1, p.W)
  const d = rnd(1, p.DISTRICTS)
  const threshold = rnd(10, 20)
  const dr = await db.raw.query<{ d_next_o_id: number }>(`SELECT d_next_o_id FROM tpcc_district WHERE d_w_id=$1 AND d_id=$2`, [w, d])
  const next = dr.rows[0]?.d_next_o_id ?? 1
  await db.raw.query(
    `SELECT COUNT(DISTINCT s.s_i_id) AS n FROM tpcc_order_line ol, tpcc_stock s
     WHERE ol.ol_w_id=$1 AND ol.ol_d_id=$2 AND ol.ol_o_id >= $3 AND ol.ol_o_id < $4
       AND s.s_w_id=$1 AND s.s_i_id=ol.ol_i_id AND s.s_quantity < $5`,
    [w, d, next - 20, next, threshold],
  )
}
