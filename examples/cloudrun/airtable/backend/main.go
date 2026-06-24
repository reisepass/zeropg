// airtable-on-zeropg: a minimal Airtable/NocoDB-style backend.
//
// Design goal: TINY + FAST boot on the zeropg single-session PGlite wire.
// NocoDB needs 124 metadata tables and cold-starts ~28s; this does the opposite:
// a fixed 3-table schema, no runtime DDL, a single static Go binary that boots
// in well under a second.
//
// Data model (rows-as-JSONB, deliberately NOT table-per-user-table):
//
//	tbl(id, base_id, name, position, created_at)            -- a user "table"
//	col(id, tbl_id, name, type, position, opts jsonb, ...)  -- a typed column
//	rec(id, tbl_id, data jsonb, created_at, updated_at, version) -- a row; cell
//	                                                               values keyed by col id
//
// Why JSONB-rows: it avoids runtime DDL entirely. On a single serialized session
// every CREATE TABLE / ALTER TABLE a user triggers would be catalog churn with
// awkward lock/atomicity behavior. A fixed schema keeps boot deterministic and
// the migration is three idempotent CREATE TABLE IF NOT EXISTS statements (no
// migration framework, no advisory locks => no pool-1 deadlock).
//
// The prepared-statement wall: pglite-socket is one session and rejects NAMED
// server-side prepared statements with 42P05. pgx works over it ONLY with DSN
// param default_query_exec_mode=cache_describe (extended protocol, cached
// DESCRIBE, no persisted named statements). simple_protocol is avoided: it
// mis-infers JSONB column types. Pool is kept >1 (a pool of 1 can deadlock).
//
// Write semantics: interactive cell edits WAIT for commit and return the updated
// row + version. We never ACK a write before it commits, so the grid never
// "snaps back" to a stale value behind the single-session commit queue.
package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var pool *pgxpool.Pool

const schemaSQL = `
CREATE TABLE IF NOT EXISTS tbl (
  id         text PRIMARY KEY,
  base_id    text NOT NULL DEFAULT 'default',
  name       text NOT NULL,
  position   int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS col (
  id        text PRIMARY KEY,
  tbl_id    text NOT NULL REFERENCES tbl(id) ON DELETE CASCADE,
  name      text NOT NULL,
  type      text NOT NULL DEFAULT 'text',
  position  int  NOT NULL DEFAULT 0,
  opts      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS col_tbl_idx ON col(tbl_id);
CREATE TABLE IF NOT EXISTS rec (
  id         text PRIMARY KEY,
  tbl_id     text NOT NULL REFERENCES tbl(id) ON DELETE CASCADE,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    bigint NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS rec_tbl_idx ON rec(tbl_id);
`

// validTypes are the column types the app understands. Values are validated and
// canonicalised app-side before going into rec.data, so JSONB stays sortable.
var validTypes = map[string]bool{
	"text": true, "number": true, "bool": true, "date": true, "select": true,
}

// ---- small id generator (no external dep): time-ordered + random suffix ----

var (
	idMu   sync.Mutex
	idSeq  uint32
	idBoot = randHex() // per-process random suffix: avoids cross-restart/instance collisions
)

func randHex() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}

func newID(prefix string) string {
	idMu.Lock()
	idSeq++
	s := idSeq
	idMu.Unlock()
	return fmt.Sprintf("%s_%011x%04x%s", prefix, time.Now().UnixMicro(), s&0xffff, idBoot)
}

func main() {
	port := getenv("PORT", "8080")
	dsn := getenv("DATABASE_URL",
		"postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable&default_query_exec_mode=cache_describe")

	ctx := context.Background()

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		log.Fatalf("parse dsn: %v", err)
	}
	// Pool >1 is mandatory on the zeropg wire (pool=1 can deadlock). The wire
	// serialises onto one PGlite session anyway, so a small pool is plenty.
	cfg.MaxConns = 4
	cfg.MinConns = 1
	cfg.MaxConnLifetime = 30 * time.Minute

	// Retry pool+schema bring-up: the db sidecar's wire can lag its /healthz
	// briefly on cold restore, and the first real query can fail once. Close any
	// pool whose probe fails so we don't leak it across retries.
	for i := 0; i < 60; i++ {
		p, e := pgxpool.NewWithConfig(ctx, cfg)
		if e == nil {
			if _, e = p.Exec(ctx, "SELECT 1"); e == nil {
				pool, err = p, nil
				break
			}
			p.Close()
		}
		err = e
		log.Printf("[airtable] waiting for db wire (try %d): %v", i+1, err)
		time.Sleep(1 * time.Second)
	}
	if err != nil {
		log.Fatalf("[airtable] db wire never came up: %v", err)
	}

	// Idempotent boot migration. No advisory locks, no migration table: three
	// CREATE TABLE IF NOT EXISTS statements. maxScale=1 means we're the only
	// writer, so a plain Exec is safe and re-running on a warm restore is a no-op.
	if _, err := pool.Exec(ctx, schemaSQL); err != nil {
		log.Fatalf("[airtable] schema init failed: %v", err)
	}
	log.Printf("[airtable] schema ready")

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	// /wake is the fire-and-forget cold-start trigger from the frontend. It is
	// intentionally boring: a cheap SELECT 1, no migrations, no metadata load,
	// so it never queues behind heavy work on the single session.
	mux.HandleFunc("/wake", func(w http.ResponseWriter, r *http.Request) {
		cctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		_ = pool.Ping(cctx)
		writeJSON(w, 200, map[string]any{"awake": true})
	})

	mux.HandleFunc("/api/tables", handleTables)         // GET list, POST create
	mux.HandleFunc("/api/tables/", handleTableSubpaths) // /{id}, /{id}/columns, /{id}/rows
	mux.HandleFunc("/api/columns/", handleColumn)       // DELETE /{id}
	mux.HandleFunc("/api/rows/", handleRow)             // PATCH/DELETE /{id}

	handler := withCORS(mux)
	log.Printf("[airtable] listening on :%s", port)
	srv := &http.Server{Addr: ":" + port, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

// ---------- types ----------

type Table struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Position int    `json:"position"`
}

type Column struct {
	ID       string         `json:"id"`
	TblID    string         `json:"tbl_id"`
	Name     string         `json:"name"`
	Type     string         `json:"type"`
	Position int            `json:"position"`
	Opts     map[string]any `json:"opts"`
}

type Record struct {
	ID      string         `json:"id"`
	Data    map[string]any `json:"data"`
	Version int64          `json:"version"`
}

// ---------- handlers ----------

func handleTables(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	switch r.Method {
	case http.MethodGet:
		rows, err := pool.Query(ctx,
			`SELECT id, name, position FROM tbl ORDER BY position, created_at`)
		if err != nil {
			httpErr(w, 500, err)
			return
		}
		defer rows.Close()
		out := []Table{}
		for rows.Next() {
			var t Table
			if err := rows.Scan(&t.ID, &t.Name, &t.Position); err != nil {
				httpErr(w, 500, err)
				return
			}
			out = append(out, t)
		}
		writeJSON(w, 200, out)

	case http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		if err := decode(r, &body); err != nil || strings.TrimSpace(body.Name) == "" {
			httpErr(w, 400, errors.New("name required"))
			return
		}
		id := newID("tbl")
		var pos int
		_ = pool.QueryRow(ctx, `SELECT COALESCE(MAX(position)+1,0) FROM tbl`).Scan(&pos)
		if _, err := pool.Exec(ctx,
			`INSERT INTO tbl(id, name, position) VALUES($1,$2,$3)`, id, body.Name, pos); err != nil {
			httpErr(w, 500, err)
			return
		}
		// Seed a couple of default columns so a fresh table shows a usable grid.
		c1 := newID("col")
		c2 := newID("col")
		if _, err := pool.Exec(ctx,
			`INSERT INTO col(id, tbl_id, name, type, position)
			 VALUES($1,$3,'Name','text',0),($2,$3,'Notes','text',1)`,
			c1, c2, id); err != nil {
			log.Printf("[airtable] seed columns: %v", err)
		}
		writeJSON(w, 201, Table{ID: id, Name: body.Name, Position: pos})

	default:
		httpErr(w, 405, errors.New("method not allowed"))
	}
}

// handleTableSubpaths routes /api/tables/{id}, /{id}/columns, /{id}/rows.
func handleTableSubpaths(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/tables/")
	parts := strings.Split(rest, "/")
	tblID := parts[0]
	if tblID == "" {
		httpErr(w, 404, errors.New("not found"))
		return
	}
	if len(parts) == 1 {
		if r.Method == http.MethodDelete {
			deleteTable(w, r, tblID)
			return
		}
		httpErr(w, 405, errors.New("method not allowed"))
		return
	}
	switch parts[1] {
	case "columns":
		handleColumns(w, r, tblID)
	case "rows":
		handleRows(w, r, tblID)
	default:
		httpErr(w, 404, errors.New("not found"))
	}
}

func deleteTable(w http.ResponseWriter, r *http.Request, tblID string) {
	if _, err := pool.Exec(r.Context(), `DELETE FROM tbl WHERE id=$1`, tblID); err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"deleted": tblID})
}

func handleColumns(w http.ResponseWriter, r *http.Request, tblID string) {
	ctx := r.Context()
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, listColumns(ctx, tblID))
	case http.MethodPost:
		var body struct {
			Name string         `json:"name"`
			Type string         `json:"type"`
			Opts map[string]any `json:"opts"`
		}
		if err := decode(r, &body); err != nil || strings.TrimSpace(body.Name) == "" {
			httpErr(w, 400, errors.New("name required"))
			return
		}
		if body.Type == "" {
			body.Type = "text"
		}
		if !validTypes[body.Type] {
			httpErr(w, 400, fmt.Errorf("invalid type %q", body.Type))
			return
		}
		if body.Opts == nil {
			body.Opts = map[string]any{}
		}
		optsJSON, _ := json.Marshal(body.Opts)
		id := newID("col")
		var pos int
		_ = pool.QueryRow(ctx, `SELECT COALESCE(MAX(position)+1,0) FROM col WHERE tbl_id=$1`, tblID).Scan(&pos)
		if _, err := pool.Exec(ctx,
			`INSERT INTO col(id, tbl_id, name, type, position, opts) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
			id, tblID, body.Name, body.Type, pos, string(optsJSON)); err != nil {
			httpErr(w, 500, err)
			return
		}
		writeJSON(w, 201, Column{ID: id, TblID: tblID, Name: body.Name, Type: body.Type, Position: pos, Opts: body.Opts})
	default:
		httpErr(w, 405, errors.New("method not allowed"))
	}
}

func listColumns(ctx context.Context, tblID string) []Column {
	rows, err := pool.Query(ctx,
		`SELECT id, tbl_id, name, type, position, opts FROM col WHERE tbl_id=$1 ORDER BY position`, tblID)
	if err != nil {
		return []Column{}
	}
	defer rows.Close()
	out := []Column{}
	for rows.Next() {
		var c Column
		var optsRaw []byte
		if err := rows.Scan(&c.ID, &c.TblID, &c.Name, &c.Type, &c.Position, &optsRaw); err != nil {
			continue
		}
		_ = json.Unmarshal(optsRaw, &c.Opts)
		out = append(out, c)
	}
	return out
}

func handleColumn(w http.ResponseWriter, r *http.Request) {
	colID := strings.TrimPrefix(r.URL.Path, "/api/columns/")
	if colID == "" {
		httpErr(w, 404, errors.New("not found"))
		return
	}
	if r.Method != http.MethodDelete {
		httpErr(w, 405, errors.New("method not allowed"))
		return
	}
	// Strip the column's key from every row AND delete the def in ONE statement.
	// A single CTE avoids a handler-level interleaving window on the serialized
	// wire (a PATCH slipping between a separate UPDATE and DELETE).
	ctx := r.Context()
	if _, err := pool.Exec(ctx, `
		WITH target AS (SELECT id, tbl_id FROM col WHERE id = $1),
		stripped AS (
			UPDATE rec SET data = data - (SELECT id FROM target)
			WHERE tbl_id = (SELECT tbl_id FROM target)
		)
		DELETE FROM col WHERE id = $1`, colID); err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"deleted": colID})
}

func handleRows(w http.ResponseWriter, r *http.Request, tblID string) {
	ctx := r.Context()
	switch r.Method {
	case http.MethodGet:
		limit := 200
		if l := r.URL.Query().Get("limit"); l != "" {
			if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1000 {
				limit = n
			}
		}
		rows, err := pool.Query(ctx,
			`SELECT id, data, version FROM rec WHERE tbl_id=$1 ORDER BY created_at LIMIT $2`, tblID, limit)
		if err != nil {
			httpErr(w, 500, err)
			return
		}
		defer rows.Close()
		out := []Record{}
		for rows.Next() {
			var rec Record
			var raw []byte
			if err := rows.Scan(&rec.ID, &raw, &rec.Version); err != nil {
				httpErr(w, 500, err)
				return
			}
			_ = json.Unmarshal(raw, &rec.Data)
			out = append(out, rec)
		}
		writeJSON(w, 200, out)

	case http.MethodPost:
		var body struct {
			Data map[string]any `json:"data"`
		}
		_ = decode(r, &body)
		if body.Data == nil {
			body.Data = map[string]any{}
		}
		clean, err := validateCells(ctx, tblID, body.Data)
		if err != nil {
			httpErr(w, 400, err)
			return
		}
		id := newID("rec")
		dataJSON, _ := json.Marshal(clean)
		var version int64
		// Wait for commit, return the persisted row + version. We do NOT ACK
		// before commit, so the grid never shows a value that later reverts.
		err = pool.QueryRow(ctx,
			`INSERT INTO rec(id, tbl_id, data) VALUES($1,$2,$3::jsonb) RETURNING version`,
			id, tblID, string(dataJSON)).Scan(&version)
		if err != nil {
			httpErr(w, 500, err)
			return
		}
		writeJSON(w, 201, Record{ID: id, Data: clean, Version: version})

	default:
		httpErr(w, 405, errors.New("method not allowed"))
	}
}

func handleRow(w http.ResponseWriter, r *http.Request) {
	recID := strings.TrimPrefix(r.URL.Path, "/api/rows/")
	if recID == "" {
		httpErr(w, 404, errors.New("not found"))
		return
	}
	ctx := r.Context()
	switch r.Method {
	case http.MethodDelete:
		if _, err := pool.Exec(ctx, `DELETE FROM rec WHERE id=$1`, recID); err != nil {
			httpErr(w, 500, err)
			return
		}
		writeJSON(w, 200, map[string]any{"deleted": recID})

	case http.MethodPatch:
		// Single-cell edit: {col_id, value}. Empty/absent value clears the cell
		// (key removed, keeping rows sparse). We resolve the row's table to
		// validate the cell against the column type.
		var body struct {
			ColID string `json:"col_id"`
			Value any    `json:"value"`
		}
		if err := decode(r, &body); err != nil || body.ColID == "" {
			httpErr(w, 400, errors.New("col_id required"))
			return
		}
		var tblID string
		if err := pool.QueryRow(ctx, `SELECT tbl_id FROM rec WHERE id=$1`, recID).Scan(&tblID); err != nil {
			httpErr(w, 404, errors.New("row not found"))
			return
		}
		var version int64
		var raw []byte
		if isEmpty(body.Value) {
			// Clear the cell: delete the key. data - $key keeps sparse rows sparse.
			err := pool.QueryRow(ctx,
				`UPDATE rec SET data = data - $2, updated_at = now(), version = version + 1
				 WHERE id = $1 RETURNING data, version`,
				recID, body.ColID).Scan(&raw, &version)
			if err != nil {
				httpErr(w, 500, err)
				return
			}
		} else {
			clean, err := validateCells(ctx, tblID, map[string]any{body.ColID: body.Value})
			if err != nil {
				httpErr(w, 400, err)
				return
			}
			valJSON, _ := json.Marshal(clean[body.ColID])
			// jsonb_set with an explicit text[] path and ::jsonb value. Casting
			// both params explicitly avoids cache_describe type-inference issues.
			// The EXISTS guard ensures a column deleted between validation and
			// this UPDATE can't get an orphan value written.
			err = pool.QueryRow(ctx,
				`UPDATE rec SET data = jsonb_set(data, ARRAY[$2]::text[], $3::jsonb, true),
				 updated_at = now(), version = version + 1
				 WHERE id = $1
				   AND EXISTS (SELECT 1 FROM col WHERE col.id = $2 AND col.tbl_id = rec.tbl_id)
				 RETURNING data, version`,
				recID, body.ColID, string(valJSON)).Scan(&raw, &version)
			if errors.Is(err, pgx.ErrNoRows) {
				httpErr(w, 404, errors.New("row or column not found"))
				return
			}
			if err != nil {
				httpErr(w, 500, err)
				return
			}
		}
		var data map[string]any
		_ = json.Unmarshal(raw, &data)
		writeJSON(w, 200, Record{ID: recID, Data: data, Version: version})

	default:
		httpErr(w, 405, errors.New("method not allowed"))
	}
}

// validateCells canonicalises incoming cell values against their column types so
// JSONB stays sortable/filterable and bad data can never poison a typed query.
// Unknown col ids are dropped.
func validateCells(ctx context.Context, tblID string, in map[string]any) (map[string]any, error) {
	cols := listColumns(ctx, tblID)
	byID := map[string]Column{}
	for _, c := range cols {
		byID[c.ID] = c
	}
	out := map[string]any{}
	for k, v := range in {
		c, ok := byID[k]
		if !ok {
			continue // ignore unknown columns
		}
		if isEmpty(v) {
			continue
		}
		cv, err := coerce(c, v)
		if err != nil {
			return nil, fmt.Errorf("column %q: %w", c.Name, err)
		}
		out[k] = cv
	}
	return out, nil
}

func coerce(c Column, v any) (any, error) {
	switch c.Type {
	case "text", "select":
		s := fmt.Sprintf("%v", v)
		if c.Type == "select" {
			if opts, ok := c.Opts["choices"].([]any); ok && len(opts) > 0 {
				found := false
				for _, o := range opts {
					if fmt.Sprintf("%v", o) == s {
						found = true
						break
					}
				}
				if !found {
					return nil, fmt.Errorf("value %q not in choices", s)
				}
			}
		}
		return s, nil
	case "number":
		switch n := v.(type) {
		case float64:
			return n, nil
		case string:
			f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
			if err != nil {
				return nil, errors.New("not a number")
			}
			return f, nil
		default:
			return nil, errors.New("not a number")
		}
	case "bool":
		switch b := v.(type) {
		case bool:
			return b, nil
		case string:
			return b == "true" || b == "1", nil
		default:
			return nil, errors.New("not a bool")
		}
	case "date":
		s := fmt.Sprintf("%v", v)
		// Store ISO date string; accept YYYY-MM-DD or full RFC3339.
		if _, err := time.Parse("2006-01-02", s); err == nil {
			return s, nil
		}
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			return t.Format("2006-01-02"), nil
		}
		return nil, errors.New("not a date (YYYY-MM-DD)")
	default:
		return fmt.Sprintf("%v", v), nil
	}
}

// ---------- helpers ----------

func isEmpty(v any) bool {
	if v == nil {
		return true
	}
	if s, ok := v.(string); ok {
		return s == ""
	}
	return false
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func decode(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	return dec.Decode(dst)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, code int, err error) {
	if code >= 500 {
		log.Printf("[airtable] error %d: %v", code, err)
	}
	writeJSON(w, code, map[string]any{"error": err.Error()})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
