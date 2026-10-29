#!/bin/zsh
# 脚本自述：
# - 脚本名称：【MacOS】🚀部署到Cloudflare.command
# - 核心用途：检查本项目、复用或创建专属 D1 数据库，并部署到 Cloudflare Workers。
# - 影响范围：项目内依赖与 .deploy 配置、指定 Cloudflare 账户下的同名 Worker / D1 及可选独立域名。
# - 运行提示：双击后回车执行，任意字符或 Ctrl+C 取消；首次登录由用户在浏览器亲自授权。

SCRIPT_DIR=""
SCRIPT_PATH=""
SCRIPT_BASENAME=""
LOG_FILE=""
MODE="interactive"
USE_COLOR=0
WRANGLER=""
ACCOUNT_ID=""
WORKER_NAME=""
DATABASE_NAME=""
CONFIG_FILE=""
HELPER=""
WHOAMI_FILE=""
UPLOAD_CONFIG=""
HEALTH_NETWORK="direct"
HEALTH_PROXY_URL=""
HEALTH_CURL_ARGS=()

# 根据终端能力渲染自述，日志始终不含颜色。
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
# 在任何业务操作前展示用途、范围和取消方式。
show_script_intro_and_wait() {
  local source_path="${ZSH_ARGZERO}"
  SCRIPT_DIR="$(cd "$(dirname -- "$source_path")" && pwd)"
  SCRIPT_PATH="${SCRIPT_DIR}/${source_path:t}"
  SCRIPT_BASENAME="${source_path:t:r}"
  LOG_FILE="${TMPDIR:-/tmp/}${SCRIPT_BASENAME}.log"
  intro_line title 'JobsDeviceInfo · 部署到 Cloudflare'
  intro_line body '1、检查本项目依赖与测试，复用或创建专属 D1，再发布指定 Worker。'
  intro_line body '2、仅使用指定账户、Worker、D1；可选独立 custom_domain 由 Cloudflare 生成 DNS/TLS，不覆盖已有记录或原站点。'
  intro_line body '3、浏览器登录状态与命令行授权独立；缺少授权时由你在浏览器亲自确认。'
  intro_line body '4、发布后网站可公开访问；采集结果只供持有当前会话 Cookie 的浏览器查看。'
  intro_line body "日志：${LOG_FILE}"
  case "${1:-}" in
    --help|-h) show_help; exit 0 ;;
    --check) run_readonly_check; exit $? ;;
    --deploy) MODE="authorized" ;;
    '')
      if [[ ! -t 0 ]]; then
        print -u2 -- '✖ 当前没有可交互输入。请双击脚本，或在已审阅后明确使用 --deploy。'
        exit 1
      fi
      local reply=""
      IFS= read -r 'reply?已了解范围：直接回车执行；任意字符后回车取消：' || exit 1
      if [[ -n "$reply" ]]; then
        print -r -- '已取消，未执行业务。'
        exit 0
      fi
      ;;
    *) print -u2 -- "✖ 未知参数：$1"; show_help; exit 2 ;;
  esac
  if (( $# > 1 )); then
    print -u2 -- '✖ 不接受额外参数。'
    exit 2
  fi
}
# 输出可用参数，不触发安装或远程访问。
show_help() {
  print -r -- '用法：双击，或 zsh "./【MacOS】🚀部署到Cloudflare.command"'
  print -r -- '--help    显示说明。'
  print -r -- '--check   仅检查本地 Node/npm、模板和已安装依赖，不写日志、不联网。'
  print -r -- '--deploy  明确执行已审阅的部署；复用现有授权，无交互时不安装、不开启新 OAuth。'
  print -r -- '首次缺少依赖时会单独确认 npm ci；取消、失败或身份不匹配会停止。'
  print -r -- 'JOBS_DEVICE_HEALTH_NETWORK=direct|system-proxy 选择健康检查与安全域名绑定 API 的单条 curl 网络方式；默认 direct。'
}
# 只读检查已存在的环境，不初始化日志、不读认证凭据。
run_readonly_check() {
  local node_bin="$(command -v node 2>/dev/null)"
  [[ -z "$node_bin" && -x /opt/homebrew/bin/node ]] && node_bin=/opt/homebrew/bin/node
  [[ -z "$node_bin" && -x /usr/local/bin/node ]] && node_bin=/usr/local/bin/node
  if [[ -z "$node_bin" ]]; then
    print -u2 -- '✖ 缺少 Node.js 22.13 或更高版本：https://nodejs.org/'
    return 1
  fi
  "$node_bin" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))process.exit(1);console.log("Node.js: "+process.version)' || return 1
  local npm_bin="$(command -v npm 2>/dev/null)"
  [[ -z "$npm_bin" && -x "${node_bin:h}/npm" ]] && npm_bin="${node_bin:h}/npm"
  [[ -n "$npm_bin" ]] || { print -u2 -- '✖ 缺少 npm，请修复 Node.js 官方安装。'; return 1; }
  NODE_DISABLE_COMPILE_CACHE=1 "$node_bin" "$npm_bin" --version || return 1
  "$node_bin" "${SCRIPT_DIR}/scripts/deploy-config.mjs" check || return 1
  if "$node_bin" "${SCRIPT_DIR}/scripts/deploy-config.mjs" check-deps 2>/dev/null; then
    print -r -- '✔ 直接依赖版本与 package.json 一致。'
  else
    print -r -- '⚠ 项目依赖尚未完整安装或版本不一致；正式执行时会询问 npm ci。'
  fi
  print -r -- '✔ 本地只读检查完成；尚未检查 Cloudflare 远程权限。'
}
# 初始化当前进程与项目内运行文件，保持系统配置不变。
initialize_runtime() {
  setopt NO_NOMATCH PIPE_FAIL
  export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
  export NO_COLOR=1 FORCE_COLOR=0 CLICOLOR=0 WRANGLER_SEND_METRICS=false
  export npm_config_color=false
  umask 077
  : > "$LOG_FILE" || exit 1
  HELPER="${SCRIPT_DIR}/scripts/deploy-config.mjs"
  CONFIG_FILE="${SCRIPT_DIR}/.deploy/wrangler.json"
  UPLOAD_CONFIG="${SCRIPT_DIR}/.deploy/worker-upload.json"
  WRANGLER="${SCRIPT_DIR}/node_modules/.bin/wrangler"
  cd "$SCRIPT_DIR" || exit 1
}
# 显示简明状态并写入纯文本日志。
log() {
  print -r -- "$1" | tee -a "$LOG_FILE"
}
# 报告失败并停止，不继续执行后续远程业务。
die() {
  log "✖ $1"
  log "日志：${LOG_FILE}"
  exit 1
}
# 过滤颜色与可能出现在命令错误中的令牌内容。
sanitize_stream() {
  /usr/bin/perl -pe 's/\e\[[0-9;?]*[ -\/]*[\@-~]//g; s/((?:Bearer|oauth_token|api_token|access_token|refresh_token|CLOUDFLARE_API_TOKEN)[\s:="]+)[^\s",;]+/${1}[REDACTED]/ig; s#(https?://)[^/\s@]+:[^/\s@]+\@#${1}[REDACTED]\@#g; s#(/api/profile/)[A-Za-z0-9_-]+#${1}[REDACTED]#g'
}
# 执行单个明确步骤，并同步终端与日志及准确退出码。
run_step() {
  local label="$1"
  shift
  log "➤ ${label}"
  "$@" 2>&1 | sanitize_stream | tee -a "$LOG_FILE"
  local codes=("${pipestatus[@]}")
  (( codes[1] == 0 && codes[2] == 0 && codes[3] == 0 )) || die "步骤失败：${label}"
}
# 仅在真实终端中确认当前必需的安装操作。
confirm_install() {
  local answer=""
  [[ -t 0 ]] || die '当前缺少必需依赖，非交互模式不执行安装。请双击脚本完成依赖确认。'
  log '来源：https://registry.npmjs.org/（锁文件中的精确版本）；目标：本文件夹的 node_modules。'
  IFS= read -r 'answer?缺少本项目必需依赖：直接回车安装；任意字符后回车取消：' || die '输入已结束，取消安装。'
  [[ -z "$answer" ]] || die '已取消依赖安装。'
}
# 自检 Node/npm 和项目依赖，只修复当前缺失的项目依赖。
check_environment() {
  command -v node >/dev/null 2>&1 || die '缺少 Node.js。请从 https://nodejs.org/ 安装 22.13+，再重新运行；不会自动修改 Homebrew。'
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))process.exit(1)' || die '需要 Node.js 22.13 或更高版本：https://nodejs.org/'
  command -v npm >/dev/null 2>&1 || die '缺少 npm。请修复 Node.js 官方安装后重试。'
  node --version >> "$LOG_FILE" 2>&1 || die 'Node.js 不可用。'
  npm --version >> "$LOG_FILE" 2>&1 || die 'npm 不可用。'
  node "$HELPER" check || die '项目配置检查失败。'
  if ! node "$HELPER" check-deps >/dev/null 2>&1; then
    confirm_install
    run_step '安装锁定的项目依赖' npm ci --registry=https://registry.npmjs.org/ --ignore-scripts
    node "$HELPER" check-deps >/dev/null 2>&1 || die '安装后依赖仍不完整，请检查 npm 日志。'
  fi
  [[ -x "$WRANGLER" ]] || die '项目内 Wrangler 入口缺失，请检查 node_modules。'
  run_step '验证项目内 Wrangler 可执行性' "$WRANGLER" --version
}
# 只读取当前已启用的系统 HTTPS 代理，不采集无关键或修改系统状态。
read_system_https_proxy() {
  local proxy_state="$(/usr/sbin/scutil --proxy 2>/dev/null)" || return 1
  local enabled="$(print -r -- "$proxy_state" | /usr/bin/awk '$1 == "HTTPSEnable" {print $3; exit}')"
  local proxy_host="$(print -r -- "$proxy_state" | /usr/bin/awk '$1 == "HTTPSProxy" {print $3; exit}')"
  local proxy_port="$(print -r -- "$proxy_state" | /usr/bin/awk '$1 == "HTTPSPort" {print $3; exit}')"
  [[ "$enabled" == 1 && -n "$proxy_host" && -n "$proxy_port" ]] || return 1
  local host_pattern='^([A-Za-z0-9.-]+|[a-fA-F0-9:]+|\[[a-fA-F0-9:]+\])$'
  local port_pattern='^[0-9]{1,5}$'
  [[ "$proxy_host" =~ "$host_pattern" && "$proxy_port" =~ "$port_pattern" ]] || return 1
  (( 10#$proxy_port >= 1 && 10#$proxy_port <= 65535 )) || return 1
  if [[ "$proxy_host" == *:* && "$proxy_host" != \[*\] ]]; then
    proxy_host="[${proxy_host}]"
  fi
  print -r -- "http://${proxy_host}:${proxy_port}"
}
# 明确当前 curl 请求的网络范围和恢复方式，不持久化代理。
configure_health_network() {
  HEALTH_NETWORK="${JOBS_DEVICE_HEALTH_NETWORK:-direct}"
  if [[ -z "${JOBS_DEVICE_HEALTH_NETWORK+x}" && "$MODE" == interactive ]]; then
    local available_proxy="$(read_system_https_proxy)"
    if [[ -n "$available_proxy" ]]; then
      command -v fzf >/dev/null 2>&1 || die '选择网络方式需要 fzf；请安装 fzf，或明确设置 JOBS_DEVICE_HEALTH_NETWORK=direct 后重试。'
      fzf --version >/dev/null 2>&1 || die 'fzf 无法执行，停止网络方式选择。'
      local choice=""
      choice="$(printf 'direct\t直连（默认，不使用本次显式代理）\nsystem-proxy\t使用当前系统 HTTPS 代理\n' | fzf --delimiter=$'\t' --with-nth=2 --prompt='部署检查网络 > ' --header='仅健康检查与独立域名绑定 API；回车确认，Esc 取消')" || die '已取消网络方式选择。'
      [[ -n "$choice" ]] || die '未选择网络方式，停止部署。'
      HEALTH_NETWORK="${choice%%$'\t'*}"
    fi
  fi
  case "$HEALTH_NETWORK" in
    direct)
      HEALTH_CURL_ARGS=(--proxy '' --noproxy '*')
      log 'ℹ 健康检查与安全域名 API 使用直连：不注入本次显式代理，底层系统路由保持原样。'
      ;;
    system-proxy)
      HEALTH_PROXY_URL="$(read_system_https_proxy)" || die '系统未启用有效静态 HTTPS 代理；不会猜测端口、启用代理或静默改选其它线路。'
      HEALTH_CURL_ARGS=(--proxy "$HEALTH_PROXY_URL" --noproxy '')
      log '⚠ 将沿用当前系统代理改变本次请求路径：仅健康检查和安全域名绑定 API 的 curl 子进程，连接可能因代理失效而失败。'
      log "代理地址：${HEALTH_PROXY_URL}（不接受或记录代理凭据）"
      log '恢复：单条 curl 结束即停止使用；不修改系统、用户或全局环境。后续选择 direct 即不注入本次代理。'
      ;;
    *) die 'JOBS_DEVICE_HEALTH_NETWORK 仅支持 direct 或 system-proxy。' ;;
  esac
}
# 取得当前已有的 Cloudflare 授权，首次授权由用户操作浏览器。
check_cloudflare_auth() {
  mkdir -p "${SCRIPT_DIR}/.deploy" || die '无法创建项目部署配置目录。'
  WHOAMI_FILE="${SCRIPT_DIR}/.deploy/whoami.json"
  if ! "$WRANGLER" whoami --json > "$WHOAMI_FILE" 2> "${SCRIPT_DIR}/.deploy/auth-error.log"; then
    [[ -t 0 ]] || die '命令行尚未登录 Cloudflare。请双击部署脚本，在浏览器亲自完成 Wrangler 授权。'
    log '⚠ Wrangler 尚未登录；将打开 Cloudflare 官方授权页，需要你亲自审阅并确认。'
    local reply=""
    IFS= read -r 'reply?直接回车打开登录；任意字符后回车取消：' || die '已取消登录。'
    [[ -z "$reply" ]] || die '已取消登录。'
    run_step '打开 Cloudflare Wrangler 登录' "$WRANGLER" login
    "$WRANGLER" whoami --json > "$WHOAMI_FILE" 2> "${SCRIPT_DIR}/.deploy/auth-error.log" || die '登录后仍无法读取账户信息。'
  fi
  local settings_line="$(node "$HELPER" settings)" || die '无法解析 deploy.settings.json。'
  ACCOUNT_ID="${settings_line%%$'\t'*}"
  local remainder="${settings_line#*$'\t'}"
  WORKER_NAME="${remainder%%$'\t'*}"
  DATABASE_NAME="${remainder#*$'\t'}"
  if [[ -z "$ACCOUNT_ID" ]]; then
    select_account
  fi
  node "$HELPER" assert-account "$ACCOUNT_ID" < "$WHOAMI_FILE" || die '当前授权与部署账户不匹配。'
  node "$HELPER" config '00000000-0000-0000-0000-000000000000' "$ACCOUNT_ID" || die '无法生成部署配置。'
  log "✔ 目标账户：${ACCOUNT_ID}；Worker：${WORKER_NAME}；D1：${DATABASE_NAME}"
}
# 无预置账户时使用 fzf 精确选择，不回退为隐式首项。
select_account() {
  [[ -t 0 ]] || die '配置未填写 account_id，非交互模式无法选择账户。'
  command -v fzf >/dev/null 2>&1 || die '需要 fzf 选择账户。请安装 fzf，或在 deploy.settings.json 填入 account_id。'
  fzf --version >/dev/null 2>&1 || die 'fzf 无法正常运行，请修复后重试。'
  local entries="$(node "$HELPER" accounts < "$WHOAMI_FILE")" || die '无法读取账户列表。'
  [[ -n "$entries" ]] || die '当前授权未返回可选账户。'
  local chosen=""
  chosen="$(print -r -- "$entries" | fzf --delimiter=$'\t' --with-nth=2 --prompt='Cloudflare 账户 > ' --header='回车确认；Esc 取消部署')" || die '账户选择已取消。'
  [[ -n "$chosen" ]] || die '未选择账户，停止部署。'
  ACCOUNT_ID="${chosen%%$'\t'*}"
}
# 首次接管同名 Worker 时要求显式确认，已有本项目记录可直接更新。
check_worker_ownership() {
  if node "$HELPER" owns-worker >/dev/null 2>&1; then
    return 0
  fi
  local listing="${SCRIPT_DIR}/.deploy/existing-deployments.log"
  if "$WRANGLER" deployments list --name "$WORKER_NAME" --config "$CONFIG_FILE" > "$listing" 2>&1; then
    [[ -t 0 ]] || die '远端已存在同名 Worker，但本目录没有匹配部署记录；请在终端核对后确认接管，避免覆盖其它项目。'
    log "⚠ 远端已存在 ${WORKER_NAME}，本文件夹尚无匹配部署记录。"
    local answer=""
    IFS= read -r 'answer?确认这是本项目并允许更新，请输入 YES；其它输入取消：' || die '已取消。'
    [[ "$answer" == YES ]] || die '未确认接管同名 Worker，停止部署。'
  elif ! /usr/bin/grep -Eq '10007|not found|does not exist|could not be found' "$listing"; then
    sanitize_stream < "$listing" | tee -a "$LOG_FILE"
    die '无法确认 Worker 是否存在，请检查权限和网络后重试。'
  fi
  node "$HELPER" mark-pending || die '无法保存本项目的待完成部署归属记录。'
}
# 精确查找本项目数据库；缺少时只创建指定名称，不操作其它数据库。
prepare_database() {
  local list_file="${SCRIPT_DIR}/.deploy/databases.json"
  "$WRANGLER" d1 list --json --config "$CONFIG_FILE" > "$list_file" 2> "${SCRIPT_DIR}/.deploy/database-error.log" || die '无法查询 D1 数据库。'
  local database_id="$(node "$HELPER" database-id < "$list_file")" || die '无法解析 D1 数据库列表。'
  if [[ -z "$database_id" ]]; then
    log "来源：https://api.cloudflare.com/；目标：账户 ${ACCOUNT_ID} 下的独立 D1 ${DATABASE_NAME}。"
    run_step '创建本项目专属 D1 数据库' "$WRANGLER" d1 create "$DATABASE_NAME" --config "$CONFIG_FILE" --location apac --update-config=false
    "$WRANGLER" d1 list --json --config "$CONFIG_FILE" > "$list_file" 2> "${SCRIPT_DIR}/.deploy/database-error.log" || die '建库后无法重新读取 D1。'
    database_id="$(node "$HELPER" database-id < "$list_file")" || die '建库后无法解析 D1 列表。'
    [[ -n "$database_id" ]] || die '建库后未发现指定数据库，停止发布。'
  fi
  node "$HELPER" config "$database_id" "$ACCOUNT_ID" || die '写入专属数据库配置失败。'
  log "✔ 复用目标 D1：${DATABASE_NAME}（${database_id}）"
}
# 在发布前验证源码，迁移只作用于当前绑定的专属数据库。
validate_and_migrate() {
  run_step '生成本地二维码资源' npm run build:assets
  run_step '运行项目测试' npm test
  run_step '检查 Worker 构建产物' "$WRANGLER" deploy --dry-run --config "$CONFIG_FILE" --outdir "${SCRIPT_DIR}/.build"
  run_step '应用专属 D1 数据库迁移' "$WRANGLER" d1 migrations apply DB --remote --config "$CONFIG_FILE"
}
# 发布指定 Worker，健康检查成功后才记录地址并打开页面。
deploy_and_verify() {
  local deployment_log="${SCRIPT_DIR}/.deploy/deployment.log"
  log "来源：${SCRIPT_DIR}；目标：Cloudflare Workers / ${WORKER_NAME}。"
  node "$HELPER" upload-config || die '无法生成禁止自动域名覆盖的 Worker 上传配置。'
  "$WRANGLER" deploy --config "$UPLOAD_CONFIG" 2>&1 | sanitize_stream | tee "$deployment_log" | tee -a "$LOG_FILE"
  local codes=("${pipestatus[@]}")
  (( codes[1] == 0 && codes[2] == 0 && codes[3] == 0 && codes[4] == 0 )) || die 'Worker 发布失败。'
  node "$HELPER" bind-domain "$HEALTH_PROXY_URL" 2>&1 | sanitize_stream | tee -a "$deployment_log" | tee -a "$LOG_FILE"
  local binding_codes=("${pipestatus[@]}")
  (( binding_codes[1] == 0 && binding_codes[2] == 0 && binding_codes[3] == 0 && binding_codes[4] == 0 )) || die '独立域名绑定失败；未尝试覆盖已有记录。'
  local deployed_url="$(node "$HELPER" url < "$deployment_log")" || die '发布成功，但无法解析访问地址，请查看 Cloudflare 控制台。'
  local health_file="${SCRIPT_DIR}/.deploy/health.json"
  local attempt=1
  local healthy=0
  while (( attempt <= 6 )); do
    if /usr/bin/curl "${HEALTH_CURL_ARGS[@]}" --fail --silent --show-error --connect-timeout 8 --max-time 15 "${deployed_url}/api/health" > "$health_file" 2>/dev/null && node -e 'const x=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(x.ok!==true||x.service!=="JobsDeviceInfo")process.exit(1)' "$health_file"; then
      healthy=1
      break
    fi
    log "⚠ 等待 Worker 生效，健康检查 ${attempt}/6 尚未通过。"
    (( attempt++ ))
    /bin/sleep 2
  done
  (( healthy == 1 )) || die "已发布但健康检查未通过：${deployed_url}；不会写入成功部署记录。"
  local direct_without_proxy="true"
  if [[ "$HEALTH_NETWORK" == system-proxy ]]; then
    local direct_health_file="${SCRIPT_DIR}/.deploy/health-direct.json"
    direct_without_proxy="false"
    if /usr/bin/curl --proxy '' --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 6 "${deployed_url}/api/health" > "$direct_health_file" 2>/dev/null && node -e 'const x=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(x.ok!==true||x.service!=="JobsDeviceInfo")process.exit(1)' "$direct_health_file"; then
      direct_without_proxy="true"
    fi
  fi
  node "$HELPER" save-deployment "$deployed_url" "$HEALTH_NETWORK" "$direct_without_proxy" || die '选定线路检查已通过，但部署记录保存失败。'
  log "✔ Cloudflare 发布完成；选定线路（${HEALTH_NETWORK}）检查成功：${deployed_url}"
  if [[ "$direct_without_proxy" == true ]]; then
    log '✔ 本机不注入显式代理访问成功；此结果仅代表本机，尚未验证手机 4G 或其它网络。'
  else
    log '⚠ 本机不注入显式代理访问失败；代理线路成功不能视为手机 4G 可用。'
  fi
  log '手机网络与真实采集尚待单独验收；部署记录已明确标记 mobileVerified=false。'
  log 'iPhone 请使用 Safari 打开此地址，确认描述文件后回到网页查看；IMEI 不保证系统回传。'
  log "日志：${LOG_FILE}"
  if [[ "${JOBS_DEVICE_NO_OPEN:-0}" != 1 ]]; then
    /usr/bin/open "$deployed_url" || log '⚠ 未能自动打开浏览器，请复制上方地址。'
  fi
}
# 编排说明、验证和部署，保持入口只有高层职责调用。
main() {
  show_script_intro_and_wait "$@" # 展示固定自述并处理只读入口和执行确认。
  initialize_runtime # 确认后才初始化当前进程、日志与路径。
  check_environment # 检查依赖并按需确认本项目安装。
  configure_health_network # 明确 curl 网络方式与代理的进程内边界。
  check_cloudflare_auth # 复用既有授权并验证目标账户。
  check_worker_ownership # 避免首次部署覆盖其它同名服务。
  prepare_database # 精确复用或创建本项目数据库。
  validate_and_migrate # 通过测试与构建后应用专属数据库迁移。
  deploy_and_verify # 发布并验证线上健康状态。
}

main "$@"
