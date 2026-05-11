# AgentGate — Deploy Guide

## Quick Start (VPS con Hostinguer)

### 1. Conectar al VPS
```bash
ssh root@TU_IP
```

### 2. Instalar dependencias
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs npm nginx git curl
```

### 3. Subir los archivos
Desde tu Mac:
```bash
scp -r /Users/molder/projects/github-molder/agentgate/* root@TU_IP:/opt/agentgate/
```

### 4. Configurar
```bash
cd /opt/agentgate/server
npm install --production

# Editar .env
nano .env
```

Configura estas variables:
```
PORT=3000
BLOCKONOMICS_API_KEY=tu_api_key_de_blockonomics
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=tu_email@gmail.com
SMTP_PASS=tu_app_password_de_16_chars
CB_URL=https://tudominio.com
```

### 5. Crear servicio y levantar
```bash
cat > /etc/systemd/system/agentgate.service << 'EOF'
[Unit]
Description=AgentGate Policy Engine
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/agentgate/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable agentgate
systemctl start agentgate
systemctl status agentgate
```

### 6. Configurar Nginx
```bash
cat > /etc/nginx/sites-available/agentgate << 'EOF'
server {
    listen 80;
    server_name TU_DOMINIO.com;

    root /opt/agentgate/landing-site;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF

ln -sf /etc/nginx/sites-available/agentgate /etc/nginx/sites-enabled/
nginx -t && systemctl restart nginx
```

### 7. SSL (Let's Encrypt)
```bash
apt install certbot python3-certbot-nginx -y
certbot --nginx -d TU_DOMINIO.com
```

### 8. Verificar
```bash
curl https://TU_DOMINIO.com/health
# → {"status":"ok","version":"0.1.0","service":"agentgate","agents_count":0}
```

## Comandos Útiles

```bash
# Logs en tiempo real
journalctl -u agentgate -f

# Reiniciar
systemctl restart agentgate

# Verificar estado
systemctl status agentgate

# Probar API
curl -X POST https://TU_DOMINIO.com/api/register \
  -H "Content-Type: application/json" \
  -d '{"name":"test","tier":"free"}'
```

## Publicar SDK en npm

Desde tu Mac:
```bash
cd /Users/molder/projects/github-molder/agentgate/packages/sdk
npm adduser
npm publish
```

## Publicar SDK en Python

```bash
cd /Users/molder/projects/github-molder/agentgate/packages/sdk-python
python3 setup.py sdist bdist_wheel
pip install twine
twine upload dist/*
```
