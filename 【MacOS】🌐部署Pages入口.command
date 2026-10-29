#!/bin/zsh
# 脚本自述：
# - 脚本名称：【MacOS】🌐部署Pages入口.command
# - 核心用途：更新已存在的专属 Cloudflare Pages 薄入口，并验证绑定的采集 Worker 健康状态。
# - 影响范围：仅本项目 Pages 构建、指定 Pages 项目和已验证访问地址；不发布 Worker、不迁移 D1。
# - 运行提示：双击后回车执行、任意字符取消；--deploy 需已有匹配归属记录，不自动安装、登录或建项目。

SCRIPT_DIR=""
SCRIPT_BASENAME=""
PAGES_DIR=""
CONFIG_FILE=""
NODE_BIN=""
WRANGLER=""
ACCOUNT_ID=""
PAGES_PROJECT=""
WORKER_SERVICE=""
PUBLIC_URL=""
MODE="interactive"
LOG_FILE=""
RUNTIME_DIR=""
HEALTH_NETWORK="direct"
HEALTH_PROXY_URL=""
HEALTH_CURL_ARGS=()
DIRECT_HEALTHY=0
SELECTED_HEALTHY=0

# 按真实终端能力显示自述，纯文本环境不输出颜色。
intro_line() {
  local role="$1"
  local text="$2"
  local style="0;34"
  [[ "$role" == title ]] && style="1;31"
  if [[ -t 1 && -n "${TERM:-}" && "${TERM:-}" != dumb && -z "${NO_COLOR+x}" ]]; then
    printf '\033[%sm%s\033[0m\n' "$style" "$text"
  else
    print -r -- "$text"
  fi
}
# 在安装、文件写入或远程操作前展示固定说明与执行确认。
show_script_intro_and_wait() {
  local source_path="${ZSH_ARGZERO}"
  SCRIPT_DIR="$(cd "$(dirname -- "$source_path")" && pwd)"
  SCRIPT_BASENAME="${source_path:t:r}"
  PAGES_DIR="${SCRIPT_DIR}/pages"
  CONFIG_FILE="${PAGES_DIR}/wrangler.json"
  WRANGLER="${SCRIPT_DIR}/node_modules/.bin/wrangler"
  intro_line title 'JobsDeviceInfo · 部署 Pages 入口'
  intro_line body '1、仅更新已存在的专属 Pages 入口；先有采集 Worker 后端，本入口不发布 Worker 或迁移数据库。'
  intro_line body '2、从 pages/wrangler.json 与根部署配置核对账户、Pages 项目和 DEVICE_SERVICE，复用现有 Wrangler 授权。'
  intro_line body '3、不安装依赖、不升级、不登录、不创建项目；非交互发布必须已有同账户、项目、服务及完整目录的归属记录。'
  intro_line body '4、健康检查默认不使用显式代理；可仅对检查请求沿用当前系统 HTTPS 代理，并额外报告直连结果。'
  intro_line body '5、验证通过后更新 Pages 部署记录、public-site.json 和文件夹内线上快捷方式；不改原 Worker 部署记录。'
  intro_line body '日志：确认后在系统临时目录新建独立 JobsDevicePages 目录，并显示实际位置。'
  if (( $# > 1 )); then
    print -u2 -- '✖ 仅接受一个入口参数。'
    exit 2
  fi
  case "${1:-}" in
    --help|-h) show_help; exit 0 ;;
    --check) run_readonly_check; exit $? ;;
    --deploy) MODE="authorized" ;;
    '')
      [[ -t 0 ]] || { print -u2 -- '✖ 当前没有交互输入；请双击脚本，或审阅后使用 --deploy。'; exit 1; }
      local answer=""
      IFS= read -r 'answer?直接回车执行；任意字符后回车取消：' || exit 1
      if [[ -n "$answer" ]]; then
        print -r -- '已取消，未执行业务。'
        exit 0
      fi
      ;;
    *) print -u2 -- "✖ 未知参数：$1"; show_help; exit 2 ;;
  esac
}
# 显示参数与进程内网络开关，不启动检查或写入。
show_help() {
  print -r -- '用法：双击，或 zsh "./【MacOS】🌐部署Pages入口.command"'
  print -r -- '--help    本地说明，不写日志、不联网。'
  print -r -- '--check   本地配置、依赖、归属记录检查，不写日志、不联网。'
  print -r -- '--deploy  发布已存在的已确认专属 Pages 项目；非交互模式要求匹配归属记录。'
  print -r -- 'JOBS_DEVICE_HEALTH_NETWORK=direct|system-proxy：仅健康检查 curl 使用，默认 direct。'
  print -r -- 'JOBS_DEVICE_NO_OPEN=1：跳过成功后的浏览器打开。'
  print -r -- '脚本不自动创建项目或授权，不改根 .deployment.json 与 deploy.settings.json。'
}
# 只读检查所需 Node/npm 与精确版本依赖，不调用安装或认证。
check_local_dependencies() {
  NODE_BIN="$(command -v node 2>/dev/null)"
  [[ -z "$NODE_BIN" && -x /opt/homebrew/bin/node ]] && NODE_BIN=/opt/homebrew/bin/node
  [[ -z "$NODE_BIN" && -x /usr/local/bin/node ]] && NODE_BIN=/usr/local/bin/node
  [[ -n "$NODE_BIN" ]] || { print -u2 -- '✖ 请先安装 Node.js 22.13+：https://nodejs.org/'; return 1; }
  NODE_DISABLE_COMPILE_CACHE=1 "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))process.exit(1);console.log("Node.js: "+process.version)' || return 1
  local npm_bin="$(command -v npm 2>/dev/null)"
  [[ -z "$npm_bin" && -x "${NODE_BIN:h}/npm" ]] && npm_bin="${NODE_BIN:h}/npm"
  [[ -n "$npm_bin" ]] || { print -u2 -- '✖ 缺少 npm，请先修复 Node.js 官方安装。'; return 1; }
  NODE_DISABLE_COMPILE_CACHE=1 "$NODE_BIN" "$npm_bin" --version || return 1
  NODE_DISABLE_COMPILE_CACHE=1 "$NODE_BIN" --input-type=module - "$SCRIPT_DIR" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version !== version) throw new Error(`依赖 ${name} 不完整或版本不一致。`);
  }
  for (const name of ['pages/worker.js', 'pages/wrangler.json', 'scripts/build-pages.mjs']) {
    const info = fs.lstatSync(path.join(root, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`必须是项目内独立普通文件：${name}`);
  }
  console.log('✔ 本地直接依赖与 Pages 源文件检查通过；未执行安装。');
} catch (error) {
  console.error(`✖ ${error.message} 请先完成原项目依赖准备，再运行本入口。`);
  process.exitCode = 1;
}
NODE
}
# 从 Pages 专用配置与根设置核对唯一的实际部署目标。
load_target_config() {
  local target_line=""
  target_line="$(NODE_DISABLE_COMPILE_CACHE=1 "$NODE_BIN" --input-type=module - "$SCRIPT_DIR" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
try {
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'deploy.settings.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'pages', 'wrangler.json'), 'utf8'));
  const services = (config.services || []).filter((entry) => entry.binding === 'DEVICE_SERVICE');
  if (!/^[a-f0-9]{32}$/i.test(settings.account_id || '')) throw new Error('根设置缺少有效 account_id。');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name || '')) throw new Error('Pages 项目名无效。');
  if (services.length !== 1 || services[0].service !== settings.worker_name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(settings.worker_name || '')) throw new Error('DEVICE_SERVICE 与根设置的 Worker 不一致。');
  if (config.account_id) throw new Error('Pages 配置不接受 account_id，请使用根设置。');
  if (path.resolve(root, 'pages', config.pages_build_output_dir || '') !== path.join(root, '.pages-build')) throw new Error('Pages 输出目录必须精确为本项目 .pages-build。');
  console.log([settings.account_id, config.name, services[0].service].join('\t'));
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exitCode = 1;
}
NODE
)" || return 1
  ACCOUNT_ID="${target_line%%$'\t'*}"
  local remaining="${target_line#*$'\t'}"
  PAGES_PROJECT="${remaining%%$'\t'*}"
  WORKER_SERVICE="${remaining#*$'\t'}"
  PUBLIC_URL="https://${PAGES_PROJECT}.pages.dev"
  print -r -- "目标账户：${ACCOUNT_ID}；Pages：${PAGES_PROJECT}；后端：${WORKER_SERVICE}"
}
# 仅凭匹配账户、项目、服务和项目真实路径确认已有部署归属。
owner_record_matches() {
  NODE_DISABLE_COMPILE_CACHE=1 "$NODE_BIN" --input-type=module - "$SCRIPT_DIR" "$ACCOUNT_ID" "$PAGES_PROJECT" "$WORKER_SERVICE" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [root, account, project, worker] = process.argv.slice(2);
try {
  const file = path.join(root, '.pages-deployment.json');
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) process.exit(1);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.account_id !== account || record.pages_project !== project || record.worker !== worker || record.project_dir !== fs.realpathSync(root)) process.exit(1);
} catch {
  process.exitCode = 1;
}
NODE
}
# 执行完全本地的配置、依赖和归属检查，缺记录仅提示不发布。
run_readonly_check() {
  check_local_dependencies || return 1
  load_target_config || return 1
  if owner_record_matches; then
    print -r -- '✔ Pages 部署归属记录与当前目标及目录一致。'
  else
    print -r -- '⚠ 尚无匹配 Pages 部署归属记录；非交互发布会停止，交互接管须核对后输入 YES。'
  fi
  print -r -- '✔ 本地只读检查完成；未检查远端项目、授权或实际可达性。'
}
# 确认后创建私有运行目录并初始化纯文本日志，不更改代理。
initialize_runtime() {
  setopt NO_NOMATCH PIPE_FAIL
  export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
  export NO_COLOR=1 FORCE_COLOR=0 CLICOLOR=0 WRANGLER_SEND_METRICS=false
  umask 077
  local temp_parent="${TMPDIR:-/tmp}"
  RUNTIME_DIR="$(/usr/bin/mktemp -d "${temp_parent%/}/JobsDevicePages.XXXXXXXX")" || { print -u2 -- '✖ 无法创建独立临时目录。'; exit 1; }
  LOG_FILE="${RUNTIME_DIR}/${SCRIPT_BASENAME}.log"
  : > "$LOG_FILE" || exit 1
  trap cleanup_health_files EXIT
  cd "$SCRIPT_DIR" || exit 1
  log "日志：${LOG_FILE}"
}
# 删除本脚本自己生成的健康响应临时文件，保留脱敏日志。
cleanup_health_files() {
  if [[ -n "$RUNTIME_DIR" && -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" ]]; then
    /bin/rm -f -- "${RUNTIME_DIR}/health-selected.json" "${RUNTIME_DIR}/health-direct.json"
  fi
}
# 同步输出简明状态并保留纯文本日志。
log() {
  print -r -- "$1" | tee -a "$LOG_FILE"
}
# 报告失败并停止，保留先前成功的部署记录。
die() {
  log "✖ $1"
  log "日志：${LOG_FILE}"
  exit 1
}
# 移除终端颜色、认证字段和 URL 中的随机采集凭据。
sanitize_stream() {
  /usr/bin/perl -pe 's/\e\[[0-9;?]*[ -\/]*[\@-~]//g; s/((?:Bearer|oauth_token|api_token|access_token|refresh_token|CLOUDFLARE_API_TOKEN)[\s:="]+)[^\s",;]+/${1}[REDACTED]/ig; s/\b(Authorization|Set-Cookie|Cookie):[^\r\n]*/${1}: [REDACTED]/ig; s#(https?://)[^/\s@]+:[^/\s@]+\@#${1}[REDACTED]\@#g; s#(/api/profile/)[A-Za-z0-9_-]+#${1}[REDACTED]#g; s#([\#?&](?:pair|token|challenge)=)[^&\s]+#${1}[REDACTED]#ig'
}
# 执行单个构建或发布步骤，并核对整个日志管道的退出状态。
run_logged() {
  local label="$1"
  shift
  log "➤ ${label}"
  "$@" 2>&1 | sanitize_stream | tee -a "$LOG_FILE"
  local results=("${pipestatus[@]}")
  (( results[1] == 0 && results[2] == 0 && results[3] == 0 )) || die "步骤失败：${label}"
}
# 在正式运行中检查健康依赖，不执行安装、升级或登录。
check_environment() {
  check_local_dependencies || die '本地依赖不可用，未进行任何远程发布。'
  load_target_config || die 'Pages 专用配置检查失败。'
  [[ -x "$WRANGLER" ]] || die '项目内 Wrangler 入口不可执行，请先修复项目依赖。'
}
# 发布前核对归属；缺少记录时仅允许终端精确确认采纳。
confirm_project_ownership() {
  if owner_record_matches; then
    log '✔ Pages 项目与账户、Worker 服务及项目完整目录匹配。'
    return 0
  fi
  [[ -t 0 ]] || die '缺少匹配的 .pages-deployment.json，非交互模式不发布；请先在终端审阅目标并确认归属。'
  log "⚠ 现有 Pages 归属记录未匹配。待更新：${ACCOUNT_ID} / ${PAGES_PROJECT}；后端：${WORKER_SERVICE}。"
  local answer=""
  IFS= read -r 'answer?确认这是本项目专属 Pages 入口，请输入 YES；其它输入取消：' || die '已取消 Pages 接管。'
  [[ "$answer" == YES ]] || die '未确认 Pages 项目归属，不发布。'
}
# 每条 Wrangler 命令只在其进程内明确账户和 Pages 工作目录。
wrangler_pages() {
  WRANGLER_ACCOUNT_ID="$ACCOUNT_ID" "$WRANGLER" --cwd "$PAGES_DIR" "$@"
}
# 复用现有授权并精确核对远端项目存在，不创建项目或新授权。
check_remote_target() {
  local auth_json=""
  auth_json="$(wrangler_pages whoami --json 2> >(sanitize_stream >> "$LOG_FILE"))" || die 'Wrangler 未登录或现有授权不可用；请先自行完成原项目授权，本入口不登录。'
  print -r -- "$auth_json" | NODE_DISABLE_COMPILE_CACHE=1 "$NODE_BIN" -e 'try{const v=JSON.parse(require("node:fs").readFileSync(0,"utf8"));if(!(v.accounts||v.user?.accounts||[]).some(x=>x.id===process.argv[1]))process.exit(1)}catch{process.exit(1)}' "$ACCOUNT_ID" || die '现有 Wrangler 授权不包含指定账户。'
  local projects_json=""
  projects_json="$(wrangler_pages pages project list --json 2> >(sanitize_stream >> "$LOG_FILE"))" || die '无法核对远端 Pages 项目；不会尝试创建或转发至其它产品。'
  print -r -- "$projects_json" | NODE_DISABLE_COMPILE_CACHE=1 "$NODE_BIN" -e 'try{const value=JSON.parse(require("node:fs").readFileSync(0,"utf8"));const rows=Array.isArray(value)?value:value.result;const found=rows.filter(x=>(x.name||x["Project Name"])===process.argv[1]);if(found.length!==1)process.exit(1);const names=found[0].domains||(found[0]["Project Domains"]||"").split(",").map(x=>x.trim());if(!names.includes(process.argv[1]+".pages.dev"))process.exit(1)}catch{process.exit(1)}' "$PAGES_PROJECT" || die '指定 Pages 项目或默认域名不存在，停止；本入口不自动创建项目。'
  log "✔ 已存在的专属 Pages 项目核对通过：${PAGES_PROJECT}"
}
# 动态读取已启用的系统静态 HTTPS 代理，不输出无关网络状态。
read_system_https_proxy() {
  local proxy_state="$(/usr/sbin/scutil --proxy 2>/dev/null)" || return 1
  local enabled="$(print -r -- "$proxy_state" | /usr/bin/awk '$1 == "HTTPSEnable" {print $3; exit}')"
  local proxy_host="$(print -r -- "$proxy_state" | /usr/bin/awk '$1 == "HTTPSProxy" {print $3; exit}')"
  local proxy_port="$(print -r -- "$proxy_state" | /usr/bin/awk '$1 == "HTTPSPort" {print $3; exit}')"
  local host_pattern='^([A-Za-z0-9.-]+|[a-fA-F0-9:]+|\[[a-fA-F0-9:]+\])$'
  local port_pattern='^[0-9]{1,5}$'
  [[ "$enabled" == 1 && "$proxy_host" =~ "$host_pattern" && "$proxy_port" =~ "$port_pattern" ]] || return 1
  (( 10#$proxy_port >= 1 && 10#$proxy_port <= 65535 )) || return 1
  if [[ "$proxy_host" == *:* && "$proxy_host" != \[*\] ]]; then
    proxy_host="[${proxy_host}]"
  fi
  print -r -- "http://${proxy_host}:${proxy_port}"
}
# 网络选择仅作用于健康检查单条 curl，默认明确禁用显式代理。
configure_health_network() {
  HEALTH_NETWORK="${JOBS_DEVICE_HEALTH_NETWORK:-direct}"
  case "$HEALTH_NETWORK" in
    direct)
      HEALTH_CURL_ARGS=(--proxy '' --noproxy '*')
      log 'ℹ API 健康检查使用直连：不注入显式代理，保留现有底层系统路由。'
      ;;
    system-proxy)
      HEALTH_PROXY_URL="$(read_system_https_proxy)" || die '没有启用有效静态 HTTPS 系统代理；不会猜测端口、启用代理或改选线路。'
      HEALTH_CURL_ARGS=(--proxy "$HEALTH_PROXY_URL" --noproxy '')
      log '⚠ 本次健康检查沿用当前系统代理，可能改变请求路径并受代理连接状态影响。'
      log "代理地址：${HEALTH_PROXY_URL}；仅传给当前健康检查 curl，不接收或记录代理凭据。"
      log '恢复：curl 结束即停止本次显式代理；系统、用户和全局环境均不修改。下次使用 direct 即不注入。'
      log '代理模式还会额外进行一次短时直连检查，并分别记录结果；代理可达不代表手机可达。'
      ;;
    *) die 'JOBS_DEVICE_HEALTH_NETWORK 仅允许 direct 或 system-proxy。' ;;
  esac
}
# 构建单独 Pages 目录，并验证标记文件以禁止意外产品转发。
build_pages_entry() {
  log "来源：${SCRIPT_DIR}/pages 与 public；目标：${SCRIPT_DIR}/.pages-build；不构建或发布采集 Worker。"
  run_logged '构建 Pages 薄入口' "$NODE_BIN" "${SCRIPT_DIR}/scripts/build-pages.mjs"
  NODE_DISABLE_COMPILE_CACHE=1 "$NODE_BIN" --input-type=module - "$SCRIPT_DIR" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const output = path.join(process.argv[2], '.pages-build');
try {
  const info = fs.lstatSync(output);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
  for (const name of ['_worker.js', '_routes.json']) {
    const entry = fs.lstatSync(path.join(output, name));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error();
  }
  const routes = JSON.parse(fs.readFileSync(path.join(output, '_routes.json'), 'utf8'));
  if (routes.version !== 1 || !routes.include?.includes('/*')) throw new Error();
} catch {
  console.error('✖ Pages 专用 Worker / 路由标记无效，停止发布以避免产品转发。');
  process.exitCode = 1;
}
NODE
  (( $? == 0 )) || die 'Pages 输出未通过安全检查。'
}
# 仅部署指定 Pages 项目的 main 分支，不创建项目或操作原 Worker。
deploy_pages_entry() {
  log "来源：${SCRIPT_DIR}/.pages-build；目标：Cloudflare Pages / ${PAGES_PROJECT} / main。"
  run_logged '更新已存在的 Pages 入口' wrangler_pages pages deploy "${SCRIPT_DIR}/.pages-build" --project-name "$PAGES_PROJECT" --branch main
}
# 只判定 API 健康 JSON，不显示原始响应、Cookie 或令牌。
health_json_valid() {
  NODE_DISABLE_COMPILE_CACHE=1 "$NODE_BIN" -e 'try{const v=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(v.ok!==true||v.service!=="JobsDeviceInfo"||v.database!==true)process.exit(1)}catch{process.exit(1)}' "$1"
}
# 分别验证所选网络与额外直连，失败时不伪造成功元数据。
verify_pages_health() {
  local attempt=1
  local selected_file="${RUNTIME_DIR}/health-selected.json"
  while (( attempt <= 6 )); do
    if /usr/bin/curl "${HEALTH_CURL_ARGS[@]}" --silent --fail --connect-timeout 5 --max-time 12 "${PUBLIC_URL}/api/health" > "$selected_file" 2>/dev/null && health_json_valid "$selected_file"; then
      SELECTED_HEALTHY=1
      break
    fi
    log "⚠ 所选网络 ${HEALTH_NETWORK} 的 API 健康检查 ${attempt}/6 未通过。"
    (( attempt++ ))
    /bin/sleep 2
  done
  if [[ "$HEALTH_NETWORK" == system-proxy ]]; then
    if /usr/bin/curl --proxy '' --noproxy '*' --silent --fail --connect-timeout 3 --max-time 7 "${PUBLIC_URL}/api/health" > "${RUNTIME_DIR}/health-direct.json" 2>/dev/null && health_json_valid "${RUNTIME_DIR}/health-direct.json"; then
      DIRECT_HEALTHY=1
      log '✔ 额外直连健康检查通过；此结果与代理检查分别记录。'
    else
      log '⚠ 额外短时直连健康检查未通过；不会把代理成功标成直连成功。'
    fi
  else
    DIRECT_HEALTHY="$SELECTED_HEALTHY"
  fi
  (( SELECTED_HEALTHY == 1 )) || die 'Pages 已尝试发布，但所选网络的 API 健康 JSON 未通过；保留旧部署记录，不更新入口地址。'
  log "✔ 所选网络 ${HEALTH_NETWORK} 的 API 服务与数据库健康检查通过。"
  log '健康检查不代表手机真实 UDID / IMEI 回传验收，本次不会写入真机采集已通过。'
}
# 健康通过后仅更新 Pages 专属记录、公开根站地址和文件夹内快捷方式。
save_pages_result() {
  NODE_DISABLE_COMPILE_CACHE=1 "$NODE_BIN" --input-type=module - "$SCRIPT_DIR" "$ACCOUNT_ID" "$PAGES_PROJECT" "$WORKER_SERVICE" "$PUBLIC_URL" "$HEALTH_NETWORK" "$DIRECT_HEALTHY" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [root, account, project, worker, url, network, direct] = process.argv.slice(2);
const recordFile = path.join(root, '.pages-deployment.json');
const publicFile = path.join(root, 'public', 'public-site.json');
const shortcutFile = path.join(root, '打开线上采集站.webloc');
const files = [recordFile, publicFile, shortcutFile];
try {
  for (const file of files) {
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('结果文件不是独立普通文件。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const record = {
    ...previous,
    pages_project: project, account_id: account, worker, project_dir: fs.realpathSync(root), url,
    deployed_at: new Date().toISOString(),
    validation: { ...(previous.validation || {}), apiHealthy: true, databaseHealthy: true, selectedNetwork: network, selectedNetworkHealthy: true, directHealthy: direct === '1', mobileVerified: false },
  };
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, { flag: flags, mode: 0o600 });
  fs.writeFileSync(publicFile, `${JSON.stringify({ url }, null, 2)}\n`, { flag: flags, mode: 0o644 });
  const escaped = url.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  fs.writeFileSync(shortcutFile, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>${escaped}</string></dict></plist>\n`, { flag: flags, mode: 0o644 });
} catch {
  console.error('✖ Pages 健康检查已通过，但本地结果文件无法安全保存；请核对文件类型与权限。');
  process.exitCode = 1;
}
NODE
  (( $? == 0 )) || die '本地 Pages 结果保存失败，未修改原 Worker 配置。'
  log "✔ Pages 入口已验证：${PUBLIC_URL}"
  log '已更新 .pages-deployment.json、public/public-site.json 和打开线上采集站.webloc；原 Worker 记录保持。'
}
# 成功后按用户进程开关决定是否打开浏览器。
open_verified_site() {
  if [[ "${JOBS_DEVICE_NO_OPEN:-0}" != 1 ]]; then
    /usr/bin/open "$PUBLIC_URL" || log '⚠ 无法自动打开浏览器，请使用上方地址。'
  fi
  log "日志：${LOG_FILE}"
}
# 依次完成说明、归属核对、Pages 单独发布与健康验证。
main() {
  show_script_intro_and_wait "$@" # 先展示固定自述并处理只读入口与执行确认。
  initialize_runtime # 确认后创建独立日志和临时响应目录。
  check_environment # 检查本地健康依赖与 Pages 配置，不安装或升级。
  confirm_project_ownership # 核对完整归属，缺记录时要求终端精确确认。
  check_remote_target # 复用现有授权并确认指定 Pages 项目已存在。
  configure_health_network # 明确单条健康请求的网络模式与恢复边界。
  build_pages_entry # 只构建 Pages 薄入口及产品标记文件。
  deploy_pages_entry # 仅更新指定 Pages 项目，不发布原采集 Worker。
  verify_pages_health # 验证 API 与数据库，分别记录代理和直连结果。
  save_pages_result # 健康通过后保存 Pages 专属地址与快捷方式。
  open_verified_site # 按开关打开已验证网址并交付日志位置。
}

main "$@"
