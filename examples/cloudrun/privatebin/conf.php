; PrivateBin config for Cloud Run on zeropg. The ONLY change vs stock PrivateBin
; is the [model]/[model_options] block: store pastes in the zeropg-db sidecar
; (PGlite over the Postgres wire, durable home = GCS) instead of the local
; filesystem. The sidecar serves the wire on localhost:5432 (shared with this
; container in the same Cloud Run service). PrivateBin auto-creates its tables.

[main]
discussion = true
opendiscussion = false
password = true
fileupload = false
burnafterreadingselected = false
defaultformatter = "plaintext"

[expire]
default = "1week"

[model]
class = Database

[model_options]
dsn = "pgsql:host=127.0.0.1;port=5432;dbname=privatebin"
tbl = "privatebin_"
usr = "postgres"
pwd = "postgres"
