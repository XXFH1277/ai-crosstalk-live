#!/bin/bash
# Apple Silicon local bootstrap. Compatible with the system Bash 3.2.
set -euo pipefail

MODE=deploy
BACKENDS=both
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-only) MODE=check ;;
    --prepare-only) MODE=prepare ;;
    --cpu-only) BACKENDS=cpu ;;
    *) printf 'Usage: /bin/bash deploy-mac.sh [--check-only|--prepare-only] [--cpu-only]\n' >&2; exit 2 ;;
  esac
  shift
done

fail() { printf '\n错误：%s\n' "$*" >&2; exit 1; }
info() { printf '\n%s\n' "$*"; }

if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  fail '此部署包只能在 Apple Silicon Mac 上运行。请把完整目录复制到 Mac 后双击“一键部署.command”。'
fi
ROOT=$(CDPATH= cd -- "$(/usr/bin/dirname "$0")" && pwd -P)
cd "$ROOT"
if [ "$(/usr/bin/uname -m)" != arm64 ] || [ "$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  fail '请用原生 Apple Silicon 终端运行。关闭终端的“使用 Rosetta 打开”，再重新部署；本包不支持 Intel Mac。'
fi
OS_VERSION=$(/usr/bin/sw_vers -productVersion)
OS_MAJOR=${OS_VERSION%%.*}
case "$OS_MAJOR" in ''|*[!0-9]*) fail '无法读取 macOS 版本。' ;; esac
[ "$OS_MAJOR" -ge 14 ] || fail '本测试包以 macOS 14 或更新版本为目标。'
[ -w "$ROOT" ] || fail '当前目录不可写，请完整解压到自己的用户文件夹，不要在压缩包或只读磁盘内运行。'
/bin/mkdir -p "$ROOT/logs" "$ROOT/runtime" "$ROOT/build" "$ROOT/outputs"
STAMP=$(/bin/date '+%Y%m%d-%H%M%S')-$$
LOG="$ROOT/logs/deploy-$STAMP.log"
exec > >(/usr/bin/tee -a "$LOG") 2>&1
trap 'status=$?; if [ "$status" -ne 0 ]; then printf "\n部署未完成（退出码 %s）。日志：%s\n" "$status" "$LOG"; fi' EXIT

info "Breeze TTS 2 · Apple Silicon 部署检查（macOS $OS_VERSION）"
printf '目录：%s\n' "$ROOT"
printf '日志：%s\n' "$LOG"
info '1/5 核对离线依赖安装包 SHA256'
[ -f "$ROOT/installers/bootstrap.sha256" ] || fail '缺少 installers/bootstrap.sha256，请完整解压。'
/usr/bin/shasum -a 256 -c "$ROOT/installers/bootstrap.sha256" || fail '离线依赖包校验失败，请重新复制完整压缩包。'

PY_ARCHIVE="$ROOT/installers/python-aarch64-apple-darwin-install_only.tar.gz"
CMAKE_ARCHIVE="$ROOT/installers/cmake-macos-universal.tar.gz"
PYTHON="$ROOT/runtime/python/bin/python3"
CMAKE="$ROOT/runtime/cmake/CMake.app/Contents/bin/cmake"

extract_dependency() {
  archive=$1
  destination=$2
  executable=$3
  digest=$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')
  previous=''
  if [ -f "$destination/.archive-sha256" ]; then previous=$(/bin/cat "$destination/.archive-sha256"); fi
  if [ "$previous" = "$digest" ] && [ -x "$executable" ]; then
    printf '复用：%s\n' "$destination"
    return 0
  fi
  /bin/mkdir -p "$destination"
  # Extract on macOS so original executable bits and relative symlinks survive.
  /usr/bin/tar -xzf "$archive" -C "$destination" --strip-components=1
  [ -x "$executable" ] || fail "解压后没有可执行入口：$executable"
  printf '%s\n' "$digest" > "$destination/.archive-sha256"
}

info '2/5 准备包内 Python 与 CMake（不使用 Homebrew，不改系统 PATH）'
extract_dependency "$PY_ARCHIVE" "$ROOT/runtime/python" "$PYTHON"
extract_dependency "$CMAKE_ARCHIVE" "$ROOT/runtime/cmake" "$CMAKE"
"$PYTHON" -I -c 'import platform, ssl, ctypes, http.server; assert platform.system() == "Darwin" and platform.machine() == "arm64", "Python must run as native Apple Silicon"; print("Python", platform.python_version(), "arm64 OK")'
"$CMAKE" --version

info '3/5 核对应用、源码与模型文件'
"$PYTHON" -I "$ROOT/check_package.py"
"$PYTHON" -I - "$ROOT" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1]).resolve()
catalog = json.loads((root / 'installers/dependencies.json').read_text(encoding='utf-8-sig'))
for item in catalog['dependencies']:
    path = (root / item['path']).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise SystemExit('Invalid dependency path: ' + item['path'])
    digest = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
    if digest.lower() != item['sha256'].lower():
        raise SystemExit('Dependency SHA256 mismatch: ' + item['path'])
print('Dependency catalog OK')
PY

# Restore original source symlinks on macOS. The Windows staging tree carries
# normal source files; pinned archives preserve Unix metadata without a Git clone.
"$PYTHON" -I - "$ROOT" <<'PY'
import posixpath, sys, tarfile
from pathlib import Path
root = Path(sys.argv[1])
archives = ('breeze-source-v0.1.3.tar.gz', 'ggml-source-36da571.tar.gz', 'shine-source-ab5e352.tar.gz')
for name in archives:
    with tarfile.open(root / 'installers' / name, 'r:gz') as archive:
        prefix = None
        for member in archive.getmembers():
            parts = member.name.split('/')
            if member.name.startswith('/') or '..' in parts:
                raise SystemExit('Unsafe source archive path: ' + member.name)
            if prefix is None:
                prefix = parts[0]
            if parts[0] != prefix:
                raise SystemExit('Unexpected archive root: ' + member.name)
            relative = '/'.join(parts[1:]).rstrip('/')
            if member.issym():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(relative), member.linkname))
                if member.linkname.startswith('/') or target == '..' or target.startswith('../'):
                    raise SystemExit('Unsafe source symlink: ' + member.name)
            elif member.islnk():
                linkparts = member.linkname.split('/')
                if member.linkname.startswith('/') or '..' in linkparts or linkparts[0] != prefix:
                    raise SystemExit('Unsafe source hardlink: ' + member.name)
            elif not (member.isfile() or member.isdir()):
                raise SystemExit('Unexpected source archive entry: ' + member.name)
    print('Source archive paths OK:', name)
PY
if [ "$MODE" != check ]; then
  /bin/mkdir -p "$ROOT/source/Breeze-TTS-2.cpp/third_party/ggml" "$ROOT/source/Breeze-TTS-2.cpp/third_party/shine"
  /usr/bin/tar -xzf "$ROOT/installers/breeze-source-v0.1.3.tar.gz" -C "$ROOT/source/Breeze-TTS-2.cpp" --strip-components=1
  /usr/bin/tar -xzf "$ROOT/installers/ggml-source-36da571.tar.gz" -C "$ROOT/source/Breeze-TTS-2.cpp/third_party/ggml" --strip-components=1
  /usr/bin/tar -xzf "$ROOT/installers/shine-source-ab5e352.tar.gz" -C "$ROOT/source/Breeze-TTS-2.cpp/third_party/shine" --strip-components=1
fi

info '4/5 检查 Apple 编译工具与 macOS SDK'
TOOLS_READY=1
if ! /usr/bin/xcrun --find clang >/dev/null 2>&1; then TOOLS_READY=0; fi
if ! /usr/bin/xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1; then TOOLS_READY=0; fi
if [ "$TOOLS_READY" != 1 ]; then
  printf '\n缺少 Apple Xcode Command Line Tools 或有效的 macOS SDK。\n'
  printf '这是本包唯一不能随包提供的 Apple 开发组件，需要你在 Mac 上安装。\n'
  printf '请在“终端”运行：xcode-select --install\n'
  printf '在系统窗口完成安装后，重新双击“一键部署.command”。\n'
  printf '若已安装完整 Xcode，请打开一次 Xcode 完成其首次配置，然后重试。\n'
  if [ "$MODE" != check ]; then
    printf '正在请求 Apple 官方安装窗口；请在系统窗口中自行完成安装。\n'
    /usr/bin/xcode-select --install || true
  fi
  "$PYTHON" -I "$ROOT/mac_runtime.py" diagnose || true
  exit 3
fi
CLANG=$(/usr/bin/xcrun --find clang)
CLANGXX=$(/usr/bin/xcrun --find clang++)
SDK=$(/usr/bin/xcrun --sdk macosx --show-sdk-path)
"$CLANG" --version
printf 'SDK：%s\n' "$SDK"
if [ "$MODE" = check ]; then
  "$PYTHON" -I "$ROOT/mac_runtime.py" diagnose
  info '环境和文件检查完成。此入口没有编译或启动语音模型。'
  exit 0
fi

info '5/5 编译本机原生 Metal 与 CPU 运行程序'
SOURCE="$ROOT/source/Breeze-TTS-2.cpp"
[ -f "$SOURCE/third_party/ggml/CMakeLists.txt" ] || fail '缺少 ggml 源码，请完整解压。'
[ -f "$SOURCE/third_party/shine/src/lib/layer3.c" ] || fail '缺少 shine 源码，请完整解压。'
CPUS=$(/usr/sbin/sysctl -n hw.ncpu)
case "$CPUS" in ''|*[!0-9]*) CPUS=4 ;; esac
if [ "$CPUS" -gt 8 ]; then CPUS=8; fi
export MACOSX_DEPLOYMENT_TARGET=14.0

build_backend() {
  backend=$1
  use_metal=$2
  fingerprint=$( { printf '%s\n' "$ROOT" "$backend" "$SDK" "$MACOSX_DEPLOYMENT_TARGET"; /usr/bin/shasum -a 256 "$ROOT/deploy-mac.sh" "$ROOT/installers/dependencies.json"; "$CLANG" --version; } | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')
  output="$ROOT/runtime/breeze-$backend"
  binary="$output/breeze-server"
  record="$output/build-stamp.txt"
  if [ -f "$record" ] && [ -x "$binary" ]; then
    old_fingerprint=$(/usr/bin/sed -n '1p' "$record")
    old_sha=$(/usr/bin/sed -n '2p' "$record")
    current_sha=$(/usr/bin/shasum -a 256 "$binary" | /usr/bin/awk '{print $1}')
    if [ "$old_fingerprint" = "$fingerprint" ] && [ "$old_sha" = "$current_sha" ]; then
      printf '复用已编译的 %s：%s\n' "$backend" "$binary"
      return 0
    fi
  fi
  build="$ROOT/build/$backend-${fingerprint:0:12}"
  /bin/mkdir -p "$build" "$output" || return 1
  printf '\n编译 %s（首次需要等待几分钟）……\n' "$backend"
  "$CMAKE" -S "$SOURCE" -B "$build" -G 'Unix Makefiles' \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER="$CLANG" -DCMAKE_CXX_COMPILER="$CLANGXX" \
    -DCMAKE_OSX_SYSROOT="$SDK" -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 \
    -DCMAKE_RUNTIME_OUTPUT_DIRECTORY="$build/bin" \
    -DBUILD_SHARED_LIBS=OFF -DGGML_BACKEND_DL=OFF \
    -DBREEZE_BUILD_SHARED=OFF -DBREEZE_BUILD_CLI=OFF -DBREEZE_BUILD_SERVER=ON \
    -DBREEZE_BUILD_TESTS=OFF -DBREEZE_MP3=ON \
    -DBREEZE_VULKAN=OFF -DBREEZE_CUDA=OFF \
    -DGGML_METAL="$use_metal" -DGGML_METAL_EMBED_LIBRARY=ON \
    -DGGML_ACCELERATE=ON -DGGML_NATIVE=ON -DGGML_OPENMP=OFF || return 1
  "$CMAKE" --build "$build" --target breeze-server --parallel "$CPUS" || return 1
  built="$build/bin/breeze-server"
  [ -x "$built" ] || { printf '找不到构建产物：%s\n' "$built"; return 1; }
  /usr/bin/lipo -archs "$built" | /usr/bin/grep -qw arm64 || { printf '编译产物不是 arm64。\n'; return 1; }
  # Static ggml/shine plus embedded Metal source leaves only macOS system libraries.
  links=$(/usr/bin/otool -L "$built") || return 1
  printf '%s\n' "$links"
  if printf '%s\n' "$links" | /usr/bin/sed '1d' | /usr/bin/awk '{print $1}' | /usr/bin/grep -Ev '^(/usr/lib/|/System/Library/|$)' >/dev/null; then
    printf '发现非系统动态库依赖，保留构建日志并停止安装该后端。\n'
    return 1
  fi
  /bin/cp "$built" "$output/breeze-server.new" || return 1
  /bin/chmod u+x "$output/breeze-server.new" || return 1
  /bin/mv -f "$output/breeze-server.new" "$binary" || return 1
  binary_sha=$(/usr/bin/shasum -a 256 "$binary" | /usr/bin/awk '{print $1}') || return 1
  printf '%s\n%s\n' "$fingerprint" "$binary_sha" > "$record" || return 1
  printf '%s 已编译：%s\n' "$backend" "$binary"
}

METAL_READY=0
CPU_READY=0
if build_backend cpu OFF; then CPU_READY=1; else printf '\nCPU 备用版本编译失败，详情见本次部署日志。\n'; fi
if [ "$BACKENDS" = both ]; then
  if build_backend metal ON; then METAL_READY=1; else printf '\nMetal 编译失败；CPU 备用版本的结果独立保留，详情见本次部署日志。\n'; fi
fi
[ "$METAL_READY" = 1 ] || [ "$CPU_READY" = 1 ] || fail '两种运行程序均未完成编译。请保留日志用于排查。'
"$PYTHON" -I "$ROOT/mac_runtime.py" diagnose || true
if [ "$MODE" = prepare ]; then
  info '编译准备完成，尚未启动模型。'
  exit 0
fi
if [ "$METAL_READY" = 1 ]; then
  info '开始加载 Q8 模型，尝试 Metal。首轮运行需要验证，成功后会自动打开中文网页。'
  "$PYTHON" -I "$ROOT/mac_runtime.py" start --model Q8 --backend metal || fail 'Metal 启动未成功。请保留 logs；如果 CPU 备用版已编译，可双击 Start-CPU.command 继续测试。'
else
  info '本次使用已编译的 CPU 版本加载 Q8。CPU 生成可能明显较慢。'
  "$PYTHON" -I "$ROOT/mac_runtime.py" start --model Q8 --backend cpu
fi
info '启动完成。建议双击 Self-Test.command，验证两个模型、保存声音和双向切换。'
