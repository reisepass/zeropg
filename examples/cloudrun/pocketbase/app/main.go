// zeropocket — a PocketBase-STYLE backend on zeropg (scale-to-zero Postgres).
//
// NOTE: this is NOT PocketBase. PocketBase is hard-coupled to SQLite (its
// filter/query core emits SQLite JSON SQL — json_extract '$.path', json_each,
// iif — and its schema sync reads sqlite_master / runs PRAGMA). Porting that to
// Postgres is a semantic compiler rewrite plus a permanent unmaintained fork
// (upstream rejects multi-dialect). zeropocket instead reproduces the PocketBase
// PATTERN — collections + records on REAL Postgres tables, typed fields, a
// safe filter/sort/search query API, email/password auth + JWT, per-collection
// API access rules, a user-management view, settings, and a PocketBase-styled
// admin SPA — directly on the zeropg wire via pgx. A static Go binary boots fast.
//
// THE PREPARED-STATEMENT WALL: zeropg is single-session PGlite; NAMED server-side
// prepared statements collide (42P05). pgx avoids this with
// default_query_exec_mode=cache_describe (extended protocol, cached DESCRIBE, no
// persisted named statements — and unlike simple_protocol it encodes JSONB
// correctly). The DSN in service.yaml carries it; pool size is >1.
//
// COLD START: the admin SPA is embedded and served from memory with ZERO database
// access, so the page paints instantly on a cold Cloud Run wake. The DB pool is
// opened lazily in the background; data API calls block on readiness, the UI does
// not. The page fires a fire-and-forget /api/wake on load to warm the db sidecar.
//
// DATA RETENTION (on by default — this runs on the public internet with open
// registration): retention is enforced LAZILY/INLINE (prune-on-insert + a cheap
// throttled sweep), never by a background worker, so the instance still scales to
// zero. Per-collection newest-N cap, age TTL, a global record cap, a per-account
// row cap, and a registered-user cap — all env-configurable with safe defaults.
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
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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

// ---------- retention config ----------

type retention struct {
	PerCollectionMax int           // keep at most N newest records per collection (0 = off)
	MaxAge           time.Duration // delete records older than this (0 = off)
	GlobalMax        int           // hard cap on total records across all collections (0 = off)
	PerAccountMax    int           // max records a single account may own across collections (0 = off)
	MaxUsers         int           // cap on registered users (0 = off)
	MaxCollections   int           // cap on number of collections (0 = off)
}

func loadRetention() retention {
	return retention{
		PerCollectionMax: envInt("RETENTION_PER_COLLECTION_MAX", 500),
		MaxAge:           time.Duration(envInt("RETENTION_MAX_AGE_DAYS", 30)) * 24 * time.Hour,
		GlobalMax:        envInt("RETENTION_GLOBAL_MAX", 20000),
		PerAccountMax:    envInt("RETENTION_PER_ACCOUNT_MAX", 1000),
		MaxUsers:         envInt("RETENTION_MAX_USERS", 5000),
		MaxCollections:   envInt("RETENTION_MAX_COLLECTIONS", 100),
	}
}

type server struct {
	pool      *pgxpool.Pool
	jwtSecret []byte
	ret       retention

	ready     chan struct{}
	readyErr  error
	readyOnce sync.Once

	// throttle for the cheap global sweep (age + global cap), so we don't run it
	// on every single request. Lazy: only ever runs on a request, never on a timer.
	lastSweep atomic.Int64 // unix seconds
}

func main() {
	logger := log.New(os.Stdout, "[zeropocket] ", log.LstdFlags|log.Lmsgprefix)

	port := getenv("PORT", "8080")
	dsn := getenv("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable&default_query_exec_mode=cache_describe&pool_max_conns=4")
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "dev-insecure-secret-change-me"
		logger.Printf("WARNING: JWT_SECRET unset — using an insecure dev default. Set JWT_SECRET for any real deployment.")
	}

	s := &server{jwtSecret: []byte(secret), ready: make(chan struct{}), ret: loadRetention()}
	logger.Printf("retention: perCollection=%d maxAgeDays=%.0f globalMax=%d perAccount=%d maxUsers=%d maxCollections=%d",
		s.ret.PerCollectionMax, s.ret.MaxAge.Hours()/24, s.ret.GlobalMax, s.ret.PerAccountMax, s.ret.MaxUsers, s.ret.MaxCollections)

	go s.bootstrap(logger, dsn)

	mux := http.NewServeMux()

	// Liveness, no DB. NOTE: do NOT use "/healthz" — Cloud Run's edge reserves
	// that path and 404s before the request reaches the container. "/livez" works.
	mux.HandleFunc("/livez", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "uptime_s": time.Since(startAt).Seconds()})
	})
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
	mux.HandleFunc("/api/wake", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 202, map[string]any{"waking": true})
	})
	// retention policy (read-only) so the UI can show the active limits.
	mux.HandleFunc("GET /api/settings", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"app":       "zeropocket",
			"backend":   "zeropg (PGlite over the Postgres wire, GCS-backed, scale-to-zero)",
			"retention": s.ret.public(),
		})
	})

	// --- Auth ---
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("GET /api/auth/me", s.requireAuth(s.handleMe))

	// --- Users (auth collection / user management) ---
	mux.HandleFunc("GET /api/users", s.requireAuth(s.handleListUsers))
	mux.HandleFunc("DELETE /api/users/{id}", s.requireAuth(s.handleDeleteUser))

	// --- Collections (schema) ---
	mux.HandleFunc("GET /api/collections", s.requireAuth(s.handleListCollections))
	mux.HandleFunc("POST /api/collections", s.requireAuth(s.handleCreateCollection))
	mux.HandleFunc("PATCH /api/collections/{name}", s.requireAuth(s.handleUpdateCollectionRules))
	mux.HandleFunc("DELETE /api/collections/{name}", s.requireAuth(s.handleDeleteCollection))

	// --- Records (data). Read routes honor the collection's API rule (public or
	// authenticated); write routes always require auth. ---
	mux.HandleFunc("GET /api/collections/{name}/records", s.maybeAuth(s.handleListRecords))
	mux.HandleFunc("POST /api/collections/{name}/records", s.requireAuth(s.handleCreateRecord))
	mux.HandleFunc("GET /api/collections/{name}/records/{id}", s.maybeAuth(s.handleGetRecord))
	mux.HandleFunc("PATCH /api/collections/{name}/records/{id}", s.requireAuth(s.handleUpdateRecord))
	mux.HandleFunc("DELETE /api/collections/{name}/records/{id}", s.requireAuth(s.handleDeleteRecord))

	// --- Admin SPA (embedded, no DB on first paint) ---
	mux.HandleFunc("/", s.handleUI)

	logger.Printf("listening on :%s (boot %.0fms after process start)", port, time.Since(startAt).Seconds()*1000)
	srv := &http.Server{Addr: ":" + port, Handler: logRequests(logger, mux)}
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Fatalf("server error: %v", err)
	}
}

func (r retention) public() map[string]any {
	return map[string]any{
		"per_collection_max": r.PerCollectionMax,
		"max_age_days":       int(r.MaxAge.Hours() / 24),
		"global_max":         r.GlobalMax,
		"per_account_max":    r.PerAccountMax,
		"max_users":          r.MaxUsers,
		"max_collections":    r.MaxCollections,
	}
}

// ---------- bootstrap / schema ----------

func (s *server) bootstrap(logger *log.Logger, dsn string) {
	s.readyOnce.Do(func() {
		defer close(s.ready)
		cfg, err := pgxpool.ParseConfig(dsn)
		if err != nil {
			s.readyErr = fmt.Errorf("parse dsn: %w", err)
			logger.Printf("FATAL dsn: %v", err)
			return
		}
		cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe

		connectCtx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()

		var pool *pgxpool.Pool
		for i := 0; i < 120; i++ {
			pool, err = pgxpool.NewWithConfig(connectCtx, cfg)
			if err == nil {
				if err = pool.Ping(connectCtx); err == nil {
					break
				}
				pool.Close()
			}
			if connectCtx.Err() != nil {
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

		// Fresh context for schema work so a slow GCS restore can't starve it.
		schemaCtx, cancel2 := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel2()
		if err := s.ensureSchema(schemaCtx); err != nil {
			s.readyErr = fmt.Errorf("ensure schema: %w", err)
			logger.Printf("FATAL schema: %v", err)
			return
		}
		logger.Printf("db ready, schema ensured (%.0fms after process start)", time.Since(startAt).Seconds()*1000)
	})
}

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
  list_rule   text NOT NULL DEFAULT 'auth',  -- 'public' | 'auth'
  created     timestamptz NOT NULL DEFAULT now()
);`
	if _, err := s.pool.Exec(ctx, ddl); err != nil {
		return err
	}
	// Backfill list_rule on older datadirs that predate the column.
	_, _ = s.pool.Exec(ctx, `ALTER TABLE _collections ADD COLUMN IF NOT EXISTS list_rule text NOT NULL DEFAULT 'auth'`)
	return nil
}

func (s *server) awaitDB(w http.ResponseWriter) bool {
	<-s.ready
	if s.readyErr != nil {
		writeJSON(w, 503, map[string]any{"error": "database not ready: " + s.readyErr.Error()})
		return false
	}
	return true
}

// ---------- auth ----------

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (s *server) handleRegister(w http.ResponseWriter, r *http.Request) {
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
	if !strings.Contains(c.Email, "@") || len(c.Password) < 6 {
		writeJSON(w, 400, map[string]any{"error": "email required and password must be >= 6 chars"})
		return
	}
	// Registration cap (abuse guard): refuse new signups past MaxUsers.
	if s.ret.MaxUsers > 0 {
		var n int
		if err := s.pool.QueryRow(r.Context(), `SELECT count(*) FROM _users`).Scan(&n); err == nil && n >= s.ret.MaxUsers {
			writeJSON(w, 403, map[string]any{"error": "registration is closed (user cap reached)"})
			return
		}
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

// parseClaims returns the validated claims, or nil if the request has no/invalid token.
func (s *server) parseClaims(r *http.Request) *userClaims {
	auth := r.Header.Get("Authorization")
	tokStr := strings.TrimPrefix(auth, "Bearer ")
	if tokStr == auth || tokStr == "" {
		return nil
	}
	claims := &userClaims{}
	tok, err := jwt.ParseWithClaims(tokStr, claims, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("unexpected signing method")
		}
		return s.jwtSecret, nil
	})
	if err != nil || !tok.Valid {
		return nil
	}
	return claims
}

func (s *server) requireAuth(next func(http.ResponseWriter, *http.Request, *userClaims)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.awaitDB(w) {
			return
		}
		claims := s.parseClaims(r)
		if claims == nil {
			writeJSON(w, 401, map[string]any{"error": "authentication required"})
			return
		}
		next(w, r, claims)
	}
}

// maybeAuth runs the handler with claims that may be nil (for routes whose access
// is governed per-collection by the list_rule).
func (s *server) maybeAuth(next func(http.ResponseWriter, *http.Request, *userClaims)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.awaitDB(w) {
			return
		}
		next(w, r, s.parseClaims(r))
	}
}

// ---------- users ----------

func (s *server) handleListUsers(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	rows, err := s.pool.Query(r.Context(),
		`SELECT id, email, created FROM _users ORDER BY created DESC LIMIT 500`)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, email string
		var created time.Time
		if err := rows.Scan(&id, &email, &created); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		out = append(out, map[string]any{"id": id, "email": email, "created": created})
	}
	var total int
	_ = s.pool.QueryRow(r.Context(), `SELECT count(*) FROM _users`).Scan(&total)
	writeJSON(w, 200, map[string]any{"users": out, "totalItems": total, "maxUsers": s.ret.MaxUsers})
}

func (s *server) handleDeleteUser(w http.ResponseWriter, r *http.Request, claims *userClaims) {
	id := r.PathValue("id")
	if id == claims.Subject {
		writeJSON(w, 400, map[string]any{"error": "you cannot delete your own account while signed in"})
		return
	}
	ct, err := s.pool.Exec(r.Context(), `DELETE FROM _users WHERE id=$1`, id)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if ct.RowsAffected() == 0 {
		writeJSON(w, 404, map[string]any{"error": "no such user"})
		return
	}
	writeJSON(w, 200, map[string]any{"deleted": id})
}

// ---------- collections ----------

// schemaLockKey serializes collection schema mutations (create/delete) so a
// relation target can't be validated by a create while a concurrent delete of
// that target is mid-flight, which would leave a dangling relation. Transaction-
// scoped advisory lock: auto-released on commit/rollback.
const schemaLockKey int64 = 0x7a65726f70676d01

func lockSchema(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, schemaLockKey)
	return err
}

// supported field types -> Postgres column type.
func pgTypeFor(t string) (string, bool) {
	switch t {
	case "text", "email", "url", "select", "relation":
		return "text", true
	case "number":
		return "double precision", true
	case "bool":
		return "boolean", true
	case "date":
		return "timestamptz", true
	case "json":
		return "jsonb", true
	default:
		return "", false
	}
}

type fieldDef struct {
	Name     string   `json:"name"`
	Type     string   `json:"type"`
	Required bool     `json:"required,omitempty"`
	Options  []string `json:"options,omitempty"` // for select
	Relation string   `json:"relation,omitempty"` // for relation: target collection name
}

type collectionDef struct {
	Name     string     `json:"name"`
	Fields   []fieldDef `json:"fields"`
	ListRule string     `json:"list_rule,omitempty"` // 'public' | 'auth'
}

var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
var urlRe = regexp.MustCompile(`^https?://`)

func (s *server) handleListCollections(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	rows, err := s.pool.Query(r.Context(), `SELECT name, fields, list_rule, created FROM _collections ORDER BY created`)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var name, listRule string
		var fields []fieldDef
		var created time.Time
		if err := rows.Scan(&name, &fields, &listRule, &created); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		var count int
		_ = s.pool.QueryRow(r.Context(), fmt.Sprintf(`SELECT count(*) FROM %s`, quoteIdent("rec_"+name))).Scan(&count)
		out = append(out, map[string]any{"name": name, "fields": fields, "list_rule": listRule, "created": created, "records": count})
	}
	writeJSON(w, 200, map[string]any{"collections": out})
}

func (s *server) handleCreateCollection(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var c collectionDef
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid json"})
		return
	}
	c.Name = strings.TrimSpace(strings.ToLower(c.Name))
	// 59 = 63 (Postgres identifier byte limit) - len("rec_").
	if !identRe.MatchString(c.Name) || strings.HasPrefix(c.Name, "_") || len(c.Name) > 59 {
		writeJSON(w, 400, map[string]any{"error": "collection name must match [a-z][a-z0-9_]*, not start with _, and be <= 59 chars"})
		return
	}
	if s.ret.MaxCollections > 0 {
		var n int
		if err := s.pool.QueryRow(r.Context(), `SELECT count(*) FROM _collections`).Scan(&n); err == nil && n >= s.ret.MaxCollections {
			writeJSON(w, 403, map[string]any{"error": "collection cap reached"})
			return
		}
	}
	if c.ListRule != "public" {
		c.ListRule = "auth"
	}

	// Validate fields, normalize names IN PLACE so persisted metadata matches the
	// actual column names, reject duplicates, build the physical DDL.
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
		pgt, ok := pgTypeFor(f.Type)
		if !ok {
			writeJSON(w, 400, map[string]any{"error": "invalid field type for " + f.Name + " (text|number|bool|email|url|date|select|relation|json)"})
			return
		}
		if f.Type == "relation" {
			c.Fields[i].Relation = strings.TrimSpace(strings.ToLower(f.Relation))
			if !identRe.MatchString(c.Fields[i].Relation) {
				writeJSON(w, 400, map[string]any{"error": "relation field " + f.Name + " needs a valid target collection name"})
				return
			}
		}
		if f.Type == "select" && len(f.Options) == 0 {
			writeJSON(w, 400, map[string]any{"error": "select field " + f.Name + " needs at least one option"})
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
	if err := lockSchema(r.Context(), tx); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}

	// Validate relation targets exist.
	for _, f := range c.Fields {
		if f.Type == "relation" {
			var ok bool
			if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM _collections WHERE name=$1)`, f.Relation).Scan(&ok); err != nil || !ok {
				writeJSON(w, 400, map[string]any{"error": "relation target collection does not exist: " + f.Relation})
				return
			}
		}
	}

	fieldsJSON, _ := json.Marshal(c.Fields)
	_, err = tx.Exec(r.Context(),
		`INSERT INTO _collections(name, fields, list_rule) VALUES($1, $2, $3)`, c.Name, string(fieldsJSON), c.ListRule)
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
  owner text,
  %s
  created timestamptz NOT NULL DEFAULT now(),
  updated timestamptz NOT NULL DEFAULT now()
)`, quoteIdent("rec_"+c.Name), joinCols(cols))
	if _, err := tx.Exec(r.Context(), ddl); err != nil {
		writeJSON(w, 500, map[string]any{"error": "create table: " + err.Error()})
		return
	}
	// Index created DESC so newest-N retention pruning and default sort are cheap.
	// Let Postgres auto-name the index: "idx_"+name+"_created" could exceed the
	// 63-byte identifier limit for long names and collide after truncation.
	_, _ = tx.Exec(r.Context(), fmt.Sprintf(`CREATE INDEX ON %s (created DESC)`,
		quoteIdent("rec_"+c.Name)))

	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 201, map[string]any{"name": c.Name, "fields": c.Fields, "list_rule": c.ListRule})
}

func (s *server) handleUpdateCollectionRules(w http.ResponseWriter, r *http.Request, _ *userClaims) {
	name := strings.ToLower(r.PathValue("name"))
	if !identRe.MatchString(name) {
		writeJSON(w, 400, map[string]any{"error": "invalid name"})
		return
	}
	var body struct {
		ListRule string `json:"list_rule"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid json"})
		return
	}
	if body.ListRule != "public" && body.ListRule != "auth" {
		writeJSON(w, 400, map[string]any{"error": "list_rule must be 'public' or 'auth'"})
		return
	}
	ct, err := s.pool.Exec(r.Context(), `UPDATE _collections SET list_rule=$1 WHERE name=$2`, body.ListRule, name)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if ct.RowsAffected() == 0 {
		writeJSON(w, 404, map[string]any{"error": "no such collection"})
		return
	}
	writeJSON(w, 200, map[string]any{"name": name, "list_rule": body.ListRule})
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
	if err := lockSchema(r.Context(), tx); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	// Block deletion if another collection has a relation pointing here.
	var refs []string
	rows, err := tx.Query(r.Context(), `SELECT name, fields FROM _collections WHERE name <> $1`, name)
	if err == nil {
		for rows.Next() {
			var n string
			var fs []fieldDef
			if rows.Scan(&n, &fs) == nil {
				for _, f := range fs {
					if f.Type == "relation" && f.Relation == name {
						refs = append(refs, n)
					}
				}
			}
		}
		rows.Close()
	}
	if len(refs) > 0 {
		writeJSON(w, 409, map[string]any{"error": "collection is referenced by relation fields in: " + strings.Join(refs, ", ")})
		return
	}
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

type collMeta struct {
	fields   []fieldDef
	listRule string
}

func (s *server) loadColl(ctx context.Context, name string) (*collMeta, bool, error) {
	var fields []fieldDef
	var listRule string
	err := s.pool.QueryRow(ctx, `SELECT fields, list_rule FROM _collections WHERE name=$1`, name).Scan(&fields, &listRule)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return &collMeta{fields: fields, listRule: listRule}, true, nil
}

func fieldByName(fields []fieldDef, name string) (fieldDef, bool) {
	for _, f := range fields {
		if f.Name == name {
			return f, true
		}
	}
	return fieldDef{}, false
}

// ---------- records ----------

func (s *server) handleListRecords(w http.ResponseWriter, r *http.Request, claims *userClaims) {
	name := strings.ToLower(r.PathValue("name"))
	meta, ok, err := s.loadColl(r.Context(), name)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "no such collection"})
		return
	}
	if meta.listRule != "public" && claims == nil {
		writeJSON(w, 401, map[string]any{"error": "authentication required for this collection"})
		return
	}

	// Opportunistic, throttled retention sweep (lazy — only ever on a request).
	s.sweep(r.Context())

	perPage := clampInt(queryInt(r, "perPage", 30), 1, 200)
	page := clampInt(queryInt(r, "page", 1), 1, 1_000_000)
	offset := (page - 1) * perPage

	where, args, err := buildFilter(r.URL.Query().Get("filter"), meta.fields)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "filter: " + err.Error()})
		return
	}
	orderBy, err := buildSort(r.URL.Query().Get("sort"), meta.fields)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "sort: " + err.Error()})
		return
	}

	tbl := quoteIdent("rec_" + name)
	colList := selectCols(meta.fields)
	q := fmt.Sprintf(`SELECT %s FROM %s %s ORDER BY %s LIMIT $%d OFFSET $%d`,
		colList, tbl, where, orderBy, len(args)+1, len(args)+2)
	args = append(args, perPage, offset)
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
	// total honoring the same filter
	var total int
	cargs := args[:len(args)-2]
	_ = s.pool.QueryRow(r.Context(), fmt.Sprintf(`SELECT count(*) FROM %s %s`, tbl, where), cargs...).Scan(&total)
	writeJSON(w, 200, map[string]any{"page": page, "perPage": perPage, "totalItems": total, "items": items})
}

func (s *server) handleCreateRecord(w http.ResponseWriter, r *http.Request, claims *userClaims) {
	name := strings.ToLower(r.PathValue("name"))
	meta, ok, err := s.loadColl(r.Context(), name)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "no such collection"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid json"})
		return
	}

	// Per-account row cap (abuse guard).
	if s.ret.PerAccountMax > 0 {
		if n, err := s.countOwned(r.Context(), claims.Subject); err == nil && n >= s.ret.PerAccountMax {
			writeJSON(w, 403, map[string]any{"error": fmt.Sprintf("per-account record cap reached (%d)", s.ret.PerAccountMax)})
			return
		}
	}
	// Global cap.
	if s.ret.GlobalMax > 0 {
		if n, err := s.countAll(r.Context()); err == nil && n >= s.ret.GlobalMax {
			// try a sweep to make room, then re-check
			s.forceSweep(r.Context())
			if n, err := s.countAll(r.Context()); err == nil && n >= s.ret.GlobalMax {
				writeJSON(w, 403, map[string]any{"error": "global record cap reached"})
				return
			}
		}
	}

	id := newID()
	cols := []string{quoteIdent("id"), quoteIdent("owner")}
	ph := []string{"$1", "$2"}
	args := []any{id, claims.Subject}
	n := 3
	for _, f := range meta.fields {
		v, present := body[f.Name]
		if !present {
			if f.Required {
				writeJSON(w, 400, map[string]any{"error": "missing required field: " + f.Name})
				return
			}
			continue
		}
		cv, err := coerce(f, v)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if cv == nil && f.Required {
			writeJSON(w, 400, map[string]any{"error": "required field cannot be null: " + f.Name})
			return
		}
		// Relation integrity: the referenced record must exist in the target.
		if f.Type == "relation" && cv != nil && cv.(string) != "" {
			var exists bool
			err := s.pool.QueryRow(r.Context(),
				fmt.Sprintf(`SELECT EXISTS(SELECT 1 FROM %s WHERE id=$1)`, quoteIdent("rec_"+f.Relation)), cv).Scan(&exists)
			if err != nil || !exists {
				writeJSON(w, 400, map[string]any{"error": "relation target record does not exist for field " + f.Name})
				return
			}
		}
		cols = append(cols, quoteIdent(f.Name))
		ph = append(ph, "$"+strconv.Itoa(n))
		args = append(args, cv)
		n++
	}
	q := fmt.Sprintf(`INSERT INTO %s (%s) VALUES (%s) RETURNING %s`,
		quoteIdent("rec_"+name), strings.Join(cols, ", "), strings.Join(ph, ", "), selectCols(meta.fields))
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
	// Prune-on-insert: enforce the per-collection newest-N cap immediately.
	s.pruneCollection(r.Context(), name)
	writeJSON(w, 201, items[0])
}

func (s *server) handleGetRecord(w http.ResponseWriter, r *http.Request, claims *userClaims) {
	name := strings.ToLower(r.PathValue("name"))
	id := r.PathValue("id")
	meta, ok, err := s.loadColl(r.Context(), name)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "no such collection"})
		return
	}
	if meta.listRule != "public" && claims == nil {
		writeJSON(w, 401, map[string]any{"error": "authentication required for this collection"})
		return
	}
	q := fmt.Sprintf(`SELECT %s FROM %s WHERE id=$1`, selectCols(meta.fields), quoteIdent("rec_"+name))
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
	meta, ok, err := s.loadColl(r.Context(), name)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, 404, map[string]any{"error": "no such collection"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid json"})
		return
	}
	set := []string{}
	args := []any{}
	n := 1
	for _, f := range meta.fields {
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
		quoteIdent("rec_"+name), strings.Join(set, ", "), n, selectCols(meta.fields))
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
	if _, ok, err := s.loadColl(r.Context(), name); err != nil {
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

// ---------- filter + sort (safe, schema-whitelisted) ----------

var filterRe = regexp.MustCompile(`^([a-z][a-z0-9_]{0,62})\s*(=|!=|>=|<=|>|<|~|!~)\s*(.*)$`)

// buildFilter parses a single "<field> <op> <value>" expression into a safe,
// parameterized WHERE clause. Field names are whitelisted against the collection
// schema (plus id/created/updated); values are always bound parameters. Returns
// the clause ("" or "WHERE ...") and the args slice. No raw user SQL.
func buildFilter(expr string, fields []fieldDef) (string, []any, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return "", nil, nil
	}
	m := filterRe.FindStringSubmatch(expr)
	if m == nil {
		return "", nil, errors.New("expected '<field> <op> <value>' with op in = != > >= < <= ~ !~")
	}
	field, op, rawVal := m[1], m[2], strings.TrimSpace(m[3])
	rawVal = strings.Trim(rawVal, `"'`)

	allowed := map[string]string{"id": "text", "created": "date", "updated": "date"}
	for _, f := range fields {
		allowed[f.Name] = f.Type
	}
	ftype, ok := allowed[field]
	if !ok {
		return "", nil, errors.New("unknown field: " + field)
	}
	col := quoteIdent(field)

	if op == "~" || op == "!~" {
		// substring match — only on text-ish columns.
		switch ftype {
		case "text", "email", "url", "select", "relation", "id":
		default:
			return "", nil, errors.New("~ / !~ only valid on text fields")
		}
		neg := ""
		if op == "!~" {
			neg = "NOT "
		}
		return fmt.Sprintf("WHERE %s %sILIKE $1", col, neg), []any{"%" + rawVal + "%"}, nil
	}

	// typed equality/comparison
	var val any
	switch ftype {
	case "number":
		f, err := strconv.ParseFloat(rawVal, 64)
		if err != nil {
			return "", nil, errors.New("value must be a number")
		}
		val = f
	case "bool":
		b, err := strconv.ParseBool(rawVal)
		if err != nil {
			return "", nil, errors.New("value must be true/false")
		}
		val = b
	case "date":
		t, err := time.Parse(time.RFC3339, rawVal)
		if err != nil {
			t, err = time.Parse("2006-01-02", rawVal)
			if err != nil {
				return "", nil, errors.New("date value must be RFC3339 or YYYY-MM-DD")
			}
		}
		val = t
	default:
		val = rawVal
	}
	return fmt.Sprintf("WHERE %s %s $1", col, op), []any{val}, nil
}

// buildSort parses a comma list like "-created,title" into an ORDER BY clause,
// whitelisting every column against the schema. Defaults to created DESC.
func buildSort(expr string, fields []fieldDef) (string, error) {
	allowed := map[string]bool{"id": true, "created": true, "updated": true}
	for _, f := range fields {
		if f.Type != "json" { // json columns aren't meaningfully sortable
			allowed[f.Name] = true
		}
	}
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return "created DESC", nil
	}
	parts := strings.Split(expr, ",")
	out := []string{}
	for _, p := range parts {
		p = strings.TrimSpace(p)
		dir := "ASC"
		if strings.HasPrefix(p, "-") {
			dir = "DESC"
			p = p[1:]
		} else if strings.HasPrefix(p, "+") {
			p = p[1:]
		}
		if !allowed[p] {
			return "", errors.New("cannot sort by: " + p)
		}
		out = append(out, quoteIdent(p)+" "+dir)
	}
	return strings.Join(out, ", "), nil
}

// ---------- retention enforcement (all lazy/inline) ----------

// pruneCollection keeps only the newest PerCollectionMax records (by created).
func (s *server) pruneCollection(ctx context.Context, name string) {
	if s.ret.PerCollectionMax <= 0 {
		return
	}
	tbl := quoteIdent("rec_" + name)
	// Delete everything beyond the newest N. ctid is a cheap stable row pointer.
	q := fmt.Sprintf(`DELETE FROM %s WHERE ctid IN (
        SELECT ctid FROM %s ORDER BY created DESC OFFSET $1
    )`, tbl, tbl)
	if _, err := s.pool.Exec(ctx, q, s.ret.PerCollectionMax); err != nil {
		// non-fatal: retention is best-effort
		_ = err
	}
}

// sweep runs the age + global retention pass, but at most once per 60s (throttled
// so it doesn't add latency to every request). Lazy: only runs when a request
// arrives, never on a timer, so it never keeps the instance from scaling to zero.
func (s *server) sweep(ctx context.Context) {
	now := time.Now().Unix()
	last := s.lastSweep.Load()
	if now-last < 60 {
		return
	}
	if !s.lastSweep.CompareAndSwap(last, now) {
		return // another request won the race
	}
	// Detached, short-lived context so a cancelled/timed-out request context
	// doesn't abort the sweep (which would still have advanced lastSweep and
	// skipped cleanup for the next 60s).
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s.forceSweep(sctx)
}

// forceSweep deletes records older than MaxAge across all collections and, if the
// global cap is exceeded, trims the oldest records down to the cap.
func (s *server) forceSweep(ctx context.Context) {
	names, err := s.collectionNames(ctx)
	if err != nil {
		return
	}
	if s.ret.MaxAge > 0 {
		cutoff := time.Now().Add(-s.ret.MaxAge)
		for _, n := range names {
			_, _ = s.pool.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE created < $1`, quoteIdent("rec_"+n)), cutoff)
		}
	}
	if s.ret.PerCollectionMax > 0 {
		for _, n := range names {
			s.pruneCollection(ctx, n)
		}
	}
	if s.ret.GlobalMax > 0 {
		total, err := s.countAll(ctx)
		if err == nil && total > s.ret.GlobalMax {
			// Trim the oldest records, largest collections first, until under cap.
			over := total - s.ret.GlobalMax
			type cn struct {
				name  string
				count int
			}
			counts := []cn{}
			for _, n := range names {
				var c int
				_ = s.pool.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM %s`, quoteIdent("rec_"+n))).Scan(&c)
				counts = append(counts, cn{n, c})
			}
			sort.Slice(counts, func(i, j int) bool { return counts[i].count > counts[j].count })
			for _, c := range counts {
				if over <= 0 {
					break
				}
				del := over
				if del > c.count {
					del = c.count
				}
				tbl := quoteIdent("rec_" + c.name)
				q := fmt.Sprintf(`DELETE FROM %s WHERE ctid IN (SELECT ctid FROM %s ORDER BY created ASC LIMIT $1)`, tbl, tbl)
				if ct, err := s.pool.Exec(ctx, q, del); err == nil {
					over -= int(ct.RowsAffected())
				}
			}
		}
	}
}

func (s *server) collectionNames(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT name FROM _collections`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (s *server) countAll(ctx context.Context) (int, error) {
	names, err := s.collectionNames(ctx)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, n := range names {
		var c int
		if err := s.pool.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM %s`, quoteIdent("rec_"+n))).Scan(&c); err == nil {
			total += c
		}
	}
	return total, nil
}

func (s *server) countOwned(ctx context.Context, owner string) (int, error) {
	names, err := s.collectionNames(ctx)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, n := range names {
		var c int
		if err := s.pool.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM %s WHERE owner=$1`, quoteIdent("rec_"+n)), owner).Scan(&c); err == nil {
			total += c
		}
	}
	return total, nil
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
	cols := []string{quoteIdent("id"), quoteIdent("owner")}
	for _, f := range fields {
		cols = append(cols, quoteIdent(f.Name))
	}
	cols = append(cols, quoteIdent("created"), quoteIdent("updated"))
	return strings.Join(cols, ", ")
}

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
	case "email":
		s, ok := v.(string)
		if !ok || !emailRe.MatchString(s) {
			return nil, fmt.Errorf("field %s must be a valid email", f.Name)
		}
		return strings.ToLower(s), nil
	case "url":
		s, ok := v.(string)
		if !ok || !urlRe.MatchString(s) {
			return nil, fmt.Errorf("field %s must be an http(s) URL", f.Name)
		}
		return s, nil
	case "select":
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("field %s must be a string", f.Name)
		}
		for _, opt := range f.Options {
			if opt == s {
				return s, nil
			}
		}
		return nil, fmt.Errorf("field %s must be one of: %s", f.Name, strings.Join(f.Options, ", "))
	case "relation":
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("field %s must be a record id string", f.Name)
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
	case "date":
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("field %s must be an ISO date string", f.Name)
		}
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			// also accept date-only
			t, err = time.Parse("2006-01-02", s)
			if err != nil {
				return nil, fmt.Errorf("field %s must be RFC3339 or YYYY-MM-DD", f.Name)
			}
		}
		return t, nil
	case "json":
		// store as jsonb; marshal whatever was provided
		b, err := json.Marshal(v)
		if err != nil {
			return nil, fmt.Errorf("field %s must be valid json", f.Name)
		}
		return string(b), nil
	}
	return nil, fmt.Errorf("unknown field type for %s", f.Name)
}

func joinCols(cols []string) string {
	if len(cols) == 0 {
		return ""
	}
	return strings.Join(cols, ",\n  ") + ","
}

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

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
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
		if r.URL.Path != "/livez" {
			logger.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}
