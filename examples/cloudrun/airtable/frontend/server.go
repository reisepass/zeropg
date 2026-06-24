// Tiny static file server for the airtable-on-zeropg SPA. A single Go binary so
// the FRONTEND service boots near-instantly (no node runtime, no framework SSR)
// and renders the shell immediately while the backend cold-starts in parallel.
//
// It serves index.html / app.js from disk and synthesises /config.js from the
// AIRTABLE_API env var, so the same image points at any backend without a rebuild.
//
// At container entrypoint we ALSO fire a server-side fire-and-forget wake at the
// backend (see entrypoint), so the backend begins cold-starting the instant the
// frontend instance comes up, even before the browser's own wake call.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	port := getenv("PORT", "8080")
	apiBase := getenv("AIRTABLE_API", "")
	dir := getenv("STATIC_DIR", "/app/static")

	configJS := fmt.Sprintf("window.AIRTABLE_API = %q;\n", apiBase)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/config.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(configJS))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == "/" {
			p = "/index.html"
		}
		// only serve known static assets; everything else falls back to index
		clean := filepath.Clean(p)
		if strings.Contains(clean, "..") {
			http.Error(w, "bad path", 400)
			return
		}
		full := filepath.Join(dir, clean)
		if _, err := os.Stat(full); err != nil {
			full = filepath.Join(dir, "index.html")
		}
		http.ServeFile(w, r, full)
	})

	log.Printf("[frontend] static on :%s -> backend %q (dir %s)", port, apiBase, dir)
	srv := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
