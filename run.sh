curl https://bun.sh/install | bash -s -- bun-v1.3.0
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

bun install && bun index.ts