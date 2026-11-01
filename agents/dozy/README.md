Dozy — Performance profiler

Purpose

Dozy runs lightweight performance checks to capture basic metrics:

- Measures complete HTTP 200 response transfers, draining bodies without buffering them
- Rejects all other statuses (including redirects and partial responses), request/response errors and aborted transfers
- Emits a short summary report (stdout) and exits 2 on failures or when a completed transfer exceeds THRESHOLD_MS (default 500ms; equality passes)
- TIMEOUT_MS (default 5000ms) is a positive integer total request deadline, including connection and body transfer; trickling bytes do not reset it
- Run local regression fixtures with `node scripts/dozy-profile-test.js`; CI and the weekly workflow run these before profiling real static assets

Design

- Simple Node script using built-in http/https to make requests
- Configurable via environment variables (ENDPOINTS, TIMEOUT_MS, THRESHOLD_MS)
- Intended for scheduled runs or on-demand profiling in CI

Extending

- Integrate with Prometheus/Grafana or push metrics to monitoring
- Add more in-depth Node.js CPU/profile capture via `inspector`

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>