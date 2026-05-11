#!/bin/bash
# AgentGate — One-Click VPS Deployment
# Run: sudo bash deploy.sh
set -e

echo "🔐 AgentGate Deployment"
echo "========================"

# Install deps
echo "⏳ Installing dependencies..."
apt update && apt install -y curl git nodejs npm nginx certbot python3-certbot-nginx

# Create app user
if ! id -u agentgate &> /dev/null; then
    useradd -m -s /bin/bash agentgate
fi

# Install app
mkdir -p /opt/agentgate
cd /opt/agentgate

# Copy from current dir if exists
if [ -d "/root/agentgate-server" ]; then
    cp -r /root/agentgate-server/* /opt/agentgate/
fi

cd /opt/agentgate/server && npm install --production

# Generate secrets
SECRET_KEY=$(openssl rand -hex 32)
API_KEY=$(openssl rand -hex 24)

cat > /opt/agentgate/server/.env << EOF
PORT=3000
SECRET_KEY=${SECRET_KEY}
API_KEY=${API_KEY}
NODE_ENV=production
EOF

# Systemd service
cat > /etc/systemd/system/agentgate.service << EOF
[Unit]
Description=AgentGate Policy Engine
After=network.target

[Service]
Type=simple
User=agentgate
WorkingDirectory=/opt/agentgate/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/agentgate/server/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable agentgate
systemctl start agentgate

sleep 2

# Nginx
mkdir -p /var/www/agentgate/landing
cp /opt/agentgate/landing-site/index.html /var/www/agentgate/landing/ 2>/dev/null || true

cat > /etc/nginx/sites-available/agentgate << EOF
server {
    listen 80;
    server_name YOUR_DOMAIN_HERE;

    root /var/www/agentgate/landing;
    index index.html;

    location / {
        try_files \$uri \$uri/ =404;
    }

    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF

ln -sf /etc/nginx/sites-available/agentgate /etc/nginx/sites-enabled/
nginx -t && systemctl restart nginx

echo ""
echo "✅ Deployment Complete!"
echo ""
echo "Next steps:"
echo "  1. Replace YOUR_DOMAIN_HERE in /etc/nginx/sites-available/agentgate"
echo "  2. Run: certbot --nginx -d YOUR_DOMAIN"
echo "  3. Configure .env with Blockonomics API key and SMTP"
echo "  4. Restart: systemctl restart agentgate"
echo ""
echo "Health check: curl http://localhost:3000/health"
echo "Logs: journalctl -u agentgate -f"
