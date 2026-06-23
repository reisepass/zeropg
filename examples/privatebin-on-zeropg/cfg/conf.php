;<?php http_response_code(403); /*
; PrivateBin configuration — the ONLY change vs. stock PrivateBin is the [model]/
; [model_options] block below, which points PrivateBin's Database (PDO) model at the
; zeropg-db container (PGlite over the real Postgres wire) instead of the default
; Filesystem model. No PrivateBin source is patched.
;
; The leading line above is PrivateBin's standard guard so the .php config can't be
; served as plain text.

[main]
name = "PrivateBin on zeropg"
discussion = true
opendiscussion = false
password = true
fileupload = false
burnafterreadingselected = false
defaultformatter = "plaintext"
sizelimit = 10000000
template = "bootstrap5"
languageselection = false
qrcode = true

[expire]
default = "1week"

[expire_options]
5min = 300
10min = 600
1hour = 3600
1day = 86400
1week = 604800
1month = 2592000
never = 0

[formatter_options]
plaintext = "Plain Text"
syntaxhighlighting = "Source Code"
markdown = "Markdown"

[traffic]
limit = 0

[purge]
limit = 300
batchsize = 10

; ---- THE ONLY ZEROPG CHANGE -------------------------------------------------
; Use the Database (PDO) model instead of Filesystem, with a PostgreSQL DSN that
; resolves to the zeropg-db service on the compose network. PrivateBin auto-creates
; its paste/comment/config tables on first connection (plain CHAR/TEXT/INT — no
; Postgres extensions), so there is no schema/migration step.
[model]
class = Database

[model_options]
dsn = "pgsql:host=zeropg-db;port=5432;dbname=privatebin"
tbl = "privatebin_"
usr = "postgres"
pwd = "postgres"
; NOTE: PDO::ATTR_PERSISTENT (opt[12]) is intentionally left OFF so each request
; opens a fresh connection to the single-session wire — the safe path for pglite.
; -----------------------------------------------------------------------------
