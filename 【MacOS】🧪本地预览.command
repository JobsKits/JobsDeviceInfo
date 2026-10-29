#!/bin/zsh
# 脚本自述：
# - 脚本名称：【MacOS】🧪本地预览.command
# - 核心用途：初始化本地 D1 并启动完整 Worker 与网页，供离线演示和联调。
# - 影响范围：仅本文件夹的 node_modules、.wrangler 和本机 127.0.0.1:8787。
# - 运行提示：双击后回车执行，任意字符取消；启动后 Ctrl+C 停止，不发布远端。

SCRIPT_DIR=""
SCRIPT_BASENAME=""
LOG_FILE=""
WRANGLER=""
HELPER=""

# 按终端能力显示自述标题和正文。
intro_line() {
  local role="$1"
  local message="$2"
  local style="0;34"
  [[ "$role" == title ]] && style="1;31"
  if [[ -t 1 && -n "${TERM:-}" && "${TERM:-}" != dumb && -z "${NO_COLOR+x}" ]]; then
    printf '\033[%sm%s\033[0m\n' "$style" "$message"
  else
    print -r -- "$message"
  fi
}
# 展示本地运行范围，并在任何写入前等待用户确认。
show_script_intro_and_wait() {
  local source_path="${ZSH_ARGZERO}"
  SCRIPT_DIR="$(cd "$(dirname -- "$source_path")" && pwd)"
  SCRIPT_BASENAME="${source_path:t:r}"
  LOG_FILE="${TMPDIR:-/tmp/}${SCRIPT_BASENAME}.log"
  intro_line title 'JobsDeviceInfo · 本地预览'
  intro_line body '1、检查本项目依赖，应用本地 D1 迁移，启动 127.0.0.1:8787。'
  intro_line body '2、本地服务与迁移仅在本机；线上扫码配对入口会转到配置的线上站点，不发布 Worker。'
  intro_line body '3、手机无法通过本机 localhost 回传；真实采集请使用部署后的 HTTPS 地址。'
  intro_line body '4、启动后在浏览器打开 http://127.0.0.1:8787；Ctrl+C 停止预览。'
  intro_line body "日志：${LOG_FILE}"
  case "${1:-}" in
    --help|-h) show_help; exit 0 ;;
    --check) run_readonly_check; exit $? ;;
    '')
      [[ -t 0 ]] || { print -u2 -- '✖ 需要可交互终端。请双击此脚本。'; exit 1; }
      local reply=""
      IFS= read -r 'reply?直接回车启动；任意字符后回车取消：' || exit 1
      if [[ -n "$reply" ]]; then
        print -r -- '已取消，未启动预览。'
        exit 0
      fi
      ;;
    *) print -u2 -- "✖ 未知参数：$1"; show_help; exit 2 ;;
  esac
  (( $# <= 1 )) || { print -u2 -- '✖ 不接受额外参数。'; exit 2; }
}
# 显示只读模式及正常预览的使用方法。
show_help() {
  print -r -- '用法：双击，或 zsh "./【MacOS】🧪本地预览.command"'
  print -r -- '--help    显示说明。'
  print -r -- '--check   仅检查本地配置和依赖，不安装、不联网、不写日志。'
  print -r -- '预览状态保存在 .wrangler；停止终端不会删除其中的本地测试数据。'
}
# 只检查本地依赖和配置，不接触 Cloudflare 认证或数据库。
run_readonly_check() {
  local node_bin="$(command -v node 2>/dev/null)"
  [[ -z "$node_bin" && -x /opt/homebrew/bin/node ]] && node_bin=/opt/homebrew/bin/node
  [[ -z "$node_bin" && -x /usr/local/bin/node ]] && node_bin=/usr/local/bin/node
  [[ -n "$node_bin" ]] || { print -u2 -- '✖ 请先安装 Node.js 22.13+：https://nodejs.org/'; return 1; }
  "$node_bin" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))process.exit(1);console.log("Node.js: "+process.version)' || return 1
  local npm_bin="$(command -v npm 2>/dev/null)"
  [[ -z "$npm_bin" && -x "${node_bin:h}/npm" ]] && npm_bin="${node_bin:h}/npm"
  [[ -n "$npm_bin" ]] || { print -u2 -- '✖ 缺少 npm，请修复 Node.js 官方安装。'; return 1; }
  NODE_DISABLE_COMPILE_CACHE=1 "$node_bin" "$npm_bin" --version || return 1
  "$node_bin" "${SCRIPT_DIR}/scripts/deploy-config.mjs" check || return 1
  if "$node_bin" "${SCRIPT_DIR}/scripts/deploy-config.mjs" check-deps 2>/dev/null; then
    print -r -- '✔ 本地依赖版本一致。'
  else
    print -r -- '⚠ 正式预览前需要确认安装项目依赖。'
  fi
}
# 确认后初始化当前进程与纯文本日志。
initialize_runtime() {
  setopt NO_NOMATCH PIPE_FAIL
  export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
  export NO_COLOR=1 FORCE_COLOR=0 CLICOLOR=0 WRANGLER_SEND_METRICS=false
  export npm_config_color=false
  umask 077
  : > "$LOG_FILE" || exit 1
  WRANGLER="${SCRIPT_DIR}/node_modules/.bin/wrangler"
  HELPER="${SCRIPT_DIR}/scripts/deploy-config.mjs"
  cd "$SCRIPT_DIR" || exit 1
}
# 同步显示和记录常规日志。
log() {
  print -r -- "$1" | tee -a "$LOG_FILE"
}
# 输出失败原因并阻断后续操作。
die() {
  log "✖ $1"
  log "日志：${LOG_FILE}"
  exit 1
}
# 去掉颜色、访问令牌和回调令牌，避免本地日志泄漏。
sanitize_stream() {
  /usr/bin/perl -pe 's/\e\[[0-9;?]*[ -\/]*[\@-~]//g; s/((?:Bearer|oauth_token|api_token|access_token|refresh_token|CLOUDFLARE_API_TOKEN)[\s:="]+)[^\s",;]+/${1}[REDACTED]/ig; s#(/api/profile/)[A-Za-z0-9_-]+#${1}[REDACTED]#g'
}
# 执行可审阅的单个步骤并保留原始命令退出码。
run_step() {
  local label="$1"
  shift
  log "➤ ${label}"
  "$@" 2>&1 | sanitize_stream | tee -a "$LOG_FILE"
  local codes=("${pipestatus[@]}")
  (( codes[1] == 0 && codes[2] == 0 && codes[3] == 0 )) || die "步骤失败：${label}"
}
# 检查必需环境，项目依赖缺失时经确认后按锁文件安装。
check_environment() {
  command -v node >/dev/null 2>&1 || die '缺少 Node.js 22.13+。请从 https://nodejs.org/ 安装后重试。'
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))process.exit(1)' || die 'Node.js 版本过低，需要 22.13+。'
  command -v npm >/dev/null 2>&1 || die '缺少 npm，请修复 Node.js 官方安装。'
  node --version >> "$LOG_FILE" 2>&1 || die 'Node.js 无法执行。'
  npm --version >> "$LOG_FILE" 2>&1 || die 'npm 无法执行。'
  node "$HELPER" check || die '项目配置检查失败。'
  if ! node "$HELPER" check-deps >/dev/null 2>&1; then
    [[ -t 0 ]] || die '依赖缺失，请在终端确认安装。'
    log '来源：https://registry.npmjs.org/；版本：package-lock.json；目标：本文件夹 node_modules。'
    local answer=""
    IFS= read -r 'answer?必需依赖缺失：直接回车安装；任意字符后回车取消：' || die '输入结束，取消安装。'
    [[ -z "$answer" ]] || die '已取消安装。'
    run_step '安装项目锁定依赖' npm ci --registry=https://registry.npmjs.org/ --ignore-scripts
    node "$HELPER" check-deps >/dev/null 2>&1 || die '安装后依赖仍不完整，停止预览。'
  fi
  [[ -x "$WRANGLER" ]] || die '项目内 Wrangler 入口缺失。'
  run_step '验证项目内 Wrangler' "$WRANGLER" --version
}
# 仅初始化本地 SQLite 存储，不向 Cloudflare 远程 D1 写入。
prepare_local_database() {
  run_step '初始化本地 D1' "$WRANGLER" d1 migrations apply DB --local --config "${SCRIPT_DIR}/wrangler.json"
}
# 由已锁定依赖生成打包在项目内的二维码资源。
build_preview_assets() {
  run_step '生成本地二维码资源' npm run build:assets
}
# 启动仅绑定回环地址的开发服务，退出码由真实服务决定。
start_preview() {
  log '✔ 本地预览：http://127.0.0.1:8787'
  log '演示和联调用本机地址；真机采集用部署后的 HTTPS 地址。按 Ctrl+C 停止。'
  if [[ "${JOBS_DEVICE_NO_OPEN:-0}" != 1 ]]; then
    /usr/bin/open 'http://127.0.0.1:8787' || log '⚠ 无法自动打开浏览器，请手动打开上方地址。'
  fi
  run_step '启动本地 Worker' "$WRANGLER" dev --ip 127.0.0.1 --port 8787 --config "${SCRIPT_DIR}/wrangler.json"
}
# 编排固定说明、本地依赖检查和预览启动。
main() {
  show_script_intro_and_wait "$@" # 先显示运行范围并等待用户确认。
  initialize_runtime # 确认后初始化进程环境和日志。
  check_environment # 检查本机依赖，缺失时单独确认安装。
  build_preview_assets # 从锁定依赖生成可离线使用的二维码资源。
  prepare_local_database # 仅迁移本地开发数据库。
  start_preview # 启动本机预览并保留退出状态。
}

main "$@"
