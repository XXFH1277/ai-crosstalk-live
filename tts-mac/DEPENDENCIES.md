# Mac 部署包的依赖与来源

本包面向 Apple Silicon（arm64），目标为 M1 Max、64 GB 内存的 Mac。模型、网页和声音资源已随包提供；首次部署在目标 Mac 上编译本地后端。本包未在 Mac 真机执行，不能把 Windows 上的静态检查当作 Mac 运行验收。

## 包内离线工具

| 组件 | 固定版本 | 包内文件 | 解包后入口 |
| --- | --- | --- | --- |
| CPython，Astral python-build-standalone 官方构建 | 3.12.15+20261021，aarch64-apple-darwin install_only | `installers/python-aarch64-apple-darwin-install_only.tar.gz` | `runtime/python/bin/python3` |
| Kitware CMake 官方 macOS Universal 构建 | 3.31.8，arm64 + x86_64 | `installers/cmake-macos-universal.tar.gz` | `runtime/cmake/CMake.app/Contents/bin/cmake` |

两个原始 tar.gz 保持不变。部署时使用 macOS 自带的 tar 在本机解包，保留 Python 和 CMake 的符号链接、文件权限与库布局；没有在 Windows 上重打包这些二进制。两者都去掉归档顶层目录（`--strip-components=1`）。

Python 的归档顶层是 `python`。CMake 的归档顶层是 `cmake-3.31.8-macos-universal`。Python 和 CMake 的 arm64 可执行文件头均声明最低 macOS 11.0，但这只描述这两个工具的二进制要求，不代表整个 Breeze 后端已在所有 macOS 版本验证。

Python 与 CMake 的实测 SHA256 均与发布方 GitHub Release asset digest 一致。所有下载地址、大小、哈希、解压目录和入口记录在 `installers/dependencies.json`；便于系统自带 `shasum` 使用的校验清单为 `installers/bootstrap.sha256`。

- Python 官方构建发布页：<https://github.com/astral-sh/python-build-standalone/releases/tag/20261021>
- CMake 官方发布页：<https://github.com/Kitware/CMake/releases/tag/v3.31.8>
- Python 许可副本：`installers/licenses/Python-LICENSE.txt`；原始归档内保留标准库、pip 及其第三方许可。
- CMake 许可副本：`installers/licenses/CMake-Copyright.txt`；原始 CMake.app 内保留 CMake、GUI 与第三方组件的许可及声明。

不需要 Homebrew、系统 Python、pip 安装步骤、CUDA、NVIDIA 驱动或联网下载模型。

## 固定源码

| 源码 | 固定提交 | 包内归档 | 编译目录 |
| --- | --- | --- | --- |
| HoppouAI/Breeze-TTS-2.cpp v0.1.3 | `2904b9ad126c07363e8a6c9afa08f73e3309075b` | `installers/breeze-source-v0.1.3.tar.gz` | `source/Breeze-TTS-2.cpp` |
| ggml-org/ggml | `36da57138425487184aa1da2eee2cde155909c6f` | `installers/ggml-source-36da571.tar.gz` | `source/Breeze-TTS-2.cpp/third_party/ggml` |
| toots/shine | `ab5e3526b64af1a2eaa43aa6f441a7312e013519` | `installers/shine-source-ab5e352.tar.gz` | `source/Breeze-TTS-2.cpp/third_party/shine` |

ggml 与 shine 的提交严格对应 Breeze v0.1.3 的 Git 子模块锁定记录。三个归档来自对应仓库的官方 GitHub codeload，按完整提交号获取；源码归档哈希为本地计算值，未将它描述为发布方另行签署的校验值。各源码的 LICENSE/COPYING 文件随归档和解出的源码保留。

首次部署先校验归档，再用 `--strip-components=1` 解到表中的目标目录，按 Breeze → ggml → shine 的顺序恢复原始源码。这个步骤保留五个文档/JS 测试用符号链接，清单见 `source/source-links.json`；其中上游已有悬空的 JS 测试链接，与本包 C++ 编译无关。普通源码文件在 Windows 中已解出便于审查，源归档用于在 Mac 上准确恢复完整目录和 Unix 元数据。没有包含 `.git` 数据，也不需要在目标 Mac 执行 git clone。

## 需要由 Apple 安装的组件

**Apple Xcode Command Line Tools 和 macOS SDK 不随通用部署包重新分发。** 没有安装时，需要在目标 Mac 使用 Apple 提供的安装流程；这一步可能需要网络、管理员授权和 Apple 的许可确认。完整 Xcode 也可以提供编译器与 SDK。

部署脚本会检查 `xcode-select` 与 `xcrun`，缺少工具时提供说明。Apple 工具就绪后，模型、Python、CMake、Breeze/ggml/shine 源码都已在包内，无需另外下载。Metal 编译和可用性由目标机 SDK、系统和实际推理测试共同确认。

## 已做与未做的验证

已验证：五个归档均可读取，SHA256 正确；归档内没有逃逸顶层目录的路径或链接；Python 为 Mach-O arm64，CMake 为包含 arm64 的 Universal Mach-O；所有固定源码归档和子模块提交均已保存。

尚需目标 Mac 验证：Apple 签名/Gatekeeper 判定、工具启动、ARM64/Metal 编译、真实中文音频生成、F16/Q8 双向切换、已保存 `.breeze` 声音兼容性及性能。不要关闭系统安全保护来代替错误诊断；保留安装和构建日志交回排查。

机器可读检查结果见 `installers/archive-audit.json`。
