# Deploying the Coordinator

The coordinator is a single Hono server with a SQLite database. It runs on Fly.io's free tier.

## First deploy

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh
fly auth login

# From the repo root
fly launch --name tokens-at-home   # creates the app, detects Dockerfile

# Create the persistent volume for SQLite
fly volumes create tah_data --size 1 --region ord

fly deploy
```

The `/health` endpoint will confirm it's up:

```bash
curl https://tokens-at-home.fly.dev/health
# {"ok":true,"version":"0.0.1"}
```

## Subsequent deploys

```bash
fly deploy
```

## Configuration

All config is via environment variables. Set them with `fly secrets set`:

```bash
fly secrets set SECRET_KEY=your-secret-here
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port (set by Fly automatically) |
| `DATABASE_URL` | `/data/tah.db` | SQLite path — keep on the mounted volume |
| `NODE_ENV` | `production` | |

## Pointing users at your coordinator

Once deployed, users set the coordinator URL:

```bash
tah config coordinatorUrl https://tokens-at-home.fly.dev
```

Or publish a wrapper script/config with it baked in.

## Monitoring

```bash
fly logs                   # tail live logs
fly status                 # machine status
fly ssh console            # SSH into the machine
fly ssh console -C "ls /data"   # check the SQLite file
```

## Scaling

The free tier (1 shared CPU, 256 MB RAM) handles hundreds of concurrent contributors comfortably — the coordinator is mostly idle between polls. If you need more:

```bash
fly scale memory 512       # bump to 512 MB
fly scale count 2          # add a second machine (requires switching to PostgreSQL)
```

Note: running multiple machines with SQLite will cause write conflicts. Switch to PostgreSQL before scaling beyond 1 machine.
