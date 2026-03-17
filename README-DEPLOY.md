# NeoTechMind 部署说明（Docker + Caddy）

本说明适用于当前项目的“本地打包 -> 上传服务器 -> Docker 运行 -> Caddy 反代 HTTPS”流程。

## 0. 本地启动（开发环境）

### 0.1 安装依赖

```powershell
cd D:\PycharmProjects\BitBuzz\astro-theme-pure-main
npm ci
```

### 0.2 准备环境变量

复制 `.env.example` 为 `.env`，并至少确认这些字段：

- `DATABASE_URL=postgresql://...`
- `DATABASE_SSL=disable`（本地一般可用）
- `ADMIN_USERNAME=...`
- `ADMIN_PASSWORD=...`

如果你本地数据库名是 `bitbuzz`，可参考：

```env
DATABASE_URL=postgresql://postgres:root123@localhost:5432/bitbuzz
DATABASE_SSL=disable
ADMIN_USERNAME=Devlin
ADMIN_PASSWORD=NeoTechMind-xuyw-20050920
```

### 0.3 启动开发服务器

```powershell
npm run dev
```

默认访问：

- 前台：`http://localhost:4321`
- 后台：`http://localhost:4321/admin`

### 0.4 本地生产构建验证（可选）

```powershell
npm run build
npm run preview
```

## 1. 本地打包应用镜像

在项目根目录执行：

```powershell
cd D:\PycharmProjects\BitBuzz\astro-theme-pure-main

docker buildx build --platform linux/amd64 `
  --build-arg BUILD_DATABASE_URL="postgresql://postgres:root123@host.docker.internal:5432/bitbuzz" `
  --build-arg BUILD_DATABASE_SSL=disable `
  -t neotechmind-app:20260316 --load .

docker save -o .\neotechmind-app-20260316.tar neotechmind-app:20260316
```

如果你还需要首次部署数据库，另外准备：

- `postgres18-alpine.tar`
- `bitbuzz.dump`

## 2. 上传到服务器

上传到服务器目录（示例）：

```bash
/opt/NeoTechMind
```

至少需要：

- `neotechmind-app-20260316.tar`

首次部署还需要：

- `postgres18-alpine.tar`
- `bitbuzz.dump`

## 3. 服务器安装 Docker（Ubuntu）

```bash
apt update
apt install -y docker.io
systemctl enable --now docker
docker --version
```

## 4. 首次启动 PostgreSQL 并导入数据（仅首次）

```bash
cd /opt/NeoTechMind

docker load -i postgres18-alpine.tar
docker network create neotechmind-net 2>/dev/null || true
docker volume create neotechmind-pgdata 2>/dev/null || true

docker run -d --name neotechmind-db --restart unless-stopped \
  --network neotechmind-net \
  -e POSTGRES_DB=bitbuzz \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD='root123' \
  -v neotechmind-pgdata:/var/lib/postgresql/data \
  docker.m.daocloud.io/library/postgres:18-alpine

until docker exec neotechmind-db pg_isready -U postgres -d bitbuzz >/dev/null 2>&1; do sleep 1; done

docker cp bitbuzz.dump neotechmind-db:/tmp/bitbuzz.dump
docker exec neotechmind-db pg_restore -U postgres -d bitbuzz --clean --if-exists --no-owner --no-acl /tmp/bitbuzz.dump
```

## 5. 启动/更新应用容器

每次发布新版本都执行：

```bash
cd /opt/NeoTechMind

docker load -i neotechmind-app-20260316.tar
docker rm -f neotechmind-app 2>/dev/null || true

docker run -d --name neotechmind-app --restart unless-stopped \
  --network neotechmind-net \
  -e DATABASE_URL='postgresql://postgres:root123@neotechmind-db:5432/bitbuzz' \
  -e DATABASE_SSL=disable \
  -e ADMIN_USERNAME='Devlin' \
  -e ADMIN_PASSWORD='NeoTechMind-xuyw-20050920' \
  -e ORIGIN='https://cslearner.xyz' \
  -e HOST=0.0.0.0 \
  -e PORT=4321 \
  -e NODE_ENV=production \
  neotechmind-app:20260316

docker logs --tail=80 neotechmind-app
```

## 6. Caddy 反代 + 自动 HTTPS

创建配置：

```bash
mkdir -p /opt/NeoTechMind/caddy
cat >/opt/NeoTechMind/caddy/Caddyfile <<'EOF'
www.cslearner.xyz {
  redir https://cslearner.xyz{uri} 308
}

cslearner.xyz {
  reverse_proxy neotechmind-app:4321
  encode gzip
}
EOF
```

启动 Caddy：

```bash
docker rm -f neotechmind-caddy 2>/dev/null || true
docker run -d --name neotechmind-caddy --restart unless-stopped \
  --network neotechmind-net \
  -p 80:80 -p 443:443 \
  -v /opt/NeoTechMind/caddy/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data \
  -v caddy_config:/config \
  docker.m.daocloud.io/library/caddy:2-alpine

docker logs --tail=120 neotechmind-caddy
```

## 7. 云侧配置

在阿里云安全组放行：

- TCP 80
- TCP 443

并确保 DNS 已解析到服务器公网 IP：

- `cslearner.xyz`
- `www.cslearner.xyz`

## 8. 常用运维命令

```bash
docker ps
docker logs -f neotechmind-app
docker logs -f neotechmind-caddy
docker exec -it neotechmind-db psql -U postgres -d bitbuzz
```

## 9. 常见问题

### 1) `Cross-site POST form submissions are forbidden`

- 检查应用是否使用最新镜像（已含 `security.checkOrigin: false`）。
- 检查运行参数是否包含：
  - `ORIGIN='https://cslearner.xyz'`
- 清理浏览器该站点 Cookie 后重试。

### 2) Caddy 返回 502

- 确认 `neotechmind-app` 正在运行：
  - `docker ps | grep neotechmind-app`
- 确认 Caddy 与 app 在同一 network：
  - `docker network inspect neotechmind-net`

### 3) 数据库导入版本不匹配

- `pg_restore: unsupported version` 说明 dump 与 postgres 主版本不一致。
- 使用与 dump 导出版本一致的 PostgreSQL 镜像。
