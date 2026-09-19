#!/usr/bin/env bash
# ============================================================
# build.sh — 编译 pi-bridge 为单二进制，macOS 下 ad-hoc 签名。
#
# 产物：dist/pi-bridge-<rust-triple>[.exe]
#   macOS ARM   -> dist/pi-bridge-aarch64-apple-darwin
#   macOS Intel -> dist/pi-bridge-x86_64-apple-darwin
#   Linux x64   -> dist/pi-bridge-x86_64-unknown-linux-gnu
#   Windows x64 -> dist/pi-bridge-x86_64-pc-windows-msvc.exe
#
# 用法：
#   bash build.sh                     # 编译宿主平台
#   bun run build                     # 同上
#
# 环境变量覆盖（跨平台编译时用）：
#   PI_BRIDGE_TARGET   bun --target，如 bun-darwin-arm64
#   PI_BRIDGE_TRIPLE   rust target triple，如 aarch64-apple-darwin
#
# 消费方（如 slate）拿产物：
#   把 dist/pi-bridge-<triple> 拷到 Tauri 的 src-tauri/binaries/ 即可。
#   macOS 下若宿主 app 开了 hardenedRuntime，需用宿主自己的 entitlements
#   重新签名——本脚本签名仅为「独立运行」场景。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
ENTITLEMENTS="$ROOT/Entitlements.plist"

# ---- target 检测（默认宿主平台）----
TARGET="${PI_BRIDGE_TARGET:-}"
TRIPLE="${PI_BRIDGE_TRIPLE:-}"
if [ -z "$TARGET" ] || [ -z "$TRIPLE" ]; then
  OS=$(uname -s); ARCH=$(uname -m)
  case "$OS-$ARCH" in
    Darwin-arm64)  TARGET=${TARGET:-bun-darwin-arm64};  TRIPLE=${TRIPLE:-aarch64-apple-darwin};;
    Darwin-x86_64) TARGET=${TARGET:-bun-darwin-x64};    TRIPLE=${TRIPLE:-x86_64-apple-darwin};;
    Linux-x86_64)  TARGET=${TARGET:-bun-linux-x64};     TRIPLE=${TRIPLE:-x86_64-unknown-linux-gnu};;
    *)
      echo "[build] 不支持的宿主: $OS-$ARCH（请显式设置 PI_BRIDGE_TARGET + PI_BRIDGE_TRIPLE）" >&2
      exit 1 ;;
  esac
fi

# windows 产物带 .exe 后缀
case "$TRIPLE" in
  *-pc-windows-*) EXE=".exe" ;;
  *)              EXE="" ;;
esac

echo "[build] target=$TARGET triple=$TRIPLE"

# ---- 安装依赖（已装则秒过）----
cd "$ROOT"
echo "[build] bun install"
bun install

# ---- 编译为单二进制 ----
# 注意：不要加 --bytecode，与 pi-bridge.ts 顶层 await 不兼容
echo "[build] bun build --compile"
mkdir -p "$DIST"
bun build --compile --minify --sourcemap --target="$TARGET" \
  ./pi-bridge.ts --outfile "$DIST/pi-bridge$EXE"

# ---- 按 rust triple 重命名（Tauri externalBin 的命名约定）----
DEST="$DIST/pi-bridge-$TRIPLE$EXE"
if [ "$EXE" = ".exe" ]; then
  mv -f "$DIST/pi-bridge$EXE" "$DEST"
else
  mv -f "$DIST/pi-bridge" "$DEST"
fi
echo "[build] -> $DEST ($(du -h "$DEST" | cut -f1))"

# ---- macOS ad-hoc 签名 + JIT entitlements ----
# bun 用 JavaScriptCore 需 JIT：开了 hardenedRuntime 的宿主 app 若不签名，
# 子进程会被内核直接 kill。
if [[ "$TRIPLE" == *apple* ]]; then
  if [ -f "$ENTITLEMENTS" ]; then
    echo "[build] codesign (ad-hoc + JIT entitlements)"
    if ! codesign --force --sign - --entitlements "$ENTITLEMENTS" "$DEST"; then
      rm -f "$DEST"
      echo "[build] codesign 失败，已清理未签名二进制" >&2
      exit 1
    fi
    # 注意：不要用 `codesign -dv | grep -q`——grep -q 命中后关管道，
    # codesign 收 SIGPIPE(141)，配合 pipefail 会误判失败。改捕获后字串匹配。
    SIG_INFO="$(codesign -dv "$DEST" 2>&1 || true)"
    if [[ "$SIG_INFO" == *"Signature=adhoc"* ]]; then
      echo "[build] 签名验证通过 (adhoc)"
    else
      rm -f "$DEST"
      echo "[build] 签名验证失败" >&2
      printf '%s\n' "$SIG_INFO" >&2
      exit 1
    fi
  else
    rm -f "$DEST"
    echo "[build] 缺少 $ENTITLEMENTS，无法签名（拒绝生成未签名二进制）" >&2
    exit 1
  fi
fi

echo "[build] 完成"
