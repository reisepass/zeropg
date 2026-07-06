# Adminer with the zeropg auto-login customization baked in (see
# examples/editors/adminer-autologin). Listens on 8081 as a Cloud Run sidecar.
FROM adminer:5
COPY index.php /var/www/html/index.php
ENV PGSSLMODE=disable
CMD ["php", "-S", "0.0.0.0:8081", "-t", "/var/www/html"]
