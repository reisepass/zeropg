// zeropocket — a minimal PocketBase-STYLE backend on zeropg (scale-to-zero Postgres).
//
// WHY THIS EXISTS (path decision): PocketBase itself is hard-coupled to SQLite —
// its filter/query core emits SQLite JSON SQL (json_extract '$.path', json_each,
// iif, json_valid) and its schema sync reads sqlite_master / runs PRAGMA. Porting
// that to Postgres is a semantic compiler rewrite of the product's heart, plus a
// permanent unmaintained fork (upstream rejects multi-dialect). So instead of
// forking, this is a purpose-built single Go binary that reproduces the PocketBase
// PATTERN (collections + records CRUD, REST, email/password auth + JWT, admin UI)
// directly on the zeropg Postgres wire via pgx. A static Go binary boots fast,
// which is the whole point of a scale-to-zero demo.
//
// THE PREPARED-STATEMENT WALL: zeropg is single-session PGlite; NAMED server-side
// prepared statements collide (42P05). pgx avoids this with
// default_query_exec_mode=cache_describe (extended protocol, cached DESCRIBE, no
// persisted named statements — and unlike simple_protocol it encodes JSONB
// correctly). The DSN in service.yaml carries it; pool size is >1.
//
// COLD START: the admin UI is embedded and served from memory with ZERO database
// access, so the page renders instantly on a cold Cloud Run wake. The DB pool is
// opened lazily and the schema is ensured once, in the background; data API calls
// block on readiness, the UI does not.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

//go:embed web/*
var webFS embed.FS

var (
	identRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)
	startAt = time.Now()
)

type server struct {
	pool      *pgxpool.Pool
	jwtSecret []byte

	// lazy/once schema bootstrap so the first wake isn't blocked by it on the UI path
	ready     chan struct{}
	readyErr  error
	readyOnce sync.Once
}

func main() {
	logger := log.New(os.Stdout, "[zeropocket] ", log.LstdFlags|log.Lmsgprefix)

	port := getenv("PORT", "8080")
	dsn := getenv("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable&default_query_exec_mode=cache_describe&pool_max_conns=4")
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		// No fatal: keeps the documented local `go run` demo working. The Cloud
		// Run deploy injects a strong secret from Secret Manager, so this default
		// only ever applies locally. Loud warning so it can't slip into a public
		// deploy unnoticed.
		secret = "dev-insecure-secret-change-me"
		logger.Printf("WARNING: JWT_SECRET unset — using an insecure dev default. Set JWT_SECRET for any real deployment.")
	}

	s := &server{jwtSecret: []byte(secret), ready: make(chan struct{})}

	// Open the pool lazily in the background. ParseConfig validates the DSN now;
	// actual connections are established on first use. The admin UI does not wait.
	go s.bootstrap(logger, dsn)

	mux := http.NewServeMux()

	// Liveness only, no DB. NOTE: do NOT use "/healthz" here — Cloud Run's edge
	// reserves/intercepts that path and returns its own 404 before the request
	// reaches the container. "/livez" is passed through normally.
	mux.HandleFunc("/livez", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "uptime_s": time.Since(startAt).Seconds()})
	})

	// Readiness: reports whether the DB schema is ensured (used by the UI banner).
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-s.ready:
			if s.readyErr != nil {
				writeJSON(w, 503, map[string]any{"db": "error", "error": s.readyErr.Error()})
				return
			}
			writeJSON(w, 200, map[string]any{"db": "ready", "uptime_s": time.Since(startAt).Seconds()})
		default:
			writeJSON(w, 200, map[string]any{"db": "warming", "uptime_s": time.Since(startAt).Seconds()})
		}
	})

	// WAKE endpoint: fire-and-forget from the frontend on page load. It just
	// triggers DB readiness in the background (the request that hits this already
	// woke the Cloud Run instance + its db sidecar) and returns immediately.
	mux.HandleFunc("/api/wake", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 202, map[string]any{"waking": true})
	})

	// --- Auth ---
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("GET /api/auth/me", s.requireAuth(s.handleMe))

	// --- Collections (schema) ---
	mux.HandleFunc("GET /api/collections", s.requireAuth(s.handleListCollections))
	mux.HandleFunc("POST /api/collections", s.requireAuth(s.handleCreateCollection))
	mux.HandleFunc("DELETE /api/collections/{name}", s.requireAuth(s.handleDeleteCollection))

	// --- Records (data) — PocketBase-style routes ---
	mux.HandleFunc("GET /api/collections/{name}/records", s.requireAuth(s.handleListRecords))
	mux.HandleFunc("POST /api/collections/{name}/records", s.requireAuth(s.handleCreateRecord))
	mux.HandleFunc("GET /api/collections/{name}/records/{id}", s.requireAuth(s.handleGetRecord))
	mux.HandleFunc("PATCH /api/collections/{name}/records/{id}", s.requireAuth(s.handleUpdateRecord))
	mux.HandleFunc("DELETE /api/collections/{name}/records/{id}", s.requireAuth(s.handleDeleteRecord))

	// --- Admin UI (embedded, served with no DB access for instant cold render) ---
	mux.HandleFunc("/", s.handleUI)

	logger.Printf("listening on :%s (boot %.0fms after process start)", port, time.Since(startAt).Seconds()*1000)
	srv := &http.Server{Addr: ":" + port, Handler: logRequests(logger, mux)}
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Fatalf("server error: %v", err)
	}
}

// bootstrap opens the pool and ensures the system schema, exactly once.
func (s *server) bootstrap(logger *log.Logger, dsn string) {
	s.readyOnce.Do(func() {
		defer close(s.ready)
		cfg, err := pgxpool.ParseConfig(dsn)
		if err != nil {
			s.readyErr = fmt.Errorf("parse dsn: %w", err)
			logger.Printf("FATAL dsn: %v", err)
			return
		}
		// Belt-and-suspenders: force cache_describe even if the DSN omitted it.
		cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe

		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()

		// Retry: the db sidecar wire can lag the app's start (restore-from-GCS).
		var pool *pgxpool.Pool
		for i := 0; i < 120; i++ {
			pool, err = pgxpool.NewWithConfig(ctx, cfg)
			if err == nil {
				if err = pool.Ping(ctx); err == nil {
					break
				}
				pool.Close()
			}
			if ctx.Err() != nil {
				break
			}
			time.Sleep(time.Second)
		}
		if err != nil {
			s.readyErr = fmt.Errorf("connect db: %w", err)
			logger.Printf("FATAL db connect after retries: %v", err)
			return
		}
		s.pool = pool
		if err := s.ensureSchema(ctx); err != nil {
			s.readyErr = fmt.Errorf("ensure schema: %w", err)
			logger.Printf("FATAL schema: %v", err)
			return
		}
		logger.Printf("db ready, schema ensured (%.0fms after process start)", time.Since(startAt).Seconds()*1000)
	})
}

// ensureSchema creates the system tables idempotently. Each collection gets its
// own physical Postgres table (one column per declared field) so the demo shows
// REAL Postgres DDL on the zeropg wire, not an opaque jsonb blob. Field values
// also live in a jsonb mirror for flexible filtering.
func (s *server) ensureSchema(ctx context.Context) error {
	const ddl = `
CREATE TABLE IF NOT EXISTS _users (
  id          text PRIMARY KEY,
  email       text UNIQUE NOT NULL,
  password    text NOT NULL,
  created     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS _collections (
  name        text PRIMARY KEY,
  fields      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created     timestamptz NOT NULL DEFAULT now()
);`
	_, err := s.pool.Exec(ctx, ddl)
	return err
}

// awaitDB blocks an API handler until the DB is ready (or errors). The UI path
// never calls this.
func (s *server) awaitDB(w http.ResponseWriter) bool {
	<-s.ready
	if s.readyErr != nil {
		writeJSON(w, 503, map[string]any{"error": "database not ready: " + s.readyErr.Error()})
		return false
	}
	return true
}

// ---------- Auth ----------

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (s *server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.awaitDB(w) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10) // 8 KiB: credentials are tiny
	var c credentials
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid json"})
		return
	}
	c.Email = strings.TrimSpace(strings.ToLower(c.Email))
	if !strings.Contains(c.Email, "@") || len(c.Password) < 6 {
		writeJSON(w, 400, map[string]any{"error": "email required and password must be >= 6 chars"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(c.Password), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": "hash failed"})
		return
	}
	id := newID()
	_, err = s.pool.Exec(r.Context(),
		`INSERT INTO _users(id, email, password) VALUES($1, $2, $3)`, id, c.Email, string(hash))
	if err != nil {
		if isUnique(err) {
			writeJSON(w, 409, map[string]any{"error": "email already registered"})
			return
		}
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	tok, _ := s.mintToken(id, c.Email)
	writeJSON(w, 201, map[string]any{"token": tok, "user": map[string]any{"id": id, "email": c.Email}})
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.awaitDB(w) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var c credentials
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid json"})
		return
	}
	c.Email = strings.TrimSpace(strings.ToLower(c.Email))
	var id, hash string
	err := s.pool.QueryRow(r.Context(),
		`SELECT id, password FROM _users WHERE email=$1`, c.Email).Scan(&id, &hash)
	if err != nil {
		writeJSON(w, 401, map[string]any{"error": "invalid credentials"})
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(c.Password)) != nil {
		writeJSON(w, 401, map[string]any{"error": "invalid credentials"})
		return
	}
	tok, _ := s.mintToken(id, c.Email)
	writeJSON(w, 200, map[string]any{"token": tok, "user": map[string]any{"id": id, "email": c.Email}})
}

func (s *server) handleMe(w http.ResponseWriter, r *http.Request, claims *userClaims) {
	writeJSON(w, 200, map[string]any{"id": claims.Subject, "email": claims.Email})
}

type userClaims struct {
	Email string `json:"email"`
	jwt.RegisteredClaims
}

func (s *server) mintToken(id, email string) (string, error) {
	claims := userClaims{
		Email: email,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   id,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(7 * 24 * time.Hour)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
}

func (s *server) requireAuth(next func(http.ResponseWriter, *http.Request, *userClaims)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.awaitDB(w) {
			return
		}
		auth := r.Header.Get("Authorization")
		tokStr := strings.TrimPrefix(auth, "Bearer ")
		if tokStr == auth || tokStr == "" {
			writeJSON(w, 401, map[string]any{"error": "missing bearer token"})
			return
		}
		claims := &userClaims{}
		tok, err := jwt.ParseWithClaims(tokStr, claims, func(t *jwt.Token) (any, error) {
			// Pin the exact algorithm we mint (HS256). Rejects alg=none and any
			// other-method confusion, and is stricter than just "any HMAC".
			if t.Method != jwt.SigningMethodHS256 {
				return nil, errors.New("unexpected signing method")
			}
			return s.jwtSecret, nil
		})
		if err != nil || !tok.Valid {
			writeJSON(w, 401, map[string]any{"error": "invalid token"})
			return
		}
		next(w, r, claims)
	}
}

// ---------- Collections ----------

type fieldDef struct {
	Name string `json:"name"`
	Type string `json:"type"` // text | number | bool
}

func (f fieldDef) pgType() (string, bool) {
	switch f.Type {
	case "text":
		return "text", true
	case "number":
		return "double precision", true
	case "bool":
		return "boolean", true
	default:
		return "", false
	}
}

type collectionDef struct {
	Name   string     `json:"name"`
	Fields []fieldDef `json:"fields"`
}

func (s *server) handleListCollections(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	rows, err := s.pool.Query(r.Context(), `SELECT name, fields, created FROM _collections ORDER BY created`)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var name string
		var fields []fieldDef
		var created time.Time
		if err := rows.Scan(&name, &fields, &created); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		out = append(out, map[string]any{"name": name, "fields": fields, "created": created})
	}
	writeJSON(w, 200, map[string]any{"collections": out})
}

func (s *server) handleCreateCollection(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	var c collectionDef
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid json"})
		return
	}
	c.Name = strings.TrimSpace(strings.ToLower(c.Name))
	// 59 = 63 (Postgres identifier byte limit) - len("rec_"), so the physical
	// table name "rec_"+name can never exceed the limit and get truncated.
	if !identRe.MatchString(c.Name) || strings.HasPrefix(c.Name, "_") || len(c.Name) > 59 {
		writeJSON(w, 400, map[string]any{"error": "collection name must match [a-z][a-z0-9_]*, not start with _, and be <= 59 chars"})
		return
	}
	// Validate fields, normalize names IN PLACE (so the persisted metadata matches
	// the actual column names), reject duplicates, and build the physical DDL.
	cols := []string{}
	seen := map[string]struct{}{}
	for i := range c.Fields {
		c.Fields[i].Name = strings.TrimSpace(strings.ToLower(c.Fields[i].Name))
		f := c.Fields[i]
		if !identRe.MatchString(f.Name) || strings.HasPrefix(f.Name, "_") || f.Name == "id" || f.Name == "created" || f.Name == "updated" {
			writeJSON(w, 400, map[string]any{"error": "invalid field name: " + f.Name + " (reserved or malformed)"})
			return
		}
		if _, dup := seen[f.Name]; dup {
			writeJSON(w, 400, map[string]any{"error": "duplicate field name: " + f.Name})
			return
		}
		seen[f.Name] = struct{}{}
		pgt, ok := f.pgType()
		if !ok {
			writeJSON(w, 400, map[string]any{"error": "invalid field type for " + f.Name + " (use text|number|bool)"})
			return
		}
		cols = append(cols, fmt.Sprintf("%s %s", quoteIdent(f.Name), pgt))
	}

	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	defer tx.Rollback(r.Context())

	fieldsJSON, _ := json.Marshal(c.Fields)
	_, err = tx.Exec(r.Context(),
		`INSERT INTO _collections(name, fields) VALUES($1, $2)`, c.Name, string(fieldsJSON))
	if err != nil {
		if isUnique(err) {
			writeJSON(w, 409, map[string]any{"error": "collection already exists"})
			return
		}
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}

	ddl := fmt.Sprintf(`CREATE TABLE %s (
  id text PRIMARY KEY,
  %s
  created timestamptz NOT NULL DEFAULT now(),
  updated timestamptz NOT NULL DEFAULT now()
)`, quoteIdent("rec_"+c.Name), joinCols(cols))
	if _, err := tx.Exec(r.Context(), ddl); err != nil {
		writeJSON(w, 500, map[string]any{"error": "create table: " + err.Error()})
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 201, map[string]any{"name": c.Name, "fields": c.Fields})
}

func (s *server) handleDeleteCollection(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	name := strings.ToLower(r.PathValue("name"))
	if !identRe.MatchString(name) {
		writeJSON(w, 400, map[string]any{"error": "invalid name"})
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	defer tx.Rollback(r.Context())
	ct, err := tx.Exec(r.Context(), `DELETE FROM _collections WHERE name=$1`, name)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if ct.RowsAffected() == 0 {
		writeJSON(w, 404, map[string]any{"error": "no such collection"})
		return
	}
	if _, err := tx.Exec(r.Context(), fmt.Sprintf(`DROP TABLE IF EXISTS %s`, quoteIdent("rec_"+name))); err != nil {
		writeJSON(w, 500, map[string]any{"error": "drop table: " + err.Error()})
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"deleted": name})
}

// loadFields returns the declared fields for a collection (and whether it exists).
func (s *server) loadFields(ctx context.Context, name string) ([]fieldDef, bool, error) {
	var fields []fieldDef
	err := s.pool.QueryRow(ctx, `SELECT fields FROM _collections WHERE name=$1`, name).Scan(&fields)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return fields, true, nil
}

// ---------- Records ----------

func (s *server) handleListRecords(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	name := strings.ToLower(r.PathValue("name"))
	fields, ok, err := s.loadFields(r.Context(), name)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "no such collection"})
		return
	}
	perPage := clampInt(queryInt(r, "perPage", 50), 1, 200)
	page := clampInt(queryInt(r, "page", 1), 1, 1_000_000)
	offset := (page - 1) * perPage

	colList := selectCols(fields)
	q := fmt.Sprintf(`SELECT %s FROM %s ORDER BY created DESC LIMIT $1 OFFSET $2`,
		colList, quoteIdent("rec_"+name))
	rows, err := s.pool.Query(r.Context(), q, perPage, offset)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	defer rows.Close()
	items, err := scanRecords(rows)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	var total int
	_ = s.pool.QueryRow(r.Context(), fmt.Sprintf(`SELECT count(*) FROM %s`, quoteIdent("rec_"+name))).Scan(&total)
	writeJSON(w, 200, map[string]any{"page": page, "perPage": perPage, "totalItems": total, "items": items})
}

func (s *server) handleCreateRecord(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	name := strings.ToLower(r.PathValue("name"))
	fields, ok, err := s.loadFields(r.Context(), name)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "no such collection"})
		return
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid json"})
		return
	}
	id := newID()
	cols := []string{quoteIdent("id")}
	ph := []string{"$1"}
	args := []any{id}
	n := 2
	for _, f := range fields {
		if v, present := body[f.Name]; present {
			cv, err := coerce(f, v)
			if err != nil {
				writeJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			cols = append(cols, quoteIdent(f.Name))
			ph = append(ph, "$"+strconv.Itoa(n))
			args = append(args, cv)
			n++
		}
	}
	q := fmt.Sprintf(`INSERT INTO %s (%s) VALUES (%s) RETURNING %s`,
		quoteIdent("rec_"+name), strings.Join(cols, ", "), strings.Join(ph, ", "), selectCols(fields))
	row, err := s.pool.Query(r.Context(), q, args...)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	items, err := scanRecords(row)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if len(items) == 0 {
		writeJSON(w, 500, map[string]any{"error": "insert returned no row"})
		return
	}
	writeJSON(w, 201, items[0])
}

func (s *server) handleGetRecord(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	name := strings.ToLower(r.PathValue("name"))
	id := r.PathValue("id")
	fields, ok, err := s.loadFields(r.Context(), name)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "no such collection"})
		return
	}
	q := fmt.Sprintf(`SELECT %s FROM %s WHERE id=$1`, selectCols(fields), quoteIdent("rec_"+name))
	rows, err := s.pool.Query(r.Context(), q, id)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	items, err := scanRecords(rows)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if len(items) == 0 {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	writeJSON(w, 200, items[0])
}

func (s *server) handleUpdateRecord(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	name := strings.ToLower(r.PathValue("name"))
	id := r.PathValue("id")
	fields, ok, err := s.loadFields(r.Context(), name)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "no such collection"})
		return
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid json"})
		return
	}
	set := []string{}
	args := []any{}
	n := 1
	for _, f := range fields {
		if v, present := body[f.Name]; present {
			cv, err := coerce(f, v)
			if err != nil {
				writeJSON(w, 400, map[string]any{"error": err.Error()})
				return
			}
			set = append(set, fmt.Sprintf("%s=$%d", quoteIdent(f.Name), n))
			args = append(args, cv)
			n++
		}
	}
	if len(set) == 0 {
		writeJSON(w, 400, map[string]any{"error": "no updatable fields in body"})
		return
	}
	set = append(set, fmt.Sprintf("updated=$%d", n))
	args = append(args, time.Now())
	n++
	args = append(args, id)
	q := fmt.Sprintf(`UPDATE %s SET %s WHERE id=$%d RETURNING %s`,
		quoteIdent("rec_"+name), strings.Join(set, ", "), n, selectCols(fields))
	rows, err := s.pool.Query(r.Context(), q, args...)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	items, err := scanRecords(rows)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if len(items) == 0 {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	writeJSON(w, 200, items[0])
}

func (s *server) handleDeleteRecord(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	name := strings.ToLower(r.PathValue("name"))
	id := r.PathValue("id")
	if _, ok, err := s.loadFields(r.Context(), name); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	} else if !ok {
		writeJSON(w, 404, map[string]any{"error": "no such collection"})
		return
	}
	ct, err := s.pool.Exec(r.Context(), fmt.Sprintf(`DELETE FROM %s WHERE id=$1`, quoteIdent("rec_"+name)), id)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if ct.RowsAffected() == 0 {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	writeJSON(w, 200, map[string]any{"deleted": id})
}

// ---------- UI ----------

func (s *server) handleUI(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" && r.URL.Path != "/index.html" {
		http.NotFound(w, r)
		return
	}
	b, err := webFS.ReadFile("web/index.html")
	if err != nil {
		http.Error(w, "ui missing", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(b)
}

// ---------- helpers ----------

func selectCols(fields []fieldDef) string {
	cols := []string{quoteIdent("id")}
	for _, f := range fields {
		cols = append(cols, quoteIdent(f.Name))
	}
	cols = append(cols, quoteIdent("created"), quoteIdent("updated"))
	return strings.Join(cols, ", ")
}

// scanRecords scans rows into []map using the row's field descriptions, so it
// works for any collection shape.
func scanRecords(rows pgx.Rows) ([]map[string]any, error) {
	defer rows.Close()
	out := []map[string]any{}
	fds := rows.FieldDescriptions()
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		m := map[string]any{}
		for i, fd := range fds {
			m[string(fd.Name)] = vals[i]
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func coerce(f fieldDef, v any) (any, error) {
	if v == nil {
		return nil, nil
	}
	switch f.Type {
	case "text":
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("field %s must be text", f.Name)
		}
		return s, nil
	case "number":
		switch n := v.(type) {
		case float64:
			return n, nil
		case json.Number:
			return n.Float64()
		default:
			return nil, fmt.Errorf("field %s must be a number", f.Name)
		}
	case "bool":
		b, ok := v.(bool)
		if !ok {
			return nil, fmt.Errorf("field %s must be a boolean", f.Name)
		}
		return b, nil
	}
	return nil, fmt.Errorf("unknown field type for %s", f.Name)
}

func joinCols(cols []string) string {
	if len(cols) == 0 {
		return ""
	}
	return strings.Join(cols, ",\n  ") + ","
}

// quoteIdent safely double-quotes a Postgres identifier. All identifiers reaching
// here are already validated against identRe (or a fixed prefix), so there is no
// untrusted input; the quoting is defense in depth.
func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func isUnique(err error) bool {
	return err != nil && strings.Contains(err.Error(), "SQLSTATE 23505")
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func queryInt(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

var idCounter struct {
	sync.Mutex
	last int64
}

// newID returns a sortable-ish 15-char base32 id (time + counter). Good enough
// for a demo; not a security token.
func newID() string {
	idCounter.Lock()
	idCounter.last++
	c := idCounter.last
	idCounter.Unlock()
	const alpha = "0123456789abcdefghijklmnopqrstuv"
	n := time.Now().UnixNano()*1000 + c%1000
	b := make([]byte, 15)
	for i := len(b) - 1; i >= 0; i-- {
		b[i] = alpha[n&31]
		n >>= 5
	}
	return string(b)
}

func logRequests(logger *log.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		// keep noise low: skip health pings
		if r.URL.Path != "/livez" {
			logger.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}
