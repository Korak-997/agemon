# Demo recording

`agemon.gif` (shown in the top-level README) is recorded from `agemon.tape` with
[vhs](https://github.com/charmbracelet/vhs). It runs the sandbox, so it uses the fake
backends and changes nothing on the machine.

From a copy of the repository with `node_modules` installed (the run writes `.sandbox/`):

```bash
docker run --rm -v "$PWD":/vhs -w /vhs \
  -v "$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")":/opt/node:ro \
  -e PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --entrypoint bash \
  ghcr.io/charmbracelet/vhs@sha256:ea49a6a1c529be83153e88321892b5585964418f0b9055e8c1e0d732194234a3 \
  -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends git &&
      git config --global user.email demo@example.invalid &&
      git config --global user.name demo &&
      vhs docs/demo/agemon.tape'
```

The vhs image has no Node and no git: the command mounts the host's Node installation
read-only (if `node` is `/usr/bin/node`, that is all of `/usr`, still read-only) and installs
git inside the throwaway container. The container runs as root, so give the files it wrote
back to yourself afterwards:

```bash
sudo chown -R "$(id -u):$(id -g)" .sandbox docs/demo/agemon.gif
```
