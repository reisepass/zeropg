# PrivateBin (official, unmodified) + the zeropg-pointed conf.php baked in.
# This is the ingress container of the Cloud Run service; nginx listens on 8080.
FROM privatebin/nginx-fpm-alpine:latest
COPY conf.php /srv/cfg/conf.php
