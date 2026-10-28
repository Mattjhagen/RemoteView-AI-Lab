# R510 environment — 2026-10-28

Verified directly over SSH as matt in /home/matt/RemoteView-AI-Lab.

- Ubuntu 24.04.5 LTS; kernel 6.8.0-147-generic.
- Two Xeon E5620 CPUs; 16 logical CPUs; 47 GiB RAM, about 40 GiB available.
- Project filesystem: 1.3 TiB total, 594 GiB available.
- Python 3.12.3; Node 22.23.4. PostgreSQL client `psql` was not on PATH; database availability has not been established.
- Baseline commit: 819d9fd. Origin: https://github.com/Mattjhagen/RemoteView-AI-Lab.git.
- Existing app listens on 127.0.0.1:8000. It remains running with its original code until restarted.
- Existing services include Ollama, Docker, Cloudflare tunnels, web servers, SDR/aircraft services, Samba, SSH and Tailscale. No service configuration was changed.
- Other occupied ports include 80, 3000, 3001, 3008, 5000–5005, 8002, 8081, 8504 and 8554–8555. Do not reuse them without checking again.
- Existing Ollama also listens locally on 11434. No installation, model download, or configuration change was performed.
- Requested remote endpoint http://100.92.82.62:11434/api/tags returned qwen2.5-coder:3b, Q4_K_M, digest f72c60cabf6237b07f6e632b2c48d533cef25eda2efbd34bed21c5e9c01e6225. Endpoint remains environment-configured.

## Codex sandbox diagnosis

Bubblewrap 0.9.0 independently reproduces:

```
bwrap --unshare-user --unshare-net --ro-bind / / /bin/true
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

A user-namespace-only probe also failed to set up its UID map. The kernel log explicitly reports AppArmor profile `unprivileged_userns` denying bwrap's write to `proc/.../uid_map`. `kernel.unprivileged_userns_clone=1` and `kernel.apparmor_restrict_unprivileged_userns=1`.

This establishes a host namespace/AppArmor restriction independent of app code. The precise loopback denial was not separately logged in the inspected excerpt. The user's existing `codex --sandbox danger-full-access` invocation bypassed the failing sandbox and completed work; it does not repair sandbox isolation. Direct SSH works too. Do not disable AppArmor globally, change sysctls, or alter security profiles without approval. A narrowly scoped sandbox repair remains a separate system administration task.
