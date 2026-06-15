;<?php http_response_code(403); /*
; PrivateBin configuration for Cloud Run + zeropg sidecar
; Deployed by: https://github.com/reisepass/zeropg
; Format: INI (parsed by parse_ini_file). The first line is a PHP guard that
; returns 403 if this file is fetched directly — standard PrivateBin pattern.

[main]
; File upload disabled: blobs would bloat the single-writer PGlite-backed DB.
fileupload = false
; 512 KiB max paste — keeps individual rows small; default 10 MiB is too large.
sizelimit = 524288
template = "bootstrap5"
discussion = true
opendiscussion = false
compression = "zlib"

[traffic]
; Cloud Run sits behind Google's LB which appends the real IP to X-Forwarded-For.
; Use the first value (original client) for rate limiting.
header = "X_FORWARDED_FOR"
; 1 new paste per 10 seconds per IP — demo-friendly, still rate-limited.
limit = 10

[purge]
limit = 300
batchsize = 20

[model]
class = Database

[model_options]
; zeropg-sidecar binds Postgres wire protocol on localhost:5432.
; connect_timeout=30 gives the sidecar time to finish restoring from GCS on cold start.
dsn = "pgsql:host=127.0.0.1;port=5432;dbname=app;connect_timeout=30"
tbl = "privatebin_"
usr = "postgres"
pwd = ""
; PDO::ATTR_PERSISTENT = 12 — reuse the connection across PHP-FPM requests.
opt[12] = true

; */
